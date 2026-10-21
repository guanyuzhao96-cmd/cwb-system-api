import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRelationships, parseRelationshipSummary } from './relationship-utils.mjs';
const response = items => JSON.stringify({ 关系更新: items });
const relation = (a, b, text, direction = '↔') => ({ 人物A: a, 人物B: b, 方向: direction, 关系: text });
test('relationship delta preserves unrelated pairs, updates reverse mutual pair and distinguishes direction', () => {
    let summary = mergeRelationships('', response([relation('A', 'B', '同班同学、情侣'), relation('B', 'C', '互相讨厌'), relation('A', 'C', '暗恋', '→')]));
    summary = mergeRelationships(summary, response([relation('B', 'A', '同班同学、已分手'), relation('C', 'A', '尚不知情', '→')]));
    assert.equal(parseRelationshipSummary(summary).length, 4);
    assert.ok(summary.includes('B ↔ A：同班同学、已分手'));
    assert.ok(summary.includes('B ↔ C：互相讨厌'));
    assert.ok(summary.includes('A → C：暗恋'));
    assert.ok(summary.includes('C → A：尚不知情'));
    assert.ok(!summary.includes('情侣'));
    assert.equal(mergeRelationships(summary, response([])), summary);
});
test('explicit deletion and invalid replies do not silently clear the summary', () => {
    const old = mergeRelationships('', response([relation('A', 'B', '朋友')]));
    assert.throws(() => mergeRelationships(old, '已更新'), /合法 JSON/);
    assert.throws(() => mergeRelationships(old, '{}'), /数组/);
    const cleared = mergeRelationships(old, JSON.stringify({ 关系更新: [], 删除关系: [relation('B', 'A', '')] }));
    assert.equal(parseRelationshipSummary(cleared).length, 0);
});

test('equivalent names normalize without guessing missing identities or accepting conflicting aliases', () => {
    const result = mergeRelationships('', response([{ 角色A: { 姓名: '周韵涵' }, 角色B: '秦雅楠', direction: '<->', relationship: '协作核查' }]));
    assert.match(result, /周韵涵 ↔ 秦雅楠：协作核查/);
    assert.throws(() => mergeRelationships(result, response([{ 角色A: '周韵涵', 关系: '朋友' }])), /缺人物B/);
    assert.throws(() => mergeRelationships(result, response([{ 人物A: '甲', 角色A: '乙', 人物B: '丙', 关系: '朋友' }])), /冲突/);
    assert.throws(() => mergeRelationships(result, response([{ 人物A: '甲', 人物B: '甲', 关系: '朋友' }])), /同一人/);
});
