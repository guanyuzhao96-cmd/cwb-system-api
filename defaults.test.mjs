import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cwbCompleteDefaultSettings, ensureProfilePromptRules, PROFILE_PROMPT_RULE_MARKER } from './defaults.js';

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
