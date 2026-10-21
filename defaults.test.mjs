import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cwbCompleteDefaultSettings, ensureProfilePromptRules, migrateBuiltinProfilePrompt, PROFILE_PROMPT_RULE_MARKER, DEFAULT_TIMELINE_INCREMENTAL_PROMPT, ensureTimelinePromptRules, TIMELINE_PROMPT_RULE_MARKER } from './defaults.js';

test('full and incremental defaults request the expanded profile fields and detailed key events', () => {
    for (const prompt of [cwbCompleteDefaultSettings.cwb_char_card_prompt, cwbCompleteDefaultSettings.cwb_incremental_char_card_prompt]) {
        assert.ok(prompt.includes(PROFILE_PROMPT_RULE_MARKER));
        assert.match(prompt, /角色已知信息\.N.*角色未知信息\.N.*性经历人员\.N.*性经历人数.*额外补充\.N.*剧情\.N/s);
        assert.match(prompt, /强力推动或改变主线/);
        assert.match(prompt, /64个汉字/);
        assert.match(prompt, /严禁记录任何任务或系统相关内容/);
    }
});

test('saved custom prompts retain their text and receive the current mandatory profile rules once', () => {
    const old = '自定义提示词：整理角色信息';
    const updated = ensureProfilePromptRules(old);
    assert.ok(updated.startsWith(old));
    assert.ok(updated.includes('强力推动或改变主线'));
    assert.equal(ensureProfilePromptRules(updated), updated);
});

test('old mandatory profile rules are replaced instead of stacked on saved prompts', () => {
    const old = '自定义提示词：整理角色信息\n\n【CWB角色档案强相关筛选规则 v0.10.4】\n旧规则只允许姓名和剧情。即使其他提示词要求保留更多字段，也必须遵守本规则。\n用户追加的补充要求。';
    const updated = ensureProfilePromptRules(old);
    assert.ok(updated.startsWith('自定义提示词：整理角色信息'));
    assert.ok(updated.includes('用户追加的补充要求。'));
    assert.doesNotMatch(updated, /旧规则只允许姓名和剧情/);
    assert.equal((updated.match(/【CWB角色档案/g) ?? []).length, 1);
    assert.match(updated, /角色未知信息/);
});

test('previous built-in profile prompts upgrade to the expanded defaults', () => {
    const old = '从给定聊天整理角色与主角的个人关键剧情档案，不输出其他资料。\n[--角色档案开始--]\n[档案类型]:角色或主角\n[姓名]:实际姓名\n[剧情.0]:关键剧情\n[--角色档案结束--]\n上面是唯一允许的档案字段；无符合强相关标准的新剧情则输出[--档案无变化--]。主角与其他角色使用相同格式。\n\n【CWB角色档案强相关筛选规则 v0.10.4】\n旧规则正文。';
    assert.equal(migrateBuiltinProfilePrompt(old, 'fullPrompt'), cwbCompleteDefaultSettings.cwb_char_card_prompt);
});

test('saved timeline prompts replace old rules with longer events and exclude task/system content', () => {
    const old = '旧自定义时间线提示词\n\n【CWB时间线格式规则 v0.10.8】\n事件正文不超过28个汉字。';
    const updated = ensureTimelinePromptRules(old);
    assert.ok(updated.startsWith('旧自定义时间线提示词'));
    assert.doesNotMatch(updated, /不超过28个汉字/);
    assert.ok(updated.includes(TIMELINE_PROMPT_RULE_MARKER));
    assert.match(updated, /同一天仅将属于同一故事线的关键进展合并为一条/);
    assert.match(updated, /不得单独列出出场角色/);
    assert.match(updated, /40—56个汉字/);
    assert.match(updated, /完整姓名.*不用简称、缩写/);
    assert.match(updated, /任务.*系统.*不得.*时间线/s);
    assert.match(updated, /无因果关联的故事线不要揉在一起/s);
    assert.match(updated, /不得仅因日期相同.*无关事件/s);
    assert.equal(ensureTimelinePromptRules(updated), updated);
    assert.ok(DEFAULT_TIMELINE_INCREMENTAL_PROMPT.includes(TIMELINE_PROMPT_RULE_MARKER));
});
