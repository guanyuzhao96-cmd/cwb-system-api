import { PROFILE_PLOT_COMPACTION_PROMPT, PROFILE_RULES, isExcludedProfileName, reconcileProfileExperienceCount, replaceProfilePlot, sanitizeProfileContent, hasProfileFacts } from './profile-utils.mjs';
import { MODULE_LABELS, moduleStatus, displayRanges, pendingBatches } from './module-progress.mjs';
import { COMBINED_OUTPUT_PROTOCOL, parseCombinedParts } from './combined-response.mjs';
import { RELATIONSHIP_PROMPT, mergeRelationships } from './relationship-utils.mjs';
import { DEFAULT_TIMELINE_INCREMENTAL_PROMPT, TIMELINE_CONCISION_RULES } from './defaults.js';
import { getContext } from '/scripts/extensions.js';
import { callSystemApi } from './api.js';
import { createErrorReport } from './error-report.js';
import { state, acquireOperationLock } from './state.js';
import { parseTimelineRecords, formatTimelineRecords, compactTimelineContext } from './timeline-utils.mjs';
import {
    getLastUpdatedFloor,
    getModuleProgress,
    getProgressRecoveryCandidates,
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
    cleanupProfileFields,
} from './lorebook.js';
import { extractCharacterBlocks, notify, parseCustomFormat } from './utils.js';
import { formatRanges, overlappingRanges, missingRanges } from './update-tracker.mjs';

let autoTimer = null;

export async function compactRoleProfiles(settings, onProgress = () => {}, selection = null) {
    const release = acquireOperationLock(state, '角色档案剧情精简');
    state.repairing = true;
    try {
        refreshChatState();
        return await cleanupProfileFields(settings, {
            selection,
            onProgress,
            transformContent: async (content, meta) => {
                const profile = parseCustomFormat(content);
                const events = Array.isArray(profile['剧情']) ? profile['剧情'].map(String) : profile['剧情'] ? [String(profile['剧情'])] : [];
                if (!events.length) return content;
                const response = await callSystemApi([
                    { role: 'system', content: PROFILE_PLOT_COMPACTION_PROMPT },
                    { role: 'user', content: `角色：${String(profile['姓名'] ?? meta.name ?? '未知角色')}\n现有剧情：\n${JSON.stringify(events)}` },
                ], settings.responseLength);
                const json = response.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '');
                const parsed = JSON.parse(json);
                if (!parsed || !Array.isArray(parsed['剧情']) || parsed['剧情'].some(item => typeof item !== 'string')) throw Error(`角色 ${meta.name} 的精简结果格式无效，原档案未写入。`);
                return replaceProfilePlot(content, parsed['剧情']);
            },
        });
    } finally {
        state.repairing = false;
        release();
    }
}

function currentChatId() {
    const context = getContext();
    return context?.chatId || context?.chat_filename?.replace(/\.jsonl?$/i, '') || state.chatId || 'unknown_chat';
}

function assertCurrentChat(chatId) {
    if (state.chatId !== chatId || currentChatId() !== chatId) throw new Error('生成期间切换了聊天，本次停止写入；请在目标聊天重新更新。');
}

export function refreshChatState() {
    const context = getContext();
    state.chatId = context?.chatId || context?.chat_filename?.replace(/\.jsonl?$/i, '') || state.chatId || 'unknown_chat';
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
    const recoveryCandidates = await getProgressRecoveryCandidates();
    $('#cwb-recover-progress').prop('hidden', recoveryCandidates.length === 0).text(
        recoveryCandidates.length ? `找回其他聊天的进度（${recoveryCandidates.length} 条候选）` : '找回其他聊天的进度',
    );
    $('#cwb-progress-error').text(recoveryCandidates.length
        ? `当前聊天 ID 没有匹配到进度存档；发现 ${recoveryCandidates.length} 条其他聊天存档。请选择正确来源恢复，原存档不会被删除。`
        : '');
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
    if (state.updating || state.batchRunning || state.repairing || state.timelineUpdating || state.relationshipUpdating) throw Error('已有更新或补漏任务正在运行。');
    const release = acquireOperationLock(state, `补漏-${MODULE_LABELS[module]}`);
    state.repairing = true;
    try {
        const progress = await refreshModuleProgress();
        const chatId = state.chatId;
        const gaps = moduleStatus(progress, module, state.messages.length).missing;
        const size = Math.max(1, Number(settings.threshold) || 20);
        for (const [start, end] of gaps) {
            for (let current = start; current <= end; current += size) {
                assertCurrentChat(chatId);
                await updateRangeUnlocked(settings, current, Math.min(end, current + size - 1), { modules: [module], silent: true });
            }
        }
        if (!gaps.length) setStatus(`${MODULE_LABELS[module]}没有待补范围。`);
    } finally { state.repairing = false; release(); }
}

async function updateRangeUnlocked(settings, startIndex, endIndex, { silent = false, modules = Object.keys(MODULE_LABELS) } = {}) {
    refreshChatState();
    const start = Math.max(0, Number(startIndex) || 0);
    const end = Math.min(state.messages.length - 1, Number(endIndex));
    if (end < start || !state.messages.length) throw new Error('指定范围内没有聊天内容。');
    const targets = [...new Set(modules)].filter(module => MODULE_LABELS[module]);
    if (!targets.length) throw Error('未选择更新模块。');
    const chatId = state.chatId;
    state.updating = true;
    const names = [], failures = [], successes = [], savedProfiles = [];
    try {
        await getModuleProgress(); // Fail before spending tokens if reliable progress cannot be read.
        const selected = state.messages.slice(start, end + 1);
        const oldProfiles = targets.includes('profiles') ? await getTriggeredOldProfiles(settings, selected) : [];
        const oldTimeline = targets.includes('timeline') ? (await getTimelineEntries()).map(entry => entry.content).join('\n') : '';
        const oldRelationships = targets.includes('relationships') ? await getRelationshipSummary() : '';
        assertCurrentChat(chatId);
        const messages = [];
        if (settings.breakPrompt?.trim()) messages.push({ role: 'system', content: settings.breakPrompt.trim() });
        if (targets.includes('profiles')) messages.push({ role: 'system', content: settings.incremental ? settings.incrementalPrompt : settings.fullPrompt });
        if (targets.includes('timeline')) messages.push({ role: 'system', content: settings.timelineIncrementalPrompt?.trim() || DEFAULT_TIMELINE_INCREMENTAL_PROMPT });
        if (targets.includes('relationships')) messages.push({ role: 'system', content: RELATIONSHIP_PROMPT });
        if (targets.includes('profiles')) messages.push({ role: 'system', content: PROFILE_RULES });
        messages.push({ role: 'system', content: COMBINED_OUTPUT_PROTOCOL + `\n本次仅实际处理：${targets.map(module => MODULE_LABELS[module]).join('、')}。未选择部分可用无变化标记/空数组，插件不会写入其内容或进度。` });
        messages.push({ role: 'user', content: `【当前用户主角姓名】${getContext()?.name1 || '用户'}\n【旧角色档案】\n${oldProfiles.join('\n') || '无'}\n【已有时间线（节选）】\n${targets.includes('timeline') ? compactTimelineContext(oldTimeline) : '无'}\n【已有关系】\n${oldRelationships || '无'}\n【本轮新增聊天：第 ${start + 1}-${end + 1} 楼】\n${formatMessages(selected)}` });
        const requestChars = messages.reduce((total, message) => total + String(message.content ?? '').length, 0);
        setStatus(`正在统一更新第 ${start + 1}-${end + 1} 楼：AI 请求中，输入约 ${requestChars} 字符…`);
        let response;
        const requestStartedAt = Date.now();
        try { response = await callSystemApi(messages, settings.responseLength); }
        catch (error) {
            const progressErrors = [];
            if (state.chatId === chatId) {
                for (const module of targets) {
                    try { await recordModuleResult(module, start, end, error.message); }
                    catch (progressError) { progressErrors.push(`${MODULE_LABELS[module]}失败进度未保存：${progressError.message}`); }
                }
            }
            const message = `第 ${start + 1}-${end + 1} 楼 AI 请求失败（输入约 ${requestChars} 字符）：${error.message}${progressErrors.length ? `；${progressErrors.join('；')}` : ''}`;
            setStatus(message);
            const reportedError = new Error(message, { cause: error });
            reportedError.cwbDiagnostics = {
                stage: 'SillyTavern generateRaw AI request',
                modules: targets.map(module => MODULE_LABELS[module]),
                startFloor: start + 1,
                endFloor: end + 1,
                batchFloors: end - start + 1,
                totalChatFloors: state.messages.length,
                requestCharacters: requestChars,
                requestDurationMs: Date.now() - requestStartedAt,
            };
            createErrorReport(reportedError, reportedError.cwbDiagnostics);
            reportedError.cwbReportGenerated = true;
            throw reportedError;
        }
        assertCurrentChat(chatId);
        const parts = parseCombinedParts(response);
        $('#cwb-timeline-debug').text(`统一更新：AI 1 次，第 ${start + 1}-${end + 1} 楼\n${response}`);
        for (const module of targets) {
            try {
                assertCurrentChat(chatId);
                const part = parts[module];
                if (part.error) throw Error(part.error);
                if (module === 'profiles') {
                    const prepared = part.value.map(block => {
                        const parsed = parseCustomFormat(block);
                        const type = String(parsed?.档案类型 || parsed?.record_type || '').toUpperCase();
                        const name = characterNameFromBlock(block);
                        if (isExcludedProfileName(name)) return null;
                        if (!name || ['时间线', 'TIMELINE'].includes(type)) throw Error('角色档案姓名或档案类型不合法');
                        const cleaned = reconcileProfileExperienceCount(block, oldProfiles);
                        if (!cleaned || !hasProfileFacts(cleaned)) return null;
                        return { block: cleaned, name, isUser: type === '主角' || type === 'USER' || name === (getContext()?.name1 || '用户') };
                    }).filter(Boolean);
                    let userUpdated = false;
                    for (const { block, name, isUser } of prepared) {
                        assertCurrentChat(chatId);
                        const options = { returnReceipt: true };
                        const saved = isUser ? await saveUserDescription(settings, name, block, start, end, options) : await saveCharacterDescription(settings, name, block, start, end, options);
                        assertCurrentChat(chatId);
                        if (!saved) throw Error(`角色 ${name} 未出现在可用目录中；请在“世界书设置 → 查看已有目录”确认，缺失时先激活目标世界书并扫描生成目录。`);
                        savedProfiles.push({ ...saved, isUser });
                        if (isUser) userUpdated = true; else names.push(saved.name);
                    }
                    if (names.length) { assertCurrentChat(chatId); await updateRoster(settings, [...new Set(names)], start, end); assertCurrentChat(chatId); }
                    else if (userUpdated && settings.multiWorldbookRouting) { assertCurrentChat(chatId); await updateMasterDirectory(settings); assertCurrentChat(chatId); }
                } else if (module === 'timeline') {
                    const events = parseTimelineResponse(JSON.stringify(part.value));
                    const unique = uniqueTimelineEntries(events, oldTimeline);
                    assertCurrentChat(chatId);
                    await saveTimeline(settings, formatTimelineRecords(parseTimelineRecords(unique), { header: '【时间线增量】', empty: '（本范围已检查，无新增重要事件）' }), start, end);
                    assertCurrentChat(chatId);
                } else {
                    const content = mergeRelationships(oldRelationships, JSON.stringify(part.value));
                    assertCurrentChat(chatId);
                    await saveRelationshipSummary(content, start, end);
                    assertCurrentChat(chatId);
                    $('#cwb-relationship-status').text(content);
                }
                assertCurrentChat(chatId);
                await recordModuleResult(module, start, end);
                assertCurrentChat(chatId);
                successes.push(MODULE_LABELS[module]);
            } catch (error) {
                failures.push(`${MODULE_LABELS[module]}：${error.message}`);
                try { if (currentChatId() === chatId && state.chatId === chatId) await recordModuleResult(module, start, end, error.message); }
                catch (progressError) { failures.push(`进度未确认：${progressError.message}`); }
            }
        }
        // Re-check after timeline, relationships and progress writes: those also
        // save the entire book and must not undo a successful profile write.
        if (savedProfiles.length) {
            try {
                for (const saved of savedProfiles) {
                    assertCurrentChat(chatId);
                    await verifyProfileContent(settings, saved.name, saved.content, saved.isUser, saved);
                }
            } catch (error) {
                failures.push(`${MODULE_LABELS.profiles}：${error.message}`);
                const index = successes.indexOf(MODULE_LABELS.profiles);
                if (index >= 0) successes.splice(index, 1);
                try { if (currentChatId() === chatId && state.chatId === chatId) await recordModuleResult('profiles', start, end, error.message); }
                catch (progressError) { failures.push(`进度未确认：${progressError.message}`); }
            }
        }
        if (!failures.length && targets.length === 3) {
            assertCurrentChat(chatId);
            await recordChatUpdateRange(start, end, state.messages.length, '三个模块均成功，AI调用1次', 0);
        }
        const message = `第 ${start + 1}-${end + 1} 楼，AI 1 次；成功：${successes.join('、') || '无'}${failures.length ? `；待手动补漏：${failures.join('；')}` : ''}`;
        setStatus(message);
        if (failures.length) {
            const failedModules = targets.filter(module => failures.some(failure => failure.startsWith(`${MODULE_LABELS[module]}：`)));
            const reportError = new Error(message);
            reportError.cwbDiagnostics = {
                stage: failures.some(failure => failure.includes('未出现在可用目录')) ? 'profile_worldbook_routing' : 'module_save',
                modules: failedModules.map(module => MODULE_LABELS[module]),
                startFloor: start + 1,
                endFloor: end + 1,
                batchFloors: end - start + 1,
                totalChatFloors: state.messages.length,
                requestCharacters: requestChars || null,
            };
            createErrorReport(reportError, reportError.cwbDiagnostics);
            reportError.cwbReportGenerated = true;
            throw reportError;
        }
        if (!silent) notify('success', message);
        return [...new Set(names)];
    } finally {
        state.updating = false;
        if (state.chatId === chatId) await refreshModuleProgress().catch(error => $('#cwb-progress-error').text(`进度读取失败：${error.message}`));
    }
}

export async function updateRange(settings, startIndex, endIndex, options = {}) {
    const release = acquireOperationLock(state, '指定范围更新');
    try { return await updateRangeUnlocked(settings, startIndex, endIndex, options); }
    finally { release(); }
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
    if (Array.isArray(items)) return consolidateTimelineEntries(items.map(item => {
        if (typeof item === 'string') return item.trim();
        const date = String(item?.日期 ?? item?.date ?? '日期未知').trim();
        const event = String(item?.事件 ?? item?.event ?? '').trim();
        return event ? `${date}｜${event}` : '';
    }).filter(Boolean));
    const lines = cleaned.split(/\r?\n/).map(line => line.replace(/^\s*(?:[-*•]\s*)?\[?时间线(?:\.\d+)?\]?\s*[:：]\s*/, '').trim()).filter(Boolean);
    const events = lines.filter(line => line.includes('｜') || line.includes('|'));
    if (events.length) return consolidateTimelineEntries(events.map(line => line.replace(/\s*[|｜]\s*/g, '｜')));
    throw new Error(`时间线 API 返回格式无法解析：${cleaned.slice(0, 240)}`);
}

function normalizeTimelineLine(line) {
    const cleaned = String(line ?? '').replace(/^\s*\[时间线(?:\.\d+)?\]\s*[:：]\s*/, '').trim().replace(/\s*[|｜]\s*/g, '｜');
    const fields = cleaned.split('｜').map(field => field.trim());
    if (!/^(?:\d{4}-\d{1,2}-\d{1,2}|日期未知)$/.test(fields[0] ?? '') || fields.length < 2) return cleaned;
    // Legacy format was date｜people｜event; discard the standalone people column.
    const event = (fields.length >= 3 ? fields.slice(2) : fields.slice(1)).join('｜').trim();
    return event ? `${fields[0]}｜${event}` : '';
}

function consolidateTimelineEntries(entries) {
    const seen = new Set(), unique = [];
    for (const entry of entries) {
        const normalized = normalizeTimelineLine(entry);
        if (normalized && !seen.has(normalized)) { seen.add(normalized); unique.push(normalized); }
    }
    return unique;
}

function uniqueTimelineEntries(entries, existingLines) {
    const known = new Set(parseTimelineRecords(existingLines).map(record => `${record.date}｜${record.event}`));
    const fresh = [];
    for (const line of entries) {
        const normalized = normalizeTimelineLine(line);
        const match = normalized.match(/^((?:\d{4}-\d{1,2}-\d{1,2})|日期未知)｜(.+)$/);
        if (!match) { if (normalized) fresh.push(normalized); continue; }
        const key = `${match[1]}｜${match[2]}`;
        if (!known.has(key)) fresh.push(key);
        known.add(key);
    }
    return consolidateTimelineEntries(fresh);
}

export async function refreshTimeline(settings, onProgress = () => {}, endIndex = Number.MAX_SAFE_INTEGER, retryStartIndex = null) {
    const release = acquireOperationLock(state, '时间线刷新');
    refreshChatState();
    const chatId = state.chatId;
    const messagesSnapshot = [...state.messages];
    if (!messagesSnapshot.length) { release(); throw new Error('当前聊天为空，无法刷新时间线。'); }
    const scanStartFloor = 1;
    const scanEndFloor = Math.min(messagesSnapshot.length, Number.isFinite(Number(endIndex)) ? Number(endIndex) + 1 : messagesSnapshot.length);
    if (scanEndFloor < scanStartFloor) { release(); throw new Error('时间线更新范围无效。'); }
    state.timelineUpdating = true;
    try {
        assertCurrentChat(chatId);
        const existing = await getTimelineEntries();
        assertCurrentChat(chatId);
        const total = messagesSnapshot.length;
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
                assertCurrentChat(chatId);
                const selected = messagesSnapshot.slice(startFloor - 1, endFloor);
                const range = `${startFloor}-${endFloor}`;
                onProgress(`正在刷新故事时间线：第 ${range} 楼…`);
                setStatus(`正在调用系统 API 更新故事时间线（第 ${range} 楼）…`);
                diagnostics.push(`请求第 ${range} 楼，${selected.length} 条聊天；提示词：${settings.timelineIncrementalPrompt?.trim() ? '自定义' : '内置'}`);
                showDiagnostics();
                const response = await callSystemApi([
                    { role: 'system', content: settings.timelineIncrementalPrompt?.trim() || DEFAULT_TIMELINE_INCREMENTAL_PROMPT },
                    { role: 'system', content: TIMELINE_CONCISION_RULES },
                    { role: 'user', content: `【已有时间线（节选）】\n${compactTimelineContext(previous)}\n\n【本次新增聊天：第 ${range} 楼】\n${formatMessages(selected)}\n\n请提取本次新增聊天中的新事件；不要将已有记录当成本次输出。` },
                ], settings.responseLength);
                assertCurrentChat(chatId);
                diagnostics.push(`API 原始返回（第 ${range} 楼）：\n${response}`);
                showDiagnostics();
                const events = parseTimelineResponse(response);
                const unique = uniqueTimelineEntries(events, previous);
                const content = `【时间线楼层：${range}】\n${formatTimelineRecords(parseTimelineRecords(unique), { header: '', empty: '（本范围已检查，无新增重要事件）' }).trim()}`;
                assertCurrentChat(chatId);
                const savedEntries = await saveTimeline(settings, content, startFloor - 1, endFloor - 1);
                assertCurrentChat(chatId);
                diagnostics.push(`保存成功：解析 ${events.length} 条，去重后新增 ${unique.length} 条；UID ${savedEntries?.[0]?.uid ?? '未知'}。`);
                showDiagnostics();
                await recordModuleResult('timeline', startFloor - 1, endFloor - 1);
                assertCurrentChat(chatId);
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
        release();
    }
}

export async function maybeAutoUpdate(settings) {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(async () => {
        if (!settings.enabled || !settings.autoUpdate || state.operationOwner || state.updating || state.batchRunning || state.repairing) return;
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
    if (state.operationOwner === '批量更新' && state.batchRunning) { state.batchStopRequested = true; return; }
    const release = acquireOperationLock(state, '批量更新');
    refreshChatState();
    if (!state.messages.length) { release(); throw new Error('当前聊天为空。'); }
    const chatId = state.chatId;
    state.batchRunning = true;
    state.batchStopRequested = false;
    try {
        const progress = await refreshModuleProgress();
        const plan = pendingBatches(progress, state.messages.length, Math.max(1, Number(settings.threshold) || 20));
        if (!plan.length) { setStatus('三项均已覆盖全部聊天，无需重复更新，AI 调用 0 次。'); return; }
        for (let index = 0; index < plan.length; index++) {
            if (state.batchStopRequested) break;
            assertCurrentChat(chatId);
            const batch = plan[index];
            onProgress?.(index + 1, plan.length);
            await updateRangeUnlocked(settings, batch.start, batch.end, { silent: true, modules: batch.modules });
        }
        if (!state.batchStopRequested) notify('success', '批量补齐完成，已完成内容没有重复生成。');
    } finally {
        state.batchRunning = false;
        state.batchStopRequested = false;
        onProgress?.(0, 0);
        release();
    }
}

export async function onChatChanged(settings) {
    // Worldbook state is chat-scoped. Let any in-flight save finish its chat check
    // before refreshing or migrating entries for the newly selected chat.
    let waited = 0;
    while (state.operationOwner && waited < 60000) {
        await new Promise(resolve => setTimeout(resolve, 50));
        waited += 50;
    }
    if (state.operationOwner) throw new Error(`等待“${state.operationOwner}”结束超时，聊天状态未刷新。`);
    refreshChatState();
    await manageChatEntries(settings);
    if (!settings.enabled) return;
    if (settings.multiWorldbookRouting) await updateMasterDirectory(settings);
    const progress = await refreshModuleProgress();
    setStatus(`总层数 ${state.messages.length}；${Object.keys(MODULE_LABELS).map(module => `${MODULE_LABELS[module]}连续完成至${moduleStatus(progress, module, state.messages.length).through}楼`).join('；')}。`);
}


export async function updateRelationships(settings, startIndex = null, endIndex = null) {
    const release = acquireOperationLock(state, '角色关系更新');
    refreshChatState();
    const chatId = state.chatId;
    const messagesSnapshot = [...state.messages];
    const end = Math.min(state.messages.length - 1, endIndex ?? state.messages.length - 1);
    const start = Math.max(0, startIndex ?? end - (Number(settings.scanDepth) || 6) + 1);
    if (end < start) { release(); throw new Error('当前范围没有聊天内容。'); }
    state.relationshipUpdating = true;
    try {
        assertCurrentChat(chatId);
        let content = await getRelationshipSummary();
        const completed = await getRelationshipRanges();
        assertCurrentChat(chatId);
        // Standalone updates process every unhandled gap, rather than only the last six messages.
        const ranges = startIndex === null ? missingRanges(end + 1, completed) : [[start, end]];
        if (!ranges.length) ranges.push([start, end]); // Explicit retry can recover an earlier empty result.
        const size = Math.max(1, Number(settings.threshold) || 20);
        const checked = [];
        for (const [rangeStart, rangeEnd] of ranges) {
            for (let chunkStart = rangeStart; chunkStart <= rangeEnd; chunkStart += size) {
                assertCurrentChat(chatId);
                const chunkEnd = Math.min(rangeEnd, chunkStart + size - 1);
                $('#cwb-relationship-status').text(`正在增量更新角色关系：第 ${chunkStart + 1}-${chunkEnd + 1} 楼…`);
                const response = await callSystemApi([
                    { role: 'system', content: RELATIONSHIP_PROMPT },
                    { role: 'user', content: `【已有关系】\n${content || '无'}\n\n【新增聊天：第 ${chunkStart + 1}-${chunkEnd + 1} 楼】\n${formatMessages(messagesSnapshot.slice(chunkStart, chunkEnd + 1))}` },
                ], settings.responseLength);
                assertCurrentChat(chatId);
                const merged = mergeRelationships(content, response);
                // Advance coverage only after successful parsing, persistence, and server readback.
                await saveRelationshipSummary(merged, chunkStart, chunkEnd);
                assertCurrentChat(chatId);
                await recordModuleResult('relationships', chunkStart, chunkEnd);
                assertCurrentChat(chatId);
                content = merged;
                checked.push(`${chunkStart + 1}-${chunkEnd + 1}`);
            }
        }
        $('#cwb-relationship-status').text(`角色关系增量已保存：第 ${checked.join('、')} 楼。\n${content}`);
        return content;
    } catch (error) {
        $('#cwb-relationship-status').text(`角色关系更新失败：${error.message}`);
        throw error;
    } finally { state.relationshipUpdating = false; release(); }
}
