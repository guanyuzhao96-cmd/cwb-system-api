import { getContext } from '/scripts/extensions.js';
import { callSystemApi } from './api.js';
import { state } from './state.js';
import {
    getLastUpdatedFloor,
    getTimelineEntries,
    getTargetWorldbook,
    getTriggeredOldProfiles,
    listWorldbooks,
    manageChatEntries,
    saveCharacterDescription,
    saveTimeline,
    saveUserDescription,
    updateMasterDirectory,
    updateRoster,
} from './lorebook.js';
import { extractCharacterBlocks, notify, parseCustomFormat } from './utils.js';

let autoTimer = null;

export function refreshChatState() {
    const context = getContext();
    state.chatId = context?.chatId || context?.chat_filename?.replace(/\.jsonl?$/i, '') || 'unknown_chat';
    state.messages = (context?.chat ?? []).map((message, index) => ({
        ...message,
        id: index,
        message: message.mes ?? '',
    }));
    return state.messages;
}

function formatMessages(messages) {
    const context = getContext();
    return messages.map(message => {
        const speaker = message.is_user ? (context?.name1 || '用户') : (message.name || context?.name2 || '角色');
        return `【${speaker}】：\n${String(message.message ?? '').trim()}`;
    }).filter(text => text.trim()).join('\n\n');
}

function characterNameFromBlock(block) {
    const parsed = parseCustomFormat(block);
    return parsed?.姓名?.trim()
        || parsed?.name?.trim()
        || parsed?.CI?.name?.trim()
        || parsed?.core_identity?.name?.trim()
        || null;
}

function setStatus(text) {
    $('#cwb-status').text(text);
}

export async function updateRange(settings, startIndex, endIndex, { silent = false } = {}) {
    if (state.updating) throw new Error('已有角色档案更新任务正在运行。');
    refreshChatState();
    const boundedStart = Math.max(0, Number(startIndex) || 0);
    const boundedEnd = Math.min(state.messages.length - 1, Number(endIndex));
    if (boundedEnd < boundedStart || !state.messages.length) throw new Error('指定范围内没有聊天内容。');
    if (!getTargetWorldbook(settings) && !(settings.multiWorldbookRouting && listWorldbooks().length)) {
        throw new Error('当前角色未绑定主世界书，请先绑定或选择指定世界书。');
    }

    state.updating = true;
    setStatus(`正在读取第 ${boundedStart + 1}-${boundedEnd + 1} 层…`);
    try {
        const selected = state.messages.slice(boundedStart, boundedEnd + 1);
        const oldProfiles = await getTriggeredOldProfiles(settings, selected);
        const messages = [
            { role: 'system', content: `CWB request seed: ${globalThis.crypto?.randomUUID?.() ?? Math.random()}` },
        ];
        if (settings.breakPrompt?.trim()) messages.push({ role: 'system', content: settings.breakPrompt.trim() });
        messages.push({
            role: 'system',
            content: settings.incremental ? settings.incrementalPrompt : settings.fullPrompt,
        });
        messages.push({
            role: 'system',
            content: '本次任务只输出角色/主角档案，不要输出故事时间线。插件会在角色档案保存后，使用独立请求补齐至本次更新结束楼层为止的所有未处理时间线楼层。',
        });
        if (settings.incremental) {
            messages.push({
                role: 'user',
                content: `【旧档案】\n${oldProfiles.length ? oldProfiles.join('\n') : '无'}`,
            });
        }
        messages.push({
            role: 'user',
            content: `【当前用户主角姓名】${getContext()?.name1 || '用户'}\n\n${settings.incremental ? '【新对话】' : '最近的聊天记录摘要：'}\n${formatMessages(selected) || '(无有效对话内容)'}`,
        });

        setStatus('正在调用酒馆系统 API…');
        const response = await callSystemApi(messages, settings.responseLength);
        const blocks = extractCharacterBlocks(response);
        if (!blocks.length) throw new Error('模型回复中没有合法的角色档案块。');

        const names = [];
        const skippedNames = [];
        let userUpdated = false;
        const currentUserName = getContext()?.name1 || '用户';
        for (const block of blocks) {
            const parsed = parseCustomFormat(block);
            const recordType = String(parsed?.档案类型 || parsed?.record_type || '').toUpperCase();
            if (recordType === '时间线' || recordType === 'TIMELINE') {
                continue;
            }
            const name = characterNameFromBlock(block);
            if (!name) continue;
            if (recordType === '主角' || recordType === 'USER' || name === currentUserName) {
                await saveUserDescription(settings, currentUserName, block, boundedStart, boundedEnd);
                userUpdated = true;
                continue;
            }
            const savedName = await saveCharacterDescription(settings, name, block, boundedStart, boundedEnd);
            if (savedName) names.push(savedName);
            else skippedNames.push(name);
        }
        let timelineResult = null;
        let timelineError = null;
        try {
            timelineResult = await refreshTimeline(settings, text => setStatus(text), boundedEnd);
        } catch (error) {
            timelineError = error;
            console.error('[CWB] 时间线同步刷新失败', error);
        }
        const uniqueNames = [...new Set(names)];
        if (!uniqueNames.length && !userUpdated) {
            const skipped = [...new Set(skippedNames)];
            const roleMessage = skipped.length
                ? `未更新：${skipped.join('、')} 未列入任何世界书目录。`
                : '模型生成了内容，但没有识别出角色或主角档案。';
            const timelineMessage = timelineError ? `时间线同步失败：${timelineError.message}` : timelineResult?.addedRanges.length ? `时间线已补齐第 ${timelineResult.addedRanges.join('、')} 楼。` : '时间线楼层已覆盖，无需重复更新。';
            const message = `${roleMessage} ${timelineMessage}`;
            setStatus(message);
            if (!silent) notify('warning', message);
            return [];
        }
        if (uniqueNames.length) await updateRoster(settings, uniqueNames, boundedStart, boundedEnd);
        else if (userUpdated && settings.multiWorldbookRouting) await updateMasterDirectory(settings);
        const skipped = [...new Set(skippedNames)];
        const skippedSuffix = skipped.length ? `；跳过未列目录角色：${skipped.join('、')}` : '';
        const timelineSuffix = timelineError
            ? `；时间线同步失败：${timelineError.message}`
            : timelineResult?.addedRanges.length
                ? `；时间线已补齐第 ${timelineResult.addedRanges.join('、')} 楼`
                : '；时间线楼层已覆盖，无需重复更新';
        setStatus(`完成：第 ${boundedStart + 1}-${boundedEnd + 1} 层，更新 ${uniqueNames.length} 个角色${userUpdated ? '及主角档案' : ''}${skippedSuffix}${timelineSuffix}。`);
        if (!silent) notify(timelineError ? 'warning' : 'success', `已更新 ${uniqueNames.length} 个角色档案${userUpdated ? '及主角档案' : ''}${skippedSuffix}${timelineSuffix}。`);
        return uniqueNames;
    } finally {
        state.updating = false;
    }
}

export async function updateRecent(settings) {
    refreshChatState();
    const depth = Math.max(1, Number(settings.scanDepth) || 6);
    return updateRange(settings, Math.max(0, state.messages.length - depth), state.messages.length - 1);
}

function timelineRange(entry) {
    for (const key of entry.keys ?? []) {
        const match = String(key).match(/^CWB:时间线楼层:(\d+)-(\d+)$/) || String(key).match(/^(\d+)-(\d+)$/);
        if (match) return [Number(match[1]), Number(match[2])];
    }
    return null;
}

function parseTimelineResponse(response) {
    const cleaned = String(response).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch {
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (match) {
            try { parsed = JSON.parse(match[0]); } catch { /* use line fallback below */ }
        }
    }
    const items = Array.isArray(parsed) ? parsed : parsed?.时间线 ?? parsed?.events;
    if (Array.isArray(items)) return items.map(item => {
        if (typeof item === 'string') return item.trim();
        const date = String(item?.日期 ?? item?.date ?? '日期未知').trim();
        const people = String(item?.人物 ?? item?.people ?? '人物未明').trim();
        const event = String(item?.事件 ?? item?.event ?? '').trim();
        return event ? `${date}｜${people}｜${event}` : '';
    }).filter(Boolean);
    const lines = cleaned.split(/\r?\n/).map(line => line.replace(/^\s*(?:[-*•]\s*)?\[?时间线(?:\.\d+)?\]?\s*[:：]\s*/, '').trim()).filter(Boolean);
    const events = lines.filter(line => line.includes('｜') || line.includes('|'));
    if (events.length) return events.map(line => line.replace(/\s*[|｜]\s*/g, '｜'));
    throw new Error(`时间线 API 返回格式无法解析：${cleaned.slice(0, 240)}`);
}

function timelineTag(entry) {
    const range = timelineRange(entry);
    return range ? `楼层${range[0]}-${range[1]}` : '楼层范围未知';
}

export async function refreshTimeline(settings, onProgress = () => {}, endIndex = Number.MAX_SAFE_INTEGER) {
    if (state.timelineUpdating) throw new Error('时间线刷新任务正在运行。');
    refreshChatState();
    if (!state.messages.length) throw new Error('当前聊天为空，无法刷新时间线。');
    const scanStartFloor = 1;
    const scanEndFloor = Math.min(state.messages.length, Number.isFinite(Number(endIndex)) ? Number(endIndex) + 1 : state.messages.length);
    if (scanEndFloor < scanStartFloor) throw new Error('时间线更新范围无效。');
    state.timelineUpdating = true;
    try {
        const existing = await getTimelineEntries();
        const total = state.messages.length;
        const covered = new Array(total + 1).fill(false);
        for (const entry of existing) {
            const range = timelineRange(entry);
            if (!range) continue;
            const start = Math.max(1, range[0]);
            const end = Math.min(total, range[1]);
            for (let floor = start; floor <= end; floor++) covered[floor] = true;
        }
        let previous = existing
            .slice()
            .sort((a, b) => (timelineRange(a)?.[0] ?? 0) - (timelineRange(b)?.[0] ?? 0))
            .map(entry => `【${timelineTag(entry)}】\n${entry.content}`)
            .join('\n\n');
        const chunkSize = Math.max(1, Number(settings.threshold) || 20);
        const addedRanges = [];
        let floor = scanStartFloor;
        while (floor <= scanEndFloor) {
            if (covered[floor]) { floor++; continue; }
            const start = floor;
            while (floor <= scanEndFloor && !covered[floor]) floor++;
            const gapEnd = floor - 1;
            for (let startFloor = start; startFloor <= gapEnd; startFloor += chunkSize) {
                const endFloor = Math.min(gapEnd, startFloor + chunkSize - 1);
                const selected = state.messages.slice(startFloor - 1, endFloor);
                const range = `${startFloor}-${endFloor}`;
                onProgress(`正在刷新故事时间线：第 ${range} 楼…`);
                setStatus(`正在调用系统 API 更新故事时间线（第 ${range} 楼）…`);
                const response = await callSystemApi([
                    { role: 'system', content: '你是聊天故事时间线整理器。只记录聊天中已经发生且对剧情重要的事件，绝不续写或补事实。输出合法 JSON：{"时间线":[{"日期":"YYYY-MM-DD或日期未知","人物":"人物姓名","事件":"精简事件及结果"}]}。覆盖输入的全部聊天楼层，不遗漏关键事件；同一事件只记一次，按真实日期先后排序。时间线只能包含当前输入楼层中发生的事件；如果没有重要事件，输出空数组。' },
                    { role: 'user', content: `整理第 ${range} 楼的故事时间线。旧时间线仅供去重，不要重复输出其中已有事件；不同楼层范围的标签表示已处理范围。\n【已处理时间线】\n${previous || '无'}\n\n【本次聊天内容】\n${formatMessages(selected)}` },
                ], settings.responseLength);
                const events = parseTimelineResponse(response);
                const known = new Set(previous.split(/\r?\n/).map(line => line.replace(/^\s*\[时间线(?:\.\d+)?\]\s*[:：]\s*/, '').trim()).filter(Boolean));
                const unique = [...new Set(events)].filter(event => !known.has(event));
                const content = `【时间线楼层：${range}】\n${unique.length ? unique.map((event, index) => `[时间线.${index}]: ${event}`).join('\n') : '（本范围已检查，无新增重要事件）'}`;
                await saveTimeline(settings, content, startFloor - 1, endFloor - 1);
                previous = `${previous}${previous ? '\n\n' : ''}【楼层${range}】\n${content}`;
                addedRanges.push(range);
                for (let current = startFloor; current <= endFloor; current++) covered[current] = true;
            }
        }
        const coveredCount = covered.slice(scanStartFloor, scanEndFloor + 1).filter(Boolean).length;
        const result = { addedRanges, coveredCount, totalFloors: scanEndFloor - scanStartFloor + 1 };
        setStatus(addedRanges.length
            ? `时间线已补齐：${addedRanges.map(range => `第 ${range} 楼`).join('、')}；已覆盖 ${coveredCount}/${total} 楼。`
            : `时间线无需重复更新：已覆盖当前聊天全部 ${total} 楼。`);
        return result;
    } finally {
        state.timelineUpdating = false;
    }
}

export async function maybeAutoUpdate(settings) {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(async () => {
        if (!settings.enabled || !settings.autoUpdate || state.updating || state.batchRunning) return;
        try {
            refreshChatState();
            const lastFloor = await getLastUpdatedFloor(settings);
            const threshold = Math.max(1, Number(settings.threshold) || 20);
            const pending = state.messages.length - lastFloor;
            setStatus(`总层数 ${state.messages.length}；已更新至 ${lastFloor}；待更新 ${Math.max(0, pending)}。`);
            if (pending >= threshold) {
                notify('info', `检测到 ${pending} 层新内容，开始自动更新。`);
                await updateRange(settings, lastFloor, state.messages.length - 1);
            }
        } catch (error) {
            console.error('[CWB] 自动更新失败', error);
            notify('error', `自动更新失败：${error.message}`);
            setStatus(`自动更新失败：${error.message}`);
        }
    }, 1200);
}

export async function batchUpdate(settings, onProgress) {
    if (state.batchRunning) {
        state.batchStopRequested = true;
        return;
    }
    refreshChatState();
    if (!state.messages.length) throw new Error('当前聊天为空。');
    const size = Math.max(1, Number(settings.threshold) || 20);
    const total = Math.ceil(state.messages.length / size);
    state.batchRunning = true;
    state.batchStopRequested = false;
    try {
        for (let batch = 0; batch < total; batch++) {
            if (state.batchStopRequested) {
                notify('info', `批量更新已在第 ${batch} 批后停止。`);
                break;
            }
            onProgress?.(batch + 1, total);
            let lastError;
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    await updateRange(settings, batch * size, Math.min(state.messages.length - 1, (batch + 1) * size - 1), { silent: true });
                    lastError = null;
                    break;
                } catch (error) {
                    lastError = error;
                    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 1500));
                }
            }
            if (lastError) throw lastError;
        }
        if (!state.batchStopRequested) notify('success', '批量更新全部完成。');
    } finally {
        state.batchRunning = false;
        state.batchStopRequested = false;
        onProgress?.(0, total);
    }
}

export async function onChatChanged(settings) {
    refreshChatState();
    if (!settings.enabled) return;
    await manageChatEntries(settings);
    if (settings.multiWorldbookRouting) await updateMasterDirectory(settings);
    const floor = await getLastUpdatedFloor(settings);
    setStatus(`总层数 ${state.messages.length}；角色世界书已更新至第 ${floor} 层。`);
}
