import { getContext } from '/scripts/extensions.js';
import { callSystemApi } from './api.js';
import { state } from './state.js';
import {
    getLastUpdatedFloor,
    getTargetWorldbook,
    getTriggeredOldProfiles,
    manageChatEntries,
    saveCharacterDescription,
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
    return parsed?.name?.trim()
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
    if (!getTargetWorldbook(settings)) throw new Error('当前角色未绑定主世界书，请先绑定或选择指定世界书。');

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
        if (settings.incremental) {
            messages.push({
                role: 'user',
                content: `【旧档案】\n${oldProfiles.length ? oldProfiles.join('\n') : '无'}`,
            });
        }
        messages.push({
            role: 'user',
            content: `${settings.incremental ? '【新对话】' : '最近的聊天记录摘要：'}\n${formatMessages(selected) || '(无有效对话内容)'}`,
        });

        setStatus('正在调用酒馆系统 API…');
        const response = await callSystemApi(messages, settings.responseLength);
        const blocks = extractCharacterBlocks(response);
        if (!blocks.length) throw new Error('模型回复中没有合法的角色档案块。');

        const names = [];
        for (const block of blocks) {
            const name = characterNameFromBlock(block);
            if (!name) continue;
            names.push(await saveCharacterDescription(settings, name, block, boundedStart, boundedEnd));
        }
        const uniqueNames = [...new Set(names)];
        if (!uniqueNames.length) throw new Error('模型生成了内容，但没有识别出角色姓名。');
        await updateRoster(settings, uniqueNames, boundedStart, boundedEnd);
        setStatus(`完成：第 ${boundedStart + 1}-${boundedEnd + 1} 层，更新 ${uniqueNames.length} 个角色。`);
        if (!silent) notify('success', `已更新 ${uniqueNames.length} 个角色档案。`);
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
    const floor = await getLastUpdatedFloor(settings);
    setStatus(`总层数 ${state.messages.length}；角色世界书已更新至第 ${floor} 层。`);
}
