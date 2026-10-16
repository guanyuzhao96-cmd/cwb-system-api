import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeProfileContent, hasProfileFacts, PROFILE_RULES } from './profile-utils.mjs';

test('profile sanitizer removes numeric stats and relationship fields while preserving useful facts', () => {
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
    assert.match(cleaned, /正在隐瞒与赵冠宇的关系/);
    assert.match(cleaned, /已经发现赵冠宇在说谎/);
    assert.match(cleaned, /保存着关键聊天记录/);
    assert.match(cleaned, /发现赵冠宇说谎并保存证据/);
    assert.doesNotMatch(cleaned, /好感|性经历人数|与主角次数|人际关系|后宫成员|情侣|闺蜜/);
    assert.equal(hasProfileFacts(cleaned), true);
});

test('profile rules prohibit stat-only and relationship-only profile updates', () => {
    assert.match(PROFILE_RULES, /仅数值变化或仅关系标签变化的角色不输出档案/);
    assert.match(PROFILE_RULES, /关系.*不得再列人际关系或关系表/);
    assert.equal(sanitizeProfileContent('[--角色档案开始--]\n[姓名]:甲\n[好感度]:80\n[--角色档案结束--]'), '[--角色档案开始--]\n[档案类型]:角色\n[姓名]:甲\n[--角色档案结束--]');
});
