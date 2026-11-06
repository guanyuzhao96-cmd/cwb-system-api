// Session-only diagnostics. Never render model output as HTML or persist it in settings.
const replies = [];
export function replyLogText() {
    return replies.map((item, index) => `===== 请求 ${index + 1} · ${item.range || '未指定楼层'} · ${item.text.length} 字符${item.error ? ' · 请求失败' : ''} =====\n${item.error ? `没有收到回复：${item.error}` : item.text}`).join('\n\n');
}
export function recordAiReply(text, range = '', error = '') {
    replies.push({ text: String(text ?? ''), range, error: String(error || '') });
    if (typeof document === 'undefined') return;
    const field = document.getElementById('cwb-ai-reply-text');
    if (field) field.value = replyLogText();
    if (error) {
        const section = document.getElementById('cwb-ai-replies');
        if (section) section.open = true;
    }
}
export function downloadAiReplies() {
    if (!replies.length) return false;
    const url = URL.createObjectURL(new Blob([replyLogText()], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `cwb-ai-replies-${Date.now()}.txt`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
}
