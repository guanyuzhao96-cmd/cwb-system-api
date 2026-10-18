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
    assert.match(COMBINED_OUTPUT_PROTOCOL, /时间线增量开始/);
    assert.match(COMBINED_OUTPUT_PROTOCOL, /没有新增时也要输出空数组/);
    for (const prompt of [DEFAULT_TIMELINE_INCREMENTAL_PROMPT, TIMELINE_CONCISION_RULES]) {
        assert.match(prompt, /关键变化/);
        assert.match(prompt, /每条事件一句话|每条.*一句/);
        assert.match(prompt, /日常.*省略|日常行动.*省略/);
    }
    assert.match(DEFAULT_TIMELINE_INCREMENTAL_PROMPT, /无重要进展时输出.*"时间线":\[\]/);
    assert.match(TIMELINE_CONCISION_RULES, /日常.*省略/);
    assert.match(TIMELINE_CONCISION_RULES, /删去枝节/);
    for (const prompt of [DEFAULT_TIMELINE_INCREMENTAL_PROMPT, TIMELINE_CONCISION_RULES]) {
        assert.match(prompt, /同一故事线中有因果关系的事件/);
        assert.match(prompt, /按时间排序/);
        assert.match(prompt, /只输出日期、事件字段的 JSON/);
        assert.match(prompt, /任务\/系统\/操作信息省略/);
        assert.match(prompt, /不同故事线不拼接/);
        assert.match(prompt, /不因日期相同合并无关事件/);
        assert.match(prompt, /姓名用可确认的全名/);
    }
});
