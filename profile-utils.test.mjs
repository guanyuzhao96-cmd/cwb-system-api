import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeProfileContent, reconcileProfileExperienceCount, hasProfileFacts, PROFILE_RULES } from './profile-utils.mjs';

test('profile sanitizer preserves the requested factual fields and removes unrelated data', () => {
    const source = `[--角色档案开始--]
[档案类型]:角色
[姓名]:林思雨
[当前状态]:好感度：80；正在隐瞒与赵冠宇的关系
[角色已知信息.0]:已经发现赵冠宇在说谎
[角色未知信息.0]:赵冠宇仍不知道证据已被保存
[性经历人员.0]:林思雨
[性经历人员.1]:林思雨
[性经历人数]:1
[额外补充.0]:证据保存在旧手机中
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
    assert.match(cleaned, /角色已知信息\.0/);
    assert.match(cleaned, /角色未知信息\.0/);
    assert.match(cleaned, /性经历人员\.0/);
    assert.match(cleaned, /性经历人数]:3/, 'total count is not recalculated from a partial names list');
    assert.match(cleaned, /额外补充\.0/);
    assert.doesNotMatch(cleaned, /当前状态|长期目标|好感|与主角次数|人际关系|后宫成员|重要物品|已解锁能力/);
    assert.match(cleaned, /性经历人员\.0]:林思雨/);
    assert.doesNotMatch(cleaned, /性经历人员\.1/, 'duplicate partners are deduplicated');
    assert.equal(hasProfileFacts(cleaned), true);
});

test('profile rules require strong plot relevance and omit unrelated events', () => {
    assert.match(PROFILE_RULES, /角色已知信息\.N.*角色未知信息\.N.*性经历人员\.N.*性经历人数.*额外补充\.N.*剧情\.N/s);
    assert.match(PROFILE_RULES, /强力推动或改变主线/);
    assert.match(PROFILE_RULES, /仅被提及、与主线联系弱、无后续影响的事件不得记录/);
    assert.match(PROFILE_RULES, /每条不超过64个汉字/);
    assert.match(PROFILE_RULES, /未成年或年龄不明一律省略/);
    assert.match(PROFILE_RULES, /已确认成年对象去重计数/);
    assert.equal(sanitizeProfileContent('[--角色档案开始--]\n[姓名]:甲\n[好感度]:80\n[--角色档案结束--]'), '[--角色档案开始--]\n[档案类型]:角色\n[姓名]:甲\n[--角色档案结束--]');
    assert.equal(hasProfileFacts('[--角色档案开始--]\n[姓名]:甲\n[当前状态]:日常上课\n[--角色档案结束--]'), false);
    assert.equal(hasProfileFacts('[--角色档案开始--]\n[姓名]:甲\n[角色已知信息.0]:得知关键秘密\n[--角色档案结束--]'), true);
});

test('profile sanitizer removes task and system content from every allowed field', () => {
    const source = `[--角色档案开始--]
[姓名]:甲
[角色已知信息.0]:发现关键证据并决定离开
[角色已知信息.1]:系统提示任务完成，获得奖励
[角色未知信息.0]:同伴背叛计划已被系统标记
[性经历人员.0]:乙
[额外补充.0]:普通日常喝咖啡；系统面板显示积分100
[剧情.0]:揭露关键秘密，导致盟友关系破裂
[剧情.1]:完成支线任务并领取系统奖励
[--角色档案结束--]`;
    const cleaned = sanitizeProfileContent(source);
    assert.match(cleaned, /发现关键证据并决定离开/);
    assert.match(cleaned, /揭露关键秘密，导致盟友关系破裂/);
    assert.doesNotMatch(cleaned, /任务|系统|奖励|积分|普通日常/);
});

test('profile rules explicitly restrict known and unknown facts to plot-critical information', () => {
    assert.match(PROFILE_RULES, /已知信息.*未知信息.*主线剧情强相关/s);
    assert.match(PROFILE_RULES, /普通日常.*即使真实也不记录/);
    assert.match(PROFILE_RULES, /严禁记录任何任务或系统相关内容/);
});

test('sanitizing a profile never replaces the stored experience total with list length', () => {
    const cleaned = sanitizeProfileContent('[--角色档案开始--]\n[姓名]:甲\n[性经历人员.0]:乙\n[性经历人数]:7\n[--角色档案结束--]');
    assert.match(cleaned, /性经历人数]:7/);
    assert.match(cleaned, /性经历人员\.0]:乙/);
});

test('incremental experience count adds only newly named people to the old baseline', () => {
    const oldProfile = '[--角色档案开始--]\n[档案类型]:角色\n[姓名]:甲\n[性经历人员.0]:乙\n[性经历人数]:5\n[--角色档案结束--]';
    const incremental = '[--角色档案开始--]\n[档案类型]:角色\n[姓名]:甲\n[性经历人员.0]:丙\n[性经历人员.1]:丙\n[性经历人数]:99\n[剧情.0]:确认与丙发生关系\n[--角色档案结束--]';
    const reconciled = reconcileProfileExperienceCount(incremental, [oldProfile]);
    assert.match(reconciled, /性经历人数]:6/);
    assert.match(reconciled, /性经历人员\.0]:乙/);
    assert.match(reconciled, /性经历人员\.1]:丙/);
    assert.doesNotMatch(reconciled, /性经历人员\.2/);
});

test('incremental experience count does not increment for an already known partner', () => {
    const oldProfile = '[--角色档案开始--]\n[姓名]:甲\n[性经历人员.0]:乙\n[性经历人数]:5\n[--角色档案结束--]';
    const incremental = '[--角色档案开始--]\n[姓名]:甲\n[性经历人员.0]:乙\n[性经历人数]:6\n[--角色档案结束--]';
    const reconciled = reconcileProfileExperienceCount(incremental, [oldProfile]);
    assert.match(reconciled, /性经历人数]:5/);
    assert.equal((reconciled.match(/\[性经历人员\.\d+\]/g) ?? []).length, 1);
});
