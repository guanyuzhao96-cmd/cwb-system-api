import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyModuleResult, moduleStatus, pendingBatches, intersectRanges, mergeModuleProgress, legacyModuleHistory } from './module-progress.mjs';

test('a hole cannot be hidden by later success; repair closes only the selected module gap', () => {
    let progress = {};
    for (const module of ['profiles', 'timeline', 'relationships']) progress = applyModuleResult(progress, module, 0, 79);
    progress = applyModuleResult(progress, 'profiles', 80, 99);
    progress = applyModuleResult(progress, 'timeline', 80, 99, 'JSON格式错误');
    progress = applyModuleResult(progress, 'relationships', 80, 99);
    progress = applyModuleResult(progress, 'timeline', 100, 119);
    assert.equal(moduleStatus(progress, 'timeline', 120).through, 80);
    assert.deepEqual(moduleStatus(progress, 'timeline', 120).missing, [[80, 99]]);
    const plan = pendingBatches(progress, 120, 20);
    assert.deepEqual(plan, [{ start: 80, end: 99, modules: ['timeline'] }, { start: 100, end: 119, modules: ['profiles', 'relationships'] }]);
    progress = applyModuleResult(progress, 'timeline', 80, 99);
    assert.equal(moduleStatus(progress, 'timeline', 120).through, 120);
    assert.deepEqual(moduleStatus(progress, 'timeline', 120).failed, []);
});

test('100 completed floors resume at 101; repeated batch makes no requests', () => {
    let progress = {};
    for (const module of ['profiles', 'timeline', 'relationships']) progress = applyModuleResult(progress, module, 0, 99);
    assert.deepEqual(pendingBatches(progress, 100, 20), []);
    const plan = pendingBatches(progress, 140, 20);
    assert.deepEqual(plan.map(batch => [batch.start, batch.end]), [[100, 119], [120, 139]]);
    for (const batch of plan) for (const module of batch.modules) progress = applyModuleResult(progress, module, batch.start, batch.end);
    assert.deepEqual(pendingBatches(JSON.parse(JSON.stringify(progress)), 140, 20), []);
});

test('legacy migration only trusts intersected confirmed ranges, including disjoint gaps', () => {
    assert.deepEqual(intersectRanges([[0, 99]], [[0, 79]]), [[0, 79]]);
    assert.deepEqual(intersectRanges([[0, 19], [40, 99]], [[10, 59]]), [[10, 19], [40, 59]]);
});

test('refresh merges confirmed legacy coverage into partially populated module progress', () => {
    const legacy = Object.fromEntries(['profiles', 'timeline', 'relationships'].map(module => [module, { completed: [[0, 99]], failed: [] }]));
    const saved = { profiles: { completed: [[0, 119]], failed: [] }, timeline: { completed: [], failed: [[80, 99]] } };
    const merged = mergeModuleProgress(saved, legacy);
    assert.deepEqual(merged.profiles.completed, [[0, 119]]);
    assert.deepEqual(merged.timeline.completed, [[0, 79]]);
    assert.deepEqual(merged.timeline.failed, [[80, 99]]);
    assert.deepEqual(merged.relationships.completed, [[0, 99]]);
    assert.equal(moduleStatus(merged, 'relationships', 120).through, 100);
});

test('Chinese legacy ledger retains success and failures without completing current source floors', () => {
    const old = { 存档版本: 3, 时间线: { 已保存楼层: '1-25', 失败楼层: '无' },
        角色档案: { 已保存楼层: '无', 失败楼层: '1-25', 最近更新: { 错误: '未写入本轮资料' } },
        角色关系: { 已保存楼层: '无', 失败楼层: '1-25' } };
    const history = legacyModuleHistory(old);
    assert.deepEqual(history.timeline.completed, [[0, 24]]);
    assert.deepEqual(history.profiles.failed, [[0, 24]]);
    const progress = { timeline: { completed: [], failed: [], legacy: history.timeline } };
    const status = moduleStatus(progress, 'timeline', 572);
    assert.equal(status.through, 0);
    assert.equal(status.legacyThrough, 25);
    assert.deepEqual(status.unverified, [[0, 24]]);
    assert.ok(pendingBatches(progress, 25, 25)[0].modules.includes('timeline'), 'legacy records still require source verification');
    progress.timeline.completed = [[0, 9]];
    assert.deepEqual(moduleStatus(progress, 'timeline', 572).unverified, [[10, 24]]);
    assert.deepEqual(legacyModuleHistory({ ...old, receipts: {}, legacyModules: history }), history);
    assert.throws(() => legacyModuleHistory({ 存档版本: 3, 时间线: { 已保存楼层: '不合法' } }), /格式无效/);
});
