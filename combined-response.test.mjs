import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCombinedResponse } from './combined-response.mjs';
import { COMBINED_OUTPUT_PROTOCOL } from './combined-response.mjs';
import { DEFAULT_TIMELINE_INCREMENTAL_PROMPT, TIMELINE_CONCISION_RULES } from './defaults.js';
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

test('independent parsing salvages valid parts without marking a malformed part successful', async () => {
    const { parseCombinedParts } = await import('./combined-response.mjs');
    const parts = parseCombinedParts(valid.replace('{"时间线":[]}', '{invalid}'));
    assert.ok(parts.timeline.error);
    assert.deepEqual(parts.profiles.value, []);
    assert.deepEqual(parts.relationships.value.关系更新, []);
    assert.ok(parseCombinedParts('[--角色档案开始--]\n[姓名]:A\n' + valid.replace('[--档案无变化--]', '')).profiles.error);
});

test('timeline prompts retain only concise key information and major events', () => {
    for (const prompt of [COMBINED_OUTPUT_PROTOCOL, DEFAULT_TIMELINE_INCREMENTAL_PROMPT]) {
        assert.match(prompt, /大事件/);
        assert.match(prompt, /不超过28个汉字/);
        assert.match(prompt, /日常.*省略|日常行动.*省略/);
        assert.match(prompt, /无实质进展.*空数组|没有符合以上标准.*"时间线":\[\]/);
    }
    assert.match(TIMELINE_CONCISION_RULES, /不记录日常/);
    assert.match(TIMELINE_CONCISION_RULES, /不超过28个汉字/);
    for (const prompt of [COMBINED_OUTPUT_PROTOCOL, DEFAULT_TIMELINE_INCREMENTAL_PROMPT, TIMELINE_CONCISION_RULES]) {
        assert.match(prompt, /同一天.*合并|同一日期.*合并/);
        assert.match(prompt, /日期.*只.*一次/);
        assert.match(prompt, /不得单独列出人物或出场角色|不得单独列出出场角色|不得输出“人物”/);
    }
});
