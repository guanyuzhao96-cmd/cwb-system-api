import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeProfileContent, hasProfileFacts, PROFILE_RULES } from './profile-utils.mjs';

test('profile sanitizer keeps only personal key plot and removes all other fields', () => {
    const source = `[--角色档案开始--]
[档案类型]:角色
[姓名]:林思雨
[当前状态]:好感度：80；正在隐瞒与赵冠宇的关系
[角色已知信息]:已经发现赵冠宇在说谎
[长期目标]:保护自己
[好感度]:80
[性经历人数]:3
[与主角次数]:12
[人际关系.0]:许亦宁｜闺蜜
[后宫成员.0]:林思雨
[重要物品.0]:旧手机｜保存着关键聊天记录
[已解锁能力.0]:无
[剧情.0]:2025-10-01｜发现赵冠宇说谎并保存证据
[--角色档案结束--]`;
    const cleaned = sanitizeProfileContent(source);
    assert.ok(cleaned);
    assert.match(cleaned, /发现赵冠宇说谎并保存证据/);
    assert.doesNotMatch(cleaned, /当前状态|角色已知信息|长期目标|好感|性经历人数|与主角次数|人际关系|后宫成员|重要物品|已解锁能力/);
    assert.equal(hasProfileFacts(cleaned), true);
});

test('profile rules require strong plot relevance and omit unrelated events', () => {
    assert.match(PROFILE_RULES, /只允许“档案类型”“姓名”和“剧情\.N”字段/);
    assert.match(PROFILE_RULES, /强力推动或改变主线/);
    assert.match(PROFILE_RULES, /仅被提及、与主线联系弱、无后续影响的事件不得记录/);
    assert.equal(sanitizeProfileContent('[--角色档案开始--]\n[姓名]:甲\n[好感度]:80\n[--角色档案结束--]'), '[--角色档案开始--]\n[档案类型]:角色\n[姓名]:甲\n[--角色档案结束--]');
    assert.equal(hasProfileFacts('[--角色档案开始--]\n[姓名]:甲\n[当前状态]:日常上课\n[--角色档案结束--]'), false);
});
