import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeProfileContent, reconcileProfileExperienceCount, replaceProfilePlot, hasProfileFacts, PROFILE_RULES } from './profile-utils.mjs';

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
    assert.match(PROFILE_RULES, /【总纲｜.*【角色已知信息｜.*【角色未知信息｜.*【性经历人员与人数｜.*【额外补充｜.*【剧情｜/s);
    assert.match(PROFILE_RULES, /只记录角色已确知、且对后续剧情有实质影响的结论/);
    assert.match(PROFILE_RULES, /删除这条信息，不会改变.*就不要记录/);
    assert.match(PROFILE_RULES, /普通事实、单次情绪\/反应、临时偏好.*一律省略/);
    assert.match(PROFILE_RULES, /揭露会实质改变重要选择、核心关系、重大冲突或主线走向/);
    assert.match(PROFILE_RULES, /若角色得知后不会改变其行动、关系或关键剧情，就不要记录/);
    assert.match(PROFILE_RULES, /未成年、年龄不明.*一律不记/);
    assert.match(PROFILE_RULES, /旧档案人数\+本轮新确认/);
    assert.match(PROFILE_RULES, /旧档案4人.*结果必须为5人/);
    assert.match(PROFILE_RULES, /完整最终档案快照，不得只输出变化片段/);
    assert.match(PROFILE_RULES, /不得只选最近一两件.*不得漏掉/s);
    assert.match(PROFILE_RULES, /每条最多128字/);
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
    assert.match(PROFILE_RULES, /【角色已知信息｜.*【角色未知信息｜/s);
    assert.match(PROFILE_RULES, /普通日常、闲聊.*省略/);
    assert.match(PROFILE_RULES, /任何情况下都不得写入角色档案任何栏目/);
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

test('incremental experience count deduplicates an existing partner when relationship details change', () => {
    const oldProfile = '[--角色档案开始--]\n[姓名]:甲\n[性经历人员.0]:乙｜旧关系状态\n[性经历人数]:4\n[--角色档案结束--]';
    const incremental = '[--角色档案开始--]\n[姓名]:甲\n[性经历人员.0]:乙｜已确认性交\n[性经历人数]:5\n[剧情.0]:关系状态变化\n[--角色档案结束--]';
    const reconciled = reconcileProfileExperienceCount(incremental, [oldProfile]);
    assert.match(reconciled, /性经历人数]:4/);
    assert.match(reconciled, /性经历人员\.0]:乙｜旧关系状态；已确认性交/);
    assert.doesNotMatch(reconciled, /性经历人员\.1/);
});

test('profile sanitizer splits comma-separated facts but keeps whole plot events and one partner row', () => {
    const source = `[--角色档案开始--]\n[姓名]:甲\n[角色已知信息.0]:她信任乙，愿意和乙维持秘密关系\n[性经历人员.0]:乙｜旧关系\n[性经历人员.1]:乙｜新关系\n[剧情.0]:2025-09-01｜她主动隐瞒关系，并在关键冲突中保护乙。\n[--角色档案结束--]`;
    const cleaned = sanitizeProfileContent(source);
    assert.match(cleaned, /角色已知信息\.0]:她信任乙/);
    assert.match(cleaned, /角色已知信息\.1]:愿意和乙维持秘密关系/);
    assert.match(cleaned, /性经历人员\.0]:乙｜旧关系；新关系/);
    assert.doesNotMatch(cleaned, /性经历人员\.1/);
    assert.match(cleaned, /剧情\.0]:2025-09-01｜她主动隐瞒关系，并在关键冲突中保护乙。/);
});

test('plot compaction changes only the plot field and rejects unsafe output', () => {
    const source = `[--角色档案开始--]\n[档案类型]:角色\n[姓名]:甲\n[角色已知信息.0]:持续信任乙\n[性经历人员.0]:乙｜关系状态\n[性经历人数]:1\n[剧情.0]:2025-09-01｜日常吃饭\n[剧情.1]:2025-09-01｜乙揭露秘密，甲因此与丙决裂\n[--角色档案结束--]`;
    const compacted = replaceProfilePlot(source, ['2025-09-01｜乙揭露秘密，导致甲与丙决裂并改变后续合作']);
    assert.match(compacted, /\[角色已知信息\.0\]:持续信任乙/);
    assert.match(compacted, /\[性经历人数\]:1/);
    assert.doesNotMatch(compacted, /日常吃饭/);
    assert.match(compacted, /导致甲与丙决裂/);
    assert.throws(() => replaceProfilePlot(source, ['x'.repeat(129)]), /超过128字/);
    assert.throws(() => replaceProfilePlot(source, 'not a list'), /字符串列表/);
});
