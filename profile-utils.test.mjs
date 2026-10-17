import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeProfileContent, hasProfileFacts, PROFILE_RULES } from './profile-utils.mjs';

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
    assert.match(cleaned, /性经历人数]:1/);
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
