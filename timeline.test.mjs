import { MODULE_LABELS, moduleStatus, displayRanges, applyModuleResult, intersectRanges, pendingBatches } from './module-progress.mjs';
import { COMBINED_OUTPUT_PROTOCOL, parseCombinedParts } from './combined-response.mjs';
import { mergeRelationships } from './relationship-utils.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { DEFAULT_TIMELINE_INCREMENTAL_PROMPT } from './defaults.js';
import { PROFILE_RULES, sanitizeProfileContent, hasProfileFacts } from './profile-utils.mjs';
import { mergeRanges, parseTaggedRanges } from './update-tracker.mjs';

function harness(entries = {}) {
    let data = { entries: structuredClone(entries) }, saves = 0, fail = false;
    const context = vm.createContext({
        MODULE_LABELS, moduleStatus, displayRanges, applyModuleResult, intersectRanges, pendingBatches,
        DEFAULT_TIMELINE_INCREMENTAL_PROMPT, PROFILE_RULES, sanitizeProfileContent, hasProfileFacts,
        structuredClone, getRequestHeaders: () => ({}),
        fetch: async () => ({ ok: true, json: async () => structuredClone(data) }),
        mergeRanges, parseTaggedRanges, state: { chatId: 'chat' },
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
    assert.equal(Object.values(h.data().entries).filter(entry => entry.key.includes('CWB:故事时间线')).length, 1);
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
    const result = await h.context.refreshTimeline({ threshold: 20 }, () => {}, 59, 60);
    assert.equal(result.addedRanges.join(','), '21-40');
    assert.equal(result.coveredCount, 60);
    assert.equal(calls, 1);
    assert.equal(Object.values(h.data().entries).filter(entry => entry.key.includes('CWB:故事时间线')).length, 1);
    await h.context.refreshTimeline({ threshold: 20 }, () => {}, 59, 60);
    assert.equal(calls, 1);
});


test('consecutive new rounds append to one entry; covered empty results can recover', async () => {
    const h = harness();
    let count = 20, calls = 0, empty = false;
    h.context.getContext = () => ({ chatId: 'chat', chat: Array.from({ length: count }, () => ({ mes: '正文' })), characterId: 0, characters: [{ data: { extensions: { world: 'main' } } }] });
    h.context.$ = () => ({ text() {} });
    h.context.callSystemApi = async () => { calls++; return JSON.stringify({ 时间线: empty ? [] : [`2025-01-${String(count / 20).padStart(2, '0')}｜甲｜事件${count}`] }); };
    vm.runInContext(readFileSync(new URL('./core.js', import.meta.url), 'utf8').replace(/^import[\s\S]*?;\n/gm, '').replace(/export /g, ''), h.context);
    await h.context.refreshTimeline({ threshold: 20 });
    count = 40;
    await h.context.refreshTimeline({ threshold: 20 });
    count = 60; empty = true;
    await h.context.refreshTimeline({ threshold: 20 });
    assert.equal(Object.values(h.data().entries).filter(entry => entry.key.includes('CWB:故事时间线')).length, 1);
    assert.ok(h.data().entries[0].content.includes('事件20'));
    assert.ok(h.data().entries[0].content.includes('事件40'));
    assert.ok(!h.data().entries[0].content.includes('事件60'));
    empty = false;
    const recovered = await h.context.refreshTimeline({ threshold: 20 });
    assert.equal(recovered.addedEvents, 1);
    assert.ok(h.data().entries[0].content.includes('事件60'));
    const repeated = await h.context.refreshTimeline({ threshold: 20 });
    assert.equal(repeated.addedEvents, 0);
    assert.equal(h.data().entries[0].content.match(/事件60/g).length, 1);
    assert.equal(calls, 5);
});

test('unified no-profile update still saves timeline and relationships with exactly one AI call', async () => {
    const h = harness();
    h.context.getContext = () => ({ chatId: 'chat', characterId: 0, characters: [{ data: { extensions: { world: 'main' } } }], name1: '用户', chat: [{ mes: '新事件' }] });
    let calls = 0, timelineWrites = 0, relationshipWrites = 0;
    Object.assign(h.context, {
        $: () => ({ text() {} }), getTargetWorldbook: () => 'main',
        getChatUpdateTracking: async () => null, overlappingRanges: () => [],
        getTriggeredOldProfiles: async () => [], getTimelineEntries: async () => [],
        getRelationshipSummary: async () => '',
        callSystemApi: async () => { calls++; return '[--档案无变化--]\n[--时间线增量开始--]\n{"时间线":[]}\n[--时间线增量结束--]\n[--关系增量开始--]\n{"关系更新":[],"删除关系":[]}\n[--关系增量结束--]'; },
        recordChatUpdateRange: async () => {}, notify() {},
        COMBINED_OUTPUT_PROTOCOL, parseCombinedParts, RELATIONSHIP_PROMPT: '', mergeRelationships,
    });
    vm.runInContext(readFileSync(new URL('./core.js', import.meta.url), 'utf8').replace(/^import[\s\S]*?;\n/gm, '').replace(/export /g, ''), h.context);
    h.context.saveTimeline = async () => timelineWrites++;
    h.context.saveRelationshipSummary = async () => relationshipWrites++;
    await h.context.updateRange({}, 0, 0, { silent: true });
    assert.equal(calls, 1); assert.equal(timelineWrites, 1); assert.equal(relationshipWrites, 1);
});


test('v0.9.8 confirmed 100-floor progress migrates, arbitrary prose markers do not', async () => {
    const h = harness({
        0: { uid: 0, key: ['CWB:更新记录', 'chat', 'CWB:总结楼层:0-99'], content: '三个模块均成功，AI调用1次' },
        1: entry(1, 'chat', '1-100', '旧时间线'),
        2: { uid: 2, key: ['CWB:角色关系汇总', 'chat', 'CWB:关系楼层:0-99'], content: 'A ↔ B：同学' },
    });
    const progress = await h.context.getModuleProgress();
    assert.deepEqual(JSON.parse(JSON.stringify(progress.profiles.completed)), [[0, 99]]);
    assert.deepEqual(pendingBatches(progress, 100, 20), []);
    await h.context.recordModuleResult('timeline', 100, 119, '格式错误');
    const reloaded = await h.context.getModuleProgress();
    assert.deepEqual(JSON.parse(JSON.stringify(reloaded.timeline.failed)), [[100, 119]]);
    assert.deepEqual(JSON.parse(JSON.stringify(reloaded.relationships.completed)), [[0, 99]]);
    const prose = harness({ 0: { uid: 0, key: ['chat'], content: '本条勿动【前197楼总结已完成】' } });
    assert.deepEqual(JSON.parse(JSON.stringify(await prose.context.getModuleProgress())), {});
});
