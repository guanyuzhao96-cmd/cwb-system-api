import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCombinedResponse } from './combined-response.mjs';
const valid = '[--档案无变化--]\n[--时间线增量开始--]\n{"时间线":[]}\n[--时间线增量结束--]\n[--关系增量开始--]\n{"关系更新":[],"删除关系":[]}\n[--关系增量结束--]';
test('combined response requires all three sections, including explicit empty deltas', () => {
    const result = parseCombinedResponse(valid);
    assert.deepEqual(result.timeline.时间线, []);
    assert.deepEqual(result.relationships.关系更新, []);
    assert.throws(() => parseCombinedResponse(valid.split('[--关系增量开始--]')[0]), /关系/);
    assert.throws(() => parseCombinedResponse(valid.replace('{"时间线":[]}', '{}')), /时间线数组/);
    assert.throws(() => parseCombinedResponse(valid.replace('[--档案无变化--]', '')), /角色档案/);
    assert.throws(() => parseCombinedResponse(valid + valid), /重复/);
});
