import { generateRaw } from '/script.js';

export function isSystemApiReady() {
    return true;
}

export async function callSystemApi(messages, responseLength = null) {
    if (!Array.isArray(messages) || !messages.length) throw new Error('提示词为空。');
    const systemMessages = messages.filter(message => message.role === 'system').map(message => message.content);
    const promptMessages = messages.filter(message => message.role !== 'system');
    const result = await generateRaw({
        prompt: promptMessages,
        systemPrompt: systemMessages.join('\n\n'),
        responseLength: Number(responseLength) > 0 ? Number(responseLength) : null,
        trimNames: false,
    });
    if (!String(result ?? '').trim()) throw new Error('系统 API 未返回有效内容。');
    return String(result).trim();
}

export async function testSystemApi() {
    return callSystemApi([
        { role: 'system', content: '这是连接测试。只回复：连接正常' },
        { role: 'user', content: '测试当前 SillyTavern 系统 API。' },
    ], 32);
}
