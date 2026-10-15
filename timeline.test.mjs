import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { mergeRanges } from './update-tracker.mjs';

function harness(entries = {}) {
    let data = { entries: structuredClone(entries) }, saves = 0, fail = false;
    const context = vm.createContext({
        mergeRanges, state: { chatId: 'chat' },
        getContext: () => ({ characterId: 0, characters: [{ data: { extensions: { world: 'main' } } }] }),
        loadWorldInfo: async () => structuredClone(data),
        saveWorldInfo: async (_, next) => { if (fail) throw Error('save failed'); data = structuredClone(next); saves++; },
        createWorldInfoEntry: (_, next) => { const uid = Math.max(-1, ...Object.keys(next.entries).map(Number)) + 1; return next.entries[uid] = { uid }; },
    });
    const source = readFileSync(new URL('./lorebook.js', import.meta.url), 'utf8').replace(/^import[\s\S]*?;\n/gm, '').replace(/export /g, '');
    vm.runInContext(source, context);
    return { context, data: () => data, saves: () => saves, fail: () => fail = true };
}
const entry = (uid, chat, range, content) => ({ uid, key: ['CWB:故事时间线', chat, `CWB:时间线楼层:${range}`], content });

test('legacy entries merge atomically, retain UID, deduplicate and isolate other chats', async () => {
    const h = harness({ 0: entry(0, 'chat', '1-20', '[时间线.0]: 2025-02-02｜甲｜事件乙'), 1: entry(1, 'chat', '41-60', '[时间线.0]: 2025-01-01｜甲｜事件甲\n[时间线.1]: 2025-02-02｜甲｜事件乙'), 2: entry(2, 'other', '1-10', 'other') });
    await h.context.getTimelineEntries();
    assert.equal(h.saves(), 1);
    assert.deepEqual(Object.keys(h.data().entries), ['0', '2']);
    assert.equal(h.data().entries[0].content, '【主线时间线】\n[时间线.0]: 2025-01-01｜甲｜事件甲\n[时间线.1]: 2025-02-02｜甲｜事件乙');
    assert.ok(h.data().entries[0].key.includes('CWB:时间线楼层:41-60'));
    await h.context.saveTimeline({}, '【时间线楼层：21-40】\n（本范围已检查，无新增重要事件）', 20, 39);
    assert.ok(h.data().entries[0].key.includes('CWB:时间线楼层:1-60'));
    await h.context.saveTimeline({}, '[时间线.0]: 2025-03-01｜乙｜事件丙', 60, 79);
    assert.deepEqual(Object.keys(h.data().entries), ['0', '2']);
    assert.ok(h.data().entries[0].content.includes('事件丙'));
    assert.equal(h.data().entries[2].content, 'other');
});

test('first save and retry keep one entry; failed migration preserves originals', async () => {
    const h = harness();
    await h.context.saveTimeline({}, '[时间线.0]: 日期未知｜甲｜事件', 0, 19);
    await h.context.saveTimeline({}, '[时间线.0]: 日期未知｜甲｜事件', 0, 19);
    assert.equal(Object.keys(h.data().entries).length, 1);
    assert.equal(h.data().entries[0].content.match(/日期未知/g).length, 1);
    const failed = harness({ 0: entry(0, 'chat', '1-20', '旧资料'), 1: entry(1, 'chat', '21-40', '补充资料') });
    failed.fail();
    await assert.rejects(failed.context.getTimelineEntries(), /save failed/);
    assert.equal(Object.keys(failed.data().entries).length, 2);
});

test('refresh fills only the gap between disjoint ranges and repeats without API calls', async () => {
    const h = harness({ 0: entry(0, 'chat', '1-20', '2025-01-01｜甲｜事件甲'), 1: entry(1, 'chat', '41-60', '2025-03-01｜甲｜事件丙') });
    let calls = 0;
    h.context.getContext = () => ({ chatId: 'chat', chat: Array.from({ length: 60 }, () => ({ mes: '正文' })), characterId: 0, characters: [{ data: { extensions: { world: 'main' } } }] });
    h.context.$ = () => ({ text() {} });
    h.context.callSystemApi = async () => { calls++; return '{"时间线":["2025-02-01｜甲｜事件乙"]}'; };
    const source = readFileSync(new URL('./core.js', import.meta.url), 'utf8').replace(/^import[\s\S]*?;\n/gm, '').replace(/export /g, '');
    vm.runInContext(source, h.context);
    const result = await h.context.refreshTimeline({ threshold: 20 });
    assert.equal(result.addedRanges.join(','), '21-40');
    assert.equal(result.coveredCount, 60);
    assert.equal(calls, 1);
    assert.equal(Object.keys(h.data().entries).length, 1);
    await h.context.refreshTimeline({ threshold: 20 });
    assert.equal(calls, 1);
});
