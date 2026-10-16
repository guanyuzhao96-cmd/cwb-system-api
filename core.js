import { PROFILE_RULES, sanitizeProfileContent, hasProfileFacts } from './profile-utils.mjs';
import { MODULE_LABELS, moduleStatus, displayRanges, pendingBatches } from './module-progress.mjs';
import { COMBINED_OUTPUT_PROTOCOL, parseCombinedParts } from './combined-response.mjs';
import { RELATIONSHIP_PROMPT, mergeRelationships } from './relationship-utils.mjs';
import { DEFAULT_TIMELINE_INCREMENTAL_PROMPT } from './defaults.js';
import { getContext } from '/scripts/extensions.js';
import { callSystemApi } from './api.js';
import { state } from './state.js';
import {
    getLastUpdatedFloor,
    getModuleProgress,
    recordModuleResult,
    verifyProfileContent,
    getRelationshipSummary,
    getRelationshipRanges,
    saveRelationshipSummary,
    getChatUpdateTracking,
    getTimelineEntries,
    getTargetWorldbook,
    getTriggeredOldProfiles,
    listWorldbooks,
    manageChatEntries,
    saveCharacterDescription,
    recordChatUpdateRange,
    saveTimeline,
    saveUserDescription,
    updateMasterDirectory,
    updateRoster,
} from './lorebook.js';
import { extractCharacterBlocks, notify, parseCustomFormat } from './utils.js';
import { formatRanges, overlappingRanges, missingRanges } from './update-tracker.mjs';

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

export async function refreshModuleProgress() {
    refreshChatState();
    const progress = await getModuleProgress();
    for (const module of Object.keys(MODULE_LABELS)) {
        const status = moduleStatus(progress, module, state.messages.length);
        const missingCount = status.missing.reduce((count, [start, end]) => count + end - start + 1, 0);
        $(`#cwb-through-${module}`).text(`${status.through} 楼`);
        $(`#cwb-gap-${module}`).text(missingCount ? `${missingCount} 楼待补` : '已全部完成');
        $(`[data-cwb-progress="${module}"]`).attr('data-pending', String(missingCount > 0));
        $(`#cwb-progress-${module}`).text(`${MODULE_LABELS[module]}：连续成功至第 ${status.through} 楼\n已成功：${displayRanges(status.completed)}\n未确认/待补：${displayRanges(status.missing)}\n已知失败：${displayRanges(status.failed)}${status.latest?.error ? `\n最近错误：${status.latest.error}` : ''}`);
    }
    return progress;
}

export async function retryMissingModule(settings, module) {
    if (!MODULE_LABELS[module]) throw Error('未知模块。');
    if (state.updating || state.batchRunning || state.repairing) throw Error('已有更新或补漏任务正在运行。');
    state.repairing = true;
    try {
        const progress = await refreshModuleProgress();
        const gaps = moduleStatus(progress, module, state.messages.length).missing;
        const size = Math.max(1, Number(settings.threshold) || 20);
        for (const [start, end] of gaps) {
            for (let current = start; current <= end; current += size) {
                await updateRange(settings, current, Math.min(end, current + size - 1), { modules: [module], silent: true });
            }
        }
        if (!gaps.length) setStatus(`${MODULE_LABELS[module]}没有待补范围。`);
    } finally { state.repairing = false; }
}

export async function updateRange(settings, startIndex, endIndex, { silent = false, modules = Object.keys(MODULE_LABELS) } = {}) {
    if (state.updating || state.timelineUpdating || state.relationshipUpdating) throw new Error('已有更新任务正在运行。');
    refreshChatState();
    const start = Math.max(0, Number(startIndex) || 0);
    const end = Math.min(state.messages.length - 1, Number(endIndex));
    if (end < start || !state.messages.length) throw new Error('指定范围内没有聊天内容。');
    const targets = [...new Set(modules)].filter(module => MODULE_LABELS[module]);
    if (!targets.length) throw Error('未选择更新模块。');
    const chatId = state.chatId;
    state.updating = true;
    const names = [], failures = [], successes = [];
    try {
        await getModuleProgress(); // Fail before spending tokens if reliable progress cannot be read.
        const selected = state.messages.slice(start, end + 1);
        const oldProfiles = targets.includes('profiles') ? (await getTriggeredOldProfiles(settings, selected)).map(sanitizeProfileContent).filter(Boolean) : [];
        const oldTimeline = targets.includes('timeline') ? (await getTimelineEntries()).map(entry => entry.content).join('\n') : '';
        const oldRelationships = targets.includes('relationships') ? await getRelationshipSummary() : '';
        const messages = [];
        if (settings.breakPrompt?.trim()) messages.push({ role: 'system', content: settings.breakPrompt.trim() });
        if (targets.includes('profiles')) messages.push({ role: 'system', content: settings.incremental ? settings.incrementalPrompt : settings.fullPrompt });
        if (targets.includes('timeline')) messages.push({ role: 'system', content: settings.timelineIncrementalPrompt?.trim() || DEFAULT_TIMELINE_INCREMENTAL_PROMPT });
        if (targets.includes('relationships')) messages.push({ role: 'system', content: RELATIONSHIP_PROMPT });
        if (targets.includes('profiles')) messages.push({ role: 'system', content: PROFILE_RULES });
        messages.push({ role: 'system', content: COMBINED_OUTPUT_PROTOCOL + `\n本次仅实际处理：${targets.map(module => MODULE_LABELS[module]).join('、')}。未选择部分可用无变化标记/空数组，插件不会写入其内容或进度。` });
        messages.push({ role: 'user', content: `【当前用户主角姓名】${getContext()?.name1 || '用户'}\n【旧角色档案】\n${oldProfiles.join('\n') || '无'}\n【已有时间线】\n${oldTimeline || '无'}\n【已有关系】\n${oldRelationships || '无'}\n【本轮新增聊天：第 ${start + 1}-${end + 1} 楼】\n${formatMessages(selected)}` });
        setStatus(`正在统一更新第 ${start + 1}-${end + 1} 楼：本批仅调用 AI 1 次…`);
        let response;
        try { response = await callSystemApi(messages, settings.responseLength); }
        catch (error) {
            if (state.chatId === chatId) for (const module of targets) await recordModuleResult(module, start, end, error.message);
            throw error;
        }
        if (state.chatId !== chatId || (getContext()?.chatId && getContext().chatId !== chatId)) throw Error('生成期间切换了聊天，本次未写入，请回到原聊天后重试。');
        const parts = parseCombinedParts(response);
        $('#cwb-timeline-debug').text(`统一更新：AI 1 次，第 ${start + 1}-${end + 1} 楼\n${response}`);
        for (const module of targets) {
            try {
                const part = parts[module];
                if (part.error) throw Error(part.error);
                if (module === 'profiles') {
                    const prepared = part.value.map(block => {
                        const parsed = parseCustomFormat(block);
                        const type = String(parsed?.档案类型 || parsed?.record_type || '').toUpperCase();
                        const name = characterNameFromBlock(block);
                        if (!name || ['时间线', 'TIMELINE'].includes(type)) throw Error('角色档案姓名或档案类型不合法');
                        const cleaned = sanitizeProfileContent(block);
                        if (!cleaned || !hasProfileFacts(cleaned)) return null;
                        return { block: cleaned, name, isUser: type === '主角' || type === 'USER' || name === (getContext()?.name1 || '用户') };
                    }).filter(Boolean);
                    let userUpdated = false;
                    for (const { block, name, isUser } of prepared) {
                        const saved = isUser ? await saveUserDescription(settings, name, block, start, end) : await saveCharacterDescription(settings, name, block, start, end);
                        if (!saved) throw Error(`角色 ${name} 未路由到世界书，档案未全部完成`);
                        await verifyProfileContent(settings, name, block, isUser);
                        if (isUser) userUpdated = true; else names.push(saved);
                    }
                    if (names.length) await updateRoster(settings, [...new Set(names)], start, end);
                    else if (userUpdated && settings.multiWorldbookRouting) await updateMasterDirectory(settings);
                } else if (module === 'timeline') {
                    const events = parseTimelineResponse(JSON.stringify(part.value));
                    const known = new Set(oldTimeline.split(/\r?\n/).map(line => line.replace(/^\s*\[时间线(?:\.\d+)?\]\s*[:：]\s*/, '').trim()));
                    const unique = [...new Set(events)].filter(event => !known.has(event));
                    await saveTimeline(settings, unique.map((event, index) => `[时间线.${index}]: ${event}`).join('\n'), start, end);
                } else {
                    const content = mergeRelationships(oldRelationships, JSON.stringify(part.value));
                    await saveRelationshipSummary(content, start, end);
                    $('#cwb-relationship-status').text(content);
                }
                await recordModuleResult(module, start, end);
                successes.push(MODULE_LABELS[module]);
            } catch (error) {
                failures.push(`${MODULE_LABELS[module]}：${error.message}`);
                try { await recordModuleResult(module, start, end, error.message); }
                catch (progressError) { failures.push(`进度未确认：${progressError.message}`); }
            }
        }
        if (!failures.length && targets.length === 3) {
            await recordChatUpdateRange(start, end, state.messages.length, '三个模块均成功，AI调用1次', 0);
        }
        const message = `第 ${start + 1}-${end + 1} 楼，AI 1 次；成功：${successes.join('、') || '无'}${failures.length ? `；待手动补漏：${failures.join('；')}` : ''}`;
        setStatus(message);
        if (failures.length) throw Error(message);
        if (!silent) notify('success', message);
        return [...new Set(names)];
    } finally {
        state.updating = false;
        if (state.chatId === chatId) await refreshModuleProgress().catch(error => $('#cwb-progress-error').text(`进度读取失败：${error.message}`));
    }
}

export async function updateRecent(settings) {
    refreshChatState();
    const depth = Math.max(1, Number(settings.scanDepth) || 6);
    return updateRange(settings, Math.max(0, state.messages.length - depth), state.messages.length - 1);
}

function timelineRanges(entry) {
    return (entry.keys ?? []).flatMap(key => {
        const match = String(key).match(/^CWB:时间线楼层:(\d+)-(\d+)$/) || String(key).match(/^(\d+)-(\d+)$/);
        return match ? [[Number(match[1]), Number(match[2])]] : [];
    });
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

export async function refreshTimeline(settings, onProgress = () => {}, endIndex = Number.MAX_SAFE_INTEGER, retryStartIndex = null) {
    if (state.timelineUpdating || state.updating || state.batchRunning || state.repairing) throw new Error('已有更新任务正在运行。');
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
            for (const range of timelineRanges(entry)) {
            const start = Math.max(1, range[0]);
            const end = Math.min(total, range[1]);
            for (let floor = start; floor <= end; floor++) covered[floor] = true;
            }
        }
        // Explicit character updates must check their selected range again, even if
        // a previous request marked it covered but returned no events (or was swiped).
        // Standalone refresh retries the latest batch, while still filling older gaps.
        const retryFloor = retryStartIndex === null
            ? Math.max(1, scanEndFloor - (Math.max(1, Number(settings.threshold) || 20)) + 1)
            : Math.max(1, Number(retryStartIndex) + 1);
        for (let current = retryFloor; current <= scanEndFloor; current++) covered[current] = false;
        let previous = existing.map(entry => entry.content).join('\n\n');
        const chunkSize = Math.max(1, Number(settings.threshold) || 20);
        const addedRanges = [];
        const diagnostics = [];
        const showDiagnostics = () => $('#cwb-timeline-debug').text(diagnostics.join('\n\n'));
        diagnostics.push(`时间线增量 v0.9.5｜聊天：${state.chatId}｜目标楼层：1-${scanEndFloor}`);
        showDiagnostics();
        let addedEvents = 0;
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
                diagnostics.push(`请求第 ${range} 楼，${selected.length} 条聊天；提示词：${settings.timelineIncrementalPrompt?.trim() ? '自定义' : '内置'}`);
                showDiagnostics();
                const response = await callSystemApi([
                    { role: 'system', content: settings.timelineIncrementalPrompt?.trim() || DEFAULT_TIMELINE_INCREMENTAL_PROMPT },
                    { role: 'user', content: `【已有时间线】\n${previous || '无'}\n\n【本次新增聊天：第 ${range} 楼】\n${formatMessages(selected)}\n\n请提取本次新增聊天中的新事件；不要将已有记录当成本次输出。` },
                ], settings.responseLength);
                diagnostics.push(`API 原始返回（第 ${range} 楼）：\n${response}`);
                showDiagnostics();
                const events = parseTimelineResponse(response);
                const known = new Set(previous.split(/\r?\n/).map(line => line.replace(/^\s*\[时间线(?:\.\d+)?\]\s*[:：]\s*/, '').trim()).filter(Boolean));
                const unique = [...new Set(events)].filter(event => !known.has(event));
                const content = `【时间线楼层：${range}】\n${unique.length ? unique.map((event, index) => `[时间线.${index}]: ${event}`).join('\n') : '（本范围已检查，无新增重要事件）'}`;
                const savedEntries = await saveTimeline(settings, content, startFloor - 1, endFloor - 1);
                diagnostics.push(`保存成功：解析 ${events.length} 条，去重后新增 ${unique.length} 条；UID ${savedEntries?.[0]?.uid ?? '未知'}。`);
                showDiagnostics();
                await recordModuleResult('timeline', startFloor - 1, endFloor - 1);
                addedEvents += unique.length;
                previous = `${previous}${previous ? '\n\n' : ''}【楼层${range}】\n${content}`;
                addedRanges.push(range);
                for (let current = startFloor; current <= endFloor; current++) covered[current] = true;
            }
        }
        const coveredCount = covered.slice(scanStartFloor, scanEndFloor + 1).filter(Boolean).length;
        const result = { addedRanges, addedEvents, coveredCount, totalFloors: scanEndFloor - scanStartFloor + 1 };
        setStatus(addedRanges.length
            ? `时间线已补齐：${addedRanges.map(range => `第 ${range} 楼`).join('、')}；新增 ${addedEvents} 条事件；已覆盖 ${coveredCount}/${scanEndFloor} 楼。`
            : `时间线无需重复更新：已覆盖当前聊天全部 ${total} 楼。`);
        return result;
    } finally {
        state.timelineUpdating = false;
    }
}

export async function maybeAutoUpdate(settings) {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(async () => {
        if (!settings.enabled || !settings.autoUpdate || state.updating || state.batchRunning || state.repairing) return;
        try {
            refreshChatState();
            const progress = await getModuleProgress();
            const threshold = Math.max(1, Number(settings.threshold) || 20);
            const latestAttempt = Math.max(0, ...Object.values(progress).flatMap(item => [item.latest?.end !== undefined ? item.latest.end + 1 : 0, ...(item.completed ?? []).map(([, end]) => end + 1)]));
            const pending = state.messages.length - latestAttempt;
            setStatus(`总层数 ${state.messages.length}；新增待处理 ${Math.max(0, pending)}；缺口可手动补漏。`);
            if (pending >= threshold) await batchUpdate(settings);
        } catch (error) {
            console.error('[CWB] 自动更新失败', error);
            notify('error', `自动更新失败：${error.message}`);
            setStatus(`自动更新失败：${error.message}`);
        }
    }, 1200);
}

export async function batchUpdate(settings, onProgress) {
    if (state.batchRunning) { state.batchStopRequested = true; return; }
    if (state.updating || state.repairing || state.timelineUpdating || state.relationshipUpdating) throw Error('已有更新任务正在运行。');
    refreshChatState();
    if (!state.messages.length) throw new Error('当前聊天为空。');
    state.batchRunning = true;
    state.batchStopRequested = false;
    try {
        const progress = await refreshModuleProgress();
        const plan = pendingBatches(progress, state.messages.length, Math.max(1, Number(settings.threshold) || 20));
        if (!plan.length) { setStatus('三项均已覆盖全部聊天，无需重复更新，AI 调用 0 次。'); return; }
        for (let index = 0; index < plan.length; index++) {
            if (state.batchStopRequested) break;
            const batch = plan[index];
            onProgress?.(index + 1, plan.length);
            await updateRange(settings, batch.start, batch.end, { silent: true, modules: batch.modules });
        }
        if (!state.batchStopRequested) notify('success', '批量补齐完成，已完成内容没有重复生成。');
    } finally {
        state.batchRunning = false;
        state.batchStopRequested = false;
        onProgress?.(0, 0);
    }
}

export async function onChatChanged(settings) {
    refreshChatState();
    if (!settings.enabled) return;
    await manageChatEntries(settings);
    if (settings.multiWorldbookRouting) await updateMasterDirectory(settings);
    const progress = await refreshModuleProgress();
    setStatus(`总层数 ${state.messages.length}；${Object.keys(MODULE_LABELS).map(module => `${MODULE_LABELS[module]}连续完成至${moduleStatus(progress, module, state.messages.length).through}楼`).join('；')}。`);
}


export async function updateRelationships(settings, startIndex = null, endIndex = null) {
    if (state.relationshipUpdating || state.updating || state.batchRunning || state.repairing) throw new Error('已有更新任务正在运行。');
    refreshChatState();
    const end = Math.min(state.messages.length - 1, endIndex ?? state.messages.length - 1);
    const start = Math.max(0, startIndex ?? end - (Number(settings.scanDepth) || 6) + 1);
    if (end < start) throw new Error('当前范围没有聊天内容。');
    state.relationshipUpdating = true;
    try {
        let content = await getRelationshipSummary();
        const completed = await getRelationshipRanges();
        // Standalone updates process every unhandled gap, rather than only the last six messages.
        const ranges = startIndex === null ? missingRanges(end + 1, completed) : [[start, end]];
        if (!ranges.length) ranges.push([start, end]); // Explicit retry can recover an earlier empty result.
        const size = Math.max(1, Number(settings.threshold) || 20);
        const checked = [];
        for (const [rangeStart, rangeEnd] of ranges) {
            for (let chunkStart = rangeStart; chunkStart <= rangeEnd; chunkStart += size) {
                const chunkEnd = Math.min(rangeEnd, chunkStart + size - 1);
                $('#cwb-relationship-status').text(`正在增量更新角色关系：第 ${chunkStart + 1}-${chunkEnd + 1} 楼…`);
                const response = await callSystemApi([
                    { role: 'system', content: RELATIONSHIP_PROMPT },
                    { role: 'user', content: `【已有关系】\n${content || '无'}\n\n【新增聊天：第 ${chunkStart + 1}-${chunkEnd + 1} 楼】\n${formatMessages(state.messages.slice(chunkStart, chunkEnd + 1))}` },
                ], settings.responseLength);
                const merged = mergeRelationships(content, response);
                // Advance coverage only after successful parsing, persistence, and server readback.
                await saveRelationshipSummary(merged, chunkStart, chunkEnd);
                await recordModuleResult('relationships', chunkStart, chunkEnd);
                content = merged;
                checked.push(`${chunkStart + 1}-${chunkEnd + 1}`);
            }
        }
        $('#cwb-relationship-status').text(`角色关系增量已保存：第 ${checked.join('、')} 楼。\n${content}`);
        return content;
    } catch (error) {
        $('#cwb-relationship-status').text(`角色关系更新失败：${error.message}`);
        throw error;
    } finally { state.relationshipUpdating = false; }
}
