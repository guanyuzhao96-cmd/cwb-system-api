import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCombinedParts, outputProtocolFor, combinedGuidance } from './combined-response.mjs';
import { DEFAULT_TIMELINE_INCREMENTAL_PROMPT } from './defaults.js';
import { RELATIONSHIP_PROMPT } from './relationship-utils.mjs';

const profile = '[--角色档案开始--]\n[档案类型]:主角\n[姓名]:主角\n[剧情.0]:2025-09-02｜确认重要约定并影响后续安排\n[--角色档案结束--]';
const timeline = '[--时间线增量开始--]\n{"时间线":[]}\n[--时间线增量结束--]';
const relation = '[--关系增量开始--]\n{"关系更新":[],"删除关系":[]}\n[--关系增量结束--]';

test('profile-only requests require no unrelated sections', () => {
    const prompt = outputProtocolFor(['profiles']);
    assert.match(prompt, /CWB档案专用输出协议/);
    assert.ok(!prompt.includes('[--时间线增量开始--]'));
    assert.ok(!prompt.includes('[--关系增量开始--]'));
    assert.equal(parseCombinedParts(profile).profiles.value.length, 1);
});
test('no-change marker is recognized after other modules', () => {
    assert.deepEqual(parseCombinedParts(timeline + '\n' + relation + '\n[--档案无变化--]').profiles.value, []);
});
test('profiles after timeline are not falsely classified as truncated', () => {
    assert.equal(parseCombinedParts(timeline + '\n' + profile + '\n' + relation).profiles.value.length, 1);
});
test('exact natural-language no-change reply is accepted', () => {
    assert.deepEqual(parseCombinedParts('本次没有角色档案变化。').profiles.value, []);
});
test('missing, narrative, and truncated profiles remain failures', () => {
    for (const reply of ['', timeline, '已更新', '本次没有角色档案变化，但主角有新变化', profile.replace('[--角色档案结束--]', ''), '[--角色档案结束--]']) {
        assert.ok(parseCombinedParts(reply).profiles.error, reply);
    }
});
test('combined timeline guidance no longer forbids profiles', () => {
    const prompt = combinedGuidance(DEFAULT_TIMELINE_INCREMENTAL_PROMPT);
    assert.ok(!prompt.includes('本次是独立的时间线请求'));
    assert.ok(!prompt.includes('不生成角色档案'));
    assert.ok(!prompt.includes('只输出合法 JSON：'));
    assert.match(prompt, /40—56个汉字/);
});
test('combined relation guidance no longer requires exclusively JSON', () => {
    const prompt = combinedGuidance(RELATIONSHIP_PROMPT);
    assert.ok(!prompt.includes('严格输出JSON：'));
    assert.match(prompt, /双向用↔，单向用→/);
});
test('custom guidance is preserved', () => {
    assert.equal(combinedGuidance('保留重要约定；这是自定义规则。'), '保留重要约定；这是自定义规则。');
});
test('two selected modules omit the unselected output', () => {
    const prompt = outputProtocolFor(['timeline', 'relationships']);
    assert.ok(!prompt.includes('[--角色档案开始--]'));
    assert.ok(prompt.includes('[--时间线增量开始--]'));
    assert.ok(prompt.includes('[--关系增量开始--]'));
});
