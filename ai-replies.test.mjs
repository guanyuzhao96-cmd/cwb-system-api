import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordAiReply, replyLogText } from './ai-replies.mjs';

test('reply history preserves whitespace, unsafe markup and failed requests without overwriting earlier replies', () => {
    const field = { value: '' }, section = { open: false };
    const previous = globalThis.document;
    globalThis.document = { getElementById: id => id === 'cwb-ai-reply-text' ? field : section };
    try {
        const raw = '  <script>example()</script>\n[--角色档案开始--]\n原样正文\n  ';
        recordAiReply(raw, '第 1-25 楼');
        assert.ok(field.value.endsWith(raw));
        assert.equal(field.innerHTML, undefined, 'model text is never interpreted as HTML');
        recordAiReply('', '第 26-50 楼', '连接失败');
        assert.equal(section.open, false, 'failed replies preserve the collapsed state');
        recordAiReply('下一批成功', '第 51-75 楼');
        assert.ok(replyLogText().includes(raw));
        assert.ok(replyLogText().includes('没有收到回复：连接失败'));
        assert.ok(field.value.includes('下一批成功'));
        assert.equal((field.value.match(/===== 请求/g) || []).length, 3);
    } finally {
        if (previous === undefined) delete globalThis.document;
        else globalThis.document = previous;
    }
});
