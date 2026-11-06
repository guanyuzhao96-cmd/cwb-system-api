import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archiveText, archiveMessages, archiveBatches } from './archive-input.mjs';

test('remove machine blocks while preserving narrative, summaries, dialogue and date', () => {
    const input = '<dream_body>2025-09-01｜角色作出重要决定<image>image###prompt</image>约定会面</dream_body><UpdateVariable><JSONPatch>[{"op":"replace"}]</JSONPatch></UpdateVariable><plot_summary>保留剧情摘要</plot_summary><wechat>甲:消息</wechat><Analysis>思考文本</Analysis>';
    const text = archiveText(input);
    for (const absent of ['image###', 'JSONPatch', '思考文本']) assert.ok(!text.includes(absent));
    for (const kept of ['2025-09-01', '重要决定', '约定会面', '保留剧情摘要', '甲:消息']) assert.ok(text.includes(kept));
});
test('an incomplete image in one floor never eats a following floor', () => {
    const messages = [{ mes: '<text_to_image><image>unfinished</text_to_image>' }, { mes: '第二楼的重要决定' }];
    const prepared = archiveMessages(messages);
    assert.equal(prepared[0].message, '');
    assert.equal(prepared[1].message, '第二楼的重要决定');
    assert.equal(messages[0].mes, '<text_to_image><image>unfinished</text_to_image>');
});
test('length batches preserve every original floor exactly once without truncation', () => {
    const messages = Array.from({ length: 23 }, (_, i) => ({ mes: `${i}:` + '剧情'.repeat(1000) }));
    const batches = archiveBatches(messages, 0, 22, 5000);
    assert.ok(batches.length > 1);
    assert.deepEqual(batches.flatMap(({ start, end }) => Array.from({ length: end - start + 1 }, (_, i) => start + i)), Array.from({ length: 23 }, (_, i) => i));
    assert.ok(batches.every(batch => batch.characters <= 5000));
});
test('one oversized floor is never silently sliced or dropped', () => {
    const batches = archiveBatches([{ mes: '文'.repeat(30000) }], 0, 0);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].characters, 30080);
});
