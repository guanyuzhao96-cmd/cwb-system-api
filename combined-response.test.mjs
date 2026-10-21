import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCombinedResponse } from './combined-response.mjs';
import { COMBINED_OUTPUT_PROTOCOL, buildCombinedUpdatePrompt } from './combined-response.mjs';
import { parseCombinedParts, inspectCombinedResponse } from './combined-response.mjs';
import { DEFAULT_TIMELINE_INCREMENTAL_PROMPT, TIMELINE_CONCISION_RULES } from './defaults.js';
const valid = '[--档案无变化--]\n[--时间线增量开始--]\n{"时间线":[]}\n[--时间线增量结束--]\n[--关系增量开始--]\n{"关系更新":[],"删除关系":[]}\n[--关系增量结束--]';

test('unified task includes complete fields without independent exclusive instructions', () => {
    const settings = { breakPrompt: 'CUSTOM_ONLY_OUTPUT_EQUALS', incrementalPrompt: 'CUSTOM_PROFILE', timelineIncrementalPrompt: 'CUSTOM_TIMELINE' };
    const prompt = buildCombinedUpdatePrompt(settings);
    for (const field of ['[姓名]', '[角色已知信息.0]', '[角色未知信息.0]', '[剧情.0]']) assert.ok(prompt.includes(field));
    for (const value of Object.values(settings)) assert.ok(!prompt.includes(value));
    assert.ok(!prompt.includes('不生成角色档案'));
    assert.ok(!prompt.includes('只输出日期、事件字段的 JSON'));
    assert.match(prompt, /赵冠宇：不得生成或更新/);
    assert.match(prompt, /任务、系统点数、奖励和好感度数值/);
    assert.match(prompt, /逐条原文保留全部旧剧情/);
    assert.match(buildCombinedUpdatePrompt({ incremental: false }), /如有旧档案，仍须保留其历史/);
    assert.ok(!buildCombinedUpdatePrompt({}, ['timeline', 'relationships']).includes('【角色档案任务】'));
});

export const alternateReply = `===角色档案===
【赵冠宇】
姓名：赵冠宇
等级：主角
系统点：43
当前任务：整理藏书
===角色档案结束===
===角色档案===
【周韵涵】
姓名：周韵涵
身份：班长
好感度：35
===角色档案结束===
===时间线增量===
2025-09-01 08:00｜校门口｜赵冠宇认识周韵涵，触发任务。
===时间线增量结束===
===关系增量===
赵冠宇—周韵涵：班长与转学生。好感35。任务进行中。
===关系增量结束===`;

test('reported equals-heading reply fails explicitly and diagnostics identify the actual format', () => {
    const parts = parseCombinedParts(alternateReply);
    assert.match(parts.profiles.error, /自由人物卡.*档案未保存/);
    assert.match(parts.timeline.error, /纯文本格式.*JSON/);
    assert.match(parts.relationships.error, /纯文本格式.*JSON/);
    const diagnostic = inspectCombinedResponse(alternateReply);
    assert.equal(diagnostic.format, 'alternate-text');
    assert.deepEqual(diagnostic.alternateSectionCounts, { 角色档案: 2, 时间线增量: 1, 关系增量: 1 });
    assert.ok(!JSON.stringify(diagnostic).includes('周韵涵'));
});
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

test('reasoning examples do not duplicate final blocks, and reasoning-only output cannot succeed', () => {
    for (const tag of ['think', 'thinking', 'Analysis']) {
        const response = `<${tag}>Example output:\n${valid}</${tag}>\n${valid}`;
        assert.deepEqual(parseCombinedResponse(response).timeline.时间线, []);
        const diagnostics = inspectCombinedResponse(response);
        assert.equal(diagnostics.reasoningBlocksRemoved, 1);
        assert.equal(diagnostics.markerCounts.时间线增量开始, 1);
        const reasoningOnly = `<${tag}>${valid}</${tag}>`;
        assert.ok(Object.values(parseCombinedParts(reasoningOnly)).every(part => part.error));
    }
    assert.ok(Object.values(parseCombinedParts(`<think>${valid}`)).every(part => part.error));
    assert.equal(inspectCombinedResponse(`<think>${valid}`).unclosedReasoning, true);
});

test('fullwidth brackets, whitespace and dashes normalize without changing actual field values', () => {
    const fullwidth = valid.replace(/\[--([^\]]+)--\]/g, '【 －－ $1 －－ 】');
    assert.deepEqual(parseCombinedResponse(fullwidth).relationships.关系更新, []);
    assert.ok(inspectCombinedResponse(fullwidth).normalizedMarkers > 0);
    const profile = '［ -- 角色档案开始 -- ］\n[姓名]:甲\n[剧情.0]:原文（保留）\n［ -- 角色档案结束 -- ］';
    const result = parseCombinedResponse(profile + '\n' + fullwidth.replace('【 －－ 档案无变化 －－ 】', ''));
    assert.match(result.blocks[0], /原文（保留）/);
});

test('profiles can appear after both delta sections without being lost', () => {
    const profile = '[--角色档案开始--]\n[姓名]:甲\n[剧情.0]:甲取得证据\n[--角色档案结束--]';
    const response = valid.replace('[--档案无变化--]', '') + '\n' + profile;
    assert.deepEqual(parseCombinedResponse(response).blocks, [profile]);
    assert.ok(parseCombinedParts(response + '\n[--角色档案开始--]').profiles.error);
    assert.ok(parseCombinedParts(response + '\n[--角色档案结束--]').profiles.error);
});

test('complete JSON transport requires explicit profiles and all delta arrays', () => {
    const doc = { 角色档案: [], 时间线: [], 关系更新: [], 删除关系: [] };
    assert.deepEqual(parseCombinedResponse('```json\n' + JSON.stringify(doc) + '\n```').blocks, []);
    assert.equal(inspectCombinedResponse(JSON.stringify(doc)).format, 'json');
    const profile = '[--角色档案开始--]\n[姓名]:甲\n[剧情.0]:甲取得证据\n[--角色档案结束--]';
    assert.deepEqual(parseCombinedResponse(JSON.stringify({ ...doc, 角色档案: [profile] })).blocks, [profile]);
    assert.ok(parseCombinedParts(JSON.stringify({ 时间线: [], 关系更新: [], 删除关系: [] })).profiles.error);
    assert.ok(parseCombinedParts(JSON.stringify({ ...doc, 角色档案: null })).profiles.error);
    assert.ok(parseCombinedParts(JSON.stringify({ ...doc, 角色档案: ['普通文字'] })).profiles.error);
    assert.ok(parseCombinedParts(JSON.stringify({ 角色档案: [] })).timeline.error);
    assert.ok(parseCombinedParts(JSON.stringify({ 角色档案: [] })).relationships.error);
});

test('duplicate/reversed delimiters and nonprotocol replies stay failed', () => {
    assert.ok(parseCombinedParts(valid + valid).timeline.error);
    const reversed = valid.replace('[--时间线增量开始--]', '[--时间线增量结束--]').replace('[--时间线增量结束--]\n[--关系', '[--时间线增量开始--]\n[--关系');
    assert.ok(parseCombinedParts(reversed).timeline.error);
    for (const response of ['', '普通剧情回复', '[object Object]', '```json\n{"时间线":[]']) {
        assert.ok(Object.values(parseCombinedParts(response)).every(part => part.error));
    }
    const conflicting = valid.replace('[--档案无变化--]', '[--档案无变化--]\n[--角色档案开始--]\n[姓名]:甲\n[--角色档案结束--]');
    assert.ok(parseCombinedParts(conflicting).profiles.error);
});

test('structural diagnostics contain no response text or character data', () => {
    const secret = 'PRIVATE_CHARACTER_AND_CONTENT';
    const diagnostics = inspectCombinedResponse(secret + valid);
    assert.equal(diagnostics.responseCharacters, secret.length + valid.length);
    assert.ok(!JSON.stringify(diagnostics).includes(secret));
});
