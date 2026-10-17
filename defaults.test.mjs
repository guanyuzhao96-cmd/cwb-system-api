import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cwbCompleteDefaultSettings, ensureProfilePromptRules, PROFILE_PROMPT_RULE_MARKER, DEFAULT_TIMELINE_INCREMENTAL_PROMPT, ensureTimelinePromptRules, TIMELINE_PROMPT_RULE_MARKER } from './defaults.js';

test('full and incremental defaults explicitly request only strongly plot-relevant personal events', () => {
    for (const prompt of [cwbCompleteDefaultSettings.cwb_char_card_prompt, cwbCompleteDefaultSettings.cwb_incremental_char_card_prompt]) {
        assert.ok(prompt.includes(PROFILE_PROMPT_RULE_MARKER));
        assert.match(prompt, /只允许“档案类型”“姓名”和“剧情\.N”字段/);
        assert.match(prompt, /强力推动或改变主线/);
    }
});

test('saved custom prompts retain their text and receive the current mandatory profile rules once', () => {
    const old = '自定义提示词：整理角色信息';
    const updated = ensureProfilePromptRules(old);
    assert.ok(updated.startsWith(old));
    assert.ok(updated.includes('强力推动或改变主线'));
    assert.equal(ensureProfilePromptRules(updated), updated);
});

test('saved timeline prompts replace old rules with longer events and exclude task/system content', () => {
    const old = '旧自定义时间线提示词\n\n【CWB时间线格式规则 v0.10.5】\n事件正文不超过28个汉字。';
    const updated = ensureTimelinePromptRules(old);
    assert.ok(updated.startsWith('旧自定义时间线提示词'));
    assert.doesNotMatch(updated, /不超过28个汉字/);
    assert.ok(updated.includes(TIMELINE_PROMPT_RULE_MARKER));
    assert.match(updated, /同一天仅将属于同一故事线的关键进展合并为一条/);
    assert.match(updated, /不得单独列出出场角色/);
    assert.match(updated, /40—56个汉字/);
    assert.match(updated, /任务.*系统.*不得.*时间线/s);
    assert.match(updated, /无因果关联的故事线不要揉在一起/s);
    assert.match(updated, /不得仅因日期相同.*无关事件/s);
    assert.equal(ensureTimelinePromptRules(updated), updated);
    assert.ok(DEFAULT_TIMELINE_INCREMENTAL_PROMPT.includes(TIMELINE_PROMPT_RULE_MARKER));
});
