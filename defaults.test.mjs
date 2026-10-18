import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cwbCompleteDefaultSettings, ensureProfilePromptRules, migrateBuiltinProfilePrompt, PROFILE_PROMPT_RULE_MARKER, DEFAULT_TIMELINE_INCREMENTAL_PROMPT, ensureTimelinePromptRules, TIMELINE_PROMPT_RULE_MARKER } from './defaults.js';

test('full and incremental defaults request the expanded profile fields and detailed key events', () => {
    for (const prompt of [cwbCompleteDefaultSettings.cwb_char_card_prompt, cwbCompleteDefaultSettings.cwb_incremental_char_card_prompt]) {
        assert.ok(prompt.includes(PROFILE_PROMPT_RULE_MARKER));
        assert.match(prompt, /角色已知信息\.0.*角色未知信息\.0.*性经历人员\].*性经历人数.*额外补充\.0.*剧情\.0/s);
        assert.match(prompt, /【总纲｜.*【角色已知信息｜.*【角色未知信息｜.*【性经历人员与人数｜.*【剧情｜/s);
        assert.match(prompt, /每条最多128字/);
        assert.match(prompt, /任务.*系统.*任何栏目/s);
        assert.match(prompt, /角色已知信息/);
    }
    assert.match(cwbCompleteDefaultSettings.cwb_incremental_char_card_prompt, /完整最终快照.*禁止只输出增量片段/s);
    assert.match(cwbCompleteDefaultSettings.cwb_incremental_char_card_prompt, /旧档案4人.*最终为5人.*旧档案4\+人.*最终为5\+/s);
    assert.match(cwbCompleteDefaultSettings.cwb_incremental_char_card_prompt, /不得只选最近一两件.*不得漏掉/s);
    assert.match(cwbCompleteDefaultSettings.cwb_incremental_char_card_prompt, /有效的.*剧情全部保留/);
    assert.match(cwbCompleteDefaultSettings.cwb_incremental_char_card_prompt, /剧情默认只增不删/);
    assert.match(cwbCompleteDefaultSettings.cwb_incremental_char_card_prompt, /旧剧情条数不得减少/);
    assert.match(cwbCompleteDefaultSettings.cwb_incremental_char_card_prompt, /后续变化作为新事件追加，不能覆盖前情/);
});

test('known information stores event implications, not event logs, with evidence-bounded inference', () => {
    assert.match(PROFILE_PROMPT_RULE_MARKER, /v0\.12\.22/);
    assert.match(cwbCompleteDefaultSettings.cwb_char_card_prompt, /已知信息写关键事件背后的认知、态度、意愿或关系结论，不写事件流水/);
    assert.match(cwbCompleteDefaultSettings.cwb_incremental_char_card_prompt, /普通事实、单次情绪\/反应、临时偏好/);
    assert.match(cwbCompleteDefaultSettings.cwb_incremental_char_card_prompt, /一次含义不明的行为不得夸大为稳定偏好/);
    assert.match(cwbCompleteDefaultSettings.cwb_char_card_prompt, /若删除这条信息，不会改变.*就不要记录/);
    assert.match(cwbCompleteDefaultSettings.cwb_incremental_char_card_prompt, /重要性或持续影响不明确时，宁可省略/);
});

test('saved custom prompts retain their text and receive the current mandatory profile rules once', () => {
    const old = '自定义提示词：整理角色信息';
    const updated = ensureProfilePromptRules(old);
    assert.ok(updated.startsWith(old));
    assert.ok(updated.includes('【角色已知信息｜记角色从事件中形成的结论】'));
    assert.equal(ensureProfilePromptRules(updated), updated);
    const appended = ensureProfilePromptRules(`${updated}\n用户追加要求：保留角色设定中的别名`);
    assert.ok(appended.includes('用户追加要求：保留角色设定中的别名'));
    assert.match(appended, /逐条原文保留全部旧剧情/);
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

test('v0.12.9 built-in profile prompts upgrade without replacing user-customized prompts', () => {
    const currentRules = '【CWB角色档案整理规则 v0.12.9】\n旧规则。即使其他提示词要求保留更多字段，也必须遵守本规则。';
    const oldIncremental = `融合旧档案与新对话，更新角色已知/未知信息、成年性经历对象及去重人数。旧内置内容。\n\n${currentRules}`;
    const oldFull = `从给定聊天整理角色与主角的个人档案：已知信息要从关键事件中提炼旧内置内容。\n\n${currentRules}`;
    assert.equal(migrateBuiltinProfilePrompt(oldIncremental, 'incrementalPrompt'), cwbCompleteDefaultSettings.cwb_incremental_char_card_prompt);
    assert.equal(migrateBuiltinProfilePrompt(oldFull, 'fullPrompt'), cwbCompleteDefaultSettings.cwb_char_card_prompt);
    assert.notEqual(migrateBuiltinProfilePrompt(`${oldIncremental}\n用户自定义附加要求`, 'incrementalPrompt'), cwbCompleteDefaultSettings.cwb_incremental_char_card_prompt);
});

test('v0.12.11 built-in prompts receive the stricter relevance gate while custom additions survive', () => {
    const oldFull = cwbCompleteDefaultSettings.cwb_char_card_prompt
        .replace(PROFILE_PROMPT_RULE_MARKER, '【CWB角色档案整理规则 v0.12.11】');
    const oldIncremental = cwbCompleteDefaultSettings.cwb_incremental_char_card_prompt
        .replace(PROFILE_PROMPT_RULE_MARKER, '【CWB角色档案整理规则 v0.12.11】');
    assert.equal(migrateBuiltinProfilePrompt(oldFull, 'fullPrompt'), cwbCompleteDefaultSettings.cwb_char_card_prompt);
    assert.equal(migrateBuiltinProfilePrompt(oldIncremental, 'incrementalPrompt'), cwbCompleteDefaultSettings.cwb_incremental_char_card_prompt);
    assert.notEqual(migrateBuiltinProfilePrompt(`${oldIncremental}\n用户自定义附加要求`, 'incrementalPrompt'), cwbCompleteDefaultSettings.cwb_incremental_char_card_prompt);
});

test('saved timeline prompts replace old rules with concise timeline rules', () => {
    const old = '旧自定义时间线提示词\n\n【CWB时间线格式规则 v0.10.8】\n事件正文不超过28个汉字。';
    const updated = ensureTimelinePromptRules(old);
    assert.ok(updated.startsWith('旧自定义时间线提示词'));
    assert.doesNotMatch(updated, /不超过28个汉字/);
    assert.ok(updated.includes(TIMELINE_PROMPT_RULE_MARKER));
    assert.match(updated, /仅合并同一故事线中有因果关系的事件/);
    assert.match(updated, /不因日期相同合并无关事件/);
    assert.match(updated, /姓名用可确认的全名/);
    assert.match(updated, /任务\/系统\/操作信息省略/);
    assert.match(updated, /已有事件仅在实质变化或出现新结果时更新/);
    assert.doesNotMatch(updated, /40—56个汉字/);
    assert.equal(ensureTimelinePromptRules(updated), updated);
    assert.ok(DEFAULT_TIMELINE_INCREMENTAL_PROMPT.includes(TIMELINE_PROMPT_RULE_MARKER));
});

test('previous built-in timeline prompt migrates and retains user additions', () => {
    const old = `你是主线时间线的增量整理器。本次是独立的时间线请求，不生成角色档案，不续写故事。\n旧版较长的内置规则。不得只回复“已更新”或重复已有时间线。\n用户追加：仅在测试中保留。\n\n【CWB时间线格式规则 v0.11.0】\n旧规则`;
    const migrated = ensureTimelinePromptRules(old);
    assert.match(migrated, /只处理【本次新增聊天】/);
    assert.match(migrated, /用户追加：仅在测试中保留/);
    assert.doesNotMatch(migrated, /旧版较长的内置规则|旧规则/);
    assert.equal((migrated.match(/【CWB时间线格式规则/g) ?? []).length, 1);
});
