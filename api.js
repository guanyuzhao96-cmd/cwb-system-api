import { generateRaw, main_api, createRawPrompt, extractMessageFromData, eventSource, event_types } from '/script.js';
import { sendOpenAIRequest } from '/scripts/openai.js';

export function isSystemApiReady() {
    return typeof generateRaw === 'function';
}

// SillyTavern 1.13.5 generateRaw() calls cleanUpMessage(), which applies all
// AI_OUTPUT regexes before returning. Machine-readable archives must use the
// native chat request/extractor directly, without altering the user's regexes.
export async function callSystemApi(messages, responseLength = null, onDetails = () => {}) {
    if (!Array.isArray(messages) || !messages.length) throw new Error('提示词为空。');
    const systemMessages = messages.filter(message => message.role === 'system').map(message => message.content);
    const promptMessages = messages.filter(message => message.role !== 'system').map(message => ({ ...message }));
    const length = Number(responseLength) > 0 ? Number(responseLength) : null;
    const details = { transport: main_api === 'openai' ? 'native-chat-unprocessed' : 'generateRaw-host-cleanup', finishReason: null };
    let result, lengthHook;
    try {
        if (main_api === 'openai') {
            const prompt = createRawPrompt(promptMessages, 'openai', false, false, systemMessages.join('\n\n'), '');
            // Native sendOpenAIRequest filters the array, but preserves message
            // objects. Apply a limit only to this request, never global settings.
            if (length) {
                if (!event_types.CHAT_COMPLETION_SETTINGS_READY || typeof eventSource.removeListener !== 'function') {
                    throw new Error('宿主缺少请求长度事件接口，无法应用本次回复长度。');
                }
                lengthHook = data => {
                    if (!Array.isArray(data.messages) || !data.messages.some(message => prompt.includes(message))) return;
                    if ('max_completion_tokens' in data) data.max_completion_tokens = length;
                    else data.max_tokens = length;
                };
                eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, lengthHook);
            }
            const data = await sendOpenAIRequest('quiet', prompt, new AbortController().signal);
            details.finishReason = data?.choices?.[0]?.finish_reason ?? data?.stop_reason ?? null;
            result = extractMessageFromData(data, 'openai');
        } else {
            result = await generateRaw({
                prompt: promptMessages,
                systemPrompt: systemMessages.join('\n\n'),
                responseLength: length,
                trimNames: false,
            });
        }
    } catch (error) {
        const wrapped = new Error(`酒馆系统 API 请求失败：${error?.message || String(error)}`, { cause: error });
        wrapped.cwbDiagnostics = details;
        throw wrapped;
    } finally {
        if (lengthHook) eventSource.removeListener(event_types.CHAT_COMPLETION_SETTINGS_READY, lengthHook);
        onDetails(details);
    }
    if (!String(result ?? '').trim()) {
        const error = new Error(`系统 API 未返回有效正文${details.finishReason ? `（结束原因：${details.finishReason}）` : ''}。`);
        error.cwbDiagnostics = details;
        throw error;
    }
    return String(result).trim();
}

export async function testSystemApi() {
    return callSystemApi([
        { role: 'system', content: '这是连接测试。只回复：连接正常' },
        { role: 'user', content: '测试当前 SillyTavern 系统 API。' },
    ], 32);
}
