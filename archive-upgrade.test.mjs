import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upgradeArchiveContent, LEGACY_RELATIONSHIP_NOTES } from './archive-upgrade.mjs';
import { readProfilePlotEvents } from './profile-utils.mjs';
import { parseCustomFormat } from './utils.js';
import { mergeRelationships } from './relationship-utils.mjs';

test('profile conversion preserves nested old fields, multiline history and unknown prose', () => {
    const entry = { comment: '动态-角色甲', content: '[--Amily2::CHAR_START--]\n[core_identity.name]:角色甲\n[physical_imprint.key_features]:左手有旧伤\n[性经历人数]:4+\n[剧情.0]:2025-09-01｜甲发现证据\n证据影响了之后的选择\n[剧情.0]:2025-09-02｜甲向同伴说明事实\n[--Amily2::CHAR_END--]' };
    const after = upgradeArchiveContent(entry, 'CWB:自动档案');
    const parsed = parseCustomFormat(after);
    assert.equal(parsed.姓名, '角色甲');
    assert.equal(parsed.性经历人数, '4+');
    assert.ok(parsed.额外补充.some(item => item.includes('physical_imprint.key_features') && item.includes('左手有旧伤')));
    assert.equal(readProfilePlotEvents(after).length, 2);
    assert.match(after, /证据影响了之后的选择/);
    assert.equal(upgradeArchiveContent({ ...entry, content: after }, 'CWB:自动档案'), after);
    const prose = upgradeArchiveContent({ comment: '动态-角色甲', content: '她保留了一封尚未寄出的信。' }, 'CWB:自动档案');
    assert.match(prose, /她保留了一封尚未寄出的信/);
    assert.throws(() => upgradeArchiveContent({ content: '没有姓名的原资料' }, 'CWB:自动档案'), /无法确认角色姓名/);
});

test('JSON profiles convert all named fields without invoking a model', () => {
    const content = JSON.stringify({ name: '角色乙', CI: { age: 21 }, known_info: ['已确认事实'], 剧情: ['日期未知｜一件往事'], 未知扩展: { flag: true } });
    const after = upgradeArchiveContent({ content }, 'CWB:主角档案');
    const parsed = parseCustomFormat(after);
    assert.equal(parsed.档案类型, '主角');
    assert.deepEqual(parsed.角色已知信息, ['已确认事实']);
    assert.match(after, /CI.age.*21/);
    assert.match(after, /未知扩展.flag.*true/);
    assert.match(after, /一件往事/);
});

test('timeline upgrade keeps every event and is idempotent for grouped dates and JSON', () => {
    const content = JSON.stringify({ 时间线: [{ 日期: '2025-9-1', 人物: '甲', 事件: '甲发现一封信' }, { 日期: '2025-9-1', 事件: '乙决定离开' }] });
    const after = upgradeArchiveContent({ content }, 'CWB:故事时间线');
    assert.match(after, /「2025.9.1」 1.甲发现一封信/);
    assert.match(after, /2.乙决定离开/);
    assert.equal(upgradeArchiveContent({ content: after }, 'CWB:故事时间线'), after);
    assert.throws(() => upgradeArchiveContent({ content: '{"unknown":[]}' }, 'CWB:故事时间线'), /缺少/);
});

test('relationship conversion preserves undecodable facts through subsequent normal updates', () => {
    const after = upgradeArchiveContent({ content: '甲 <-> 乙: 同班同学\n甲与乙有一段尚未厘清的旧事' }, 'CWB:角色关系汇总');
    assert.match(after, /甲 ↔ 乙：同班同学/);
    assert.ok(after.includes(LEGACY_RELATIONSHIP_NOTES));
    const updated = mergeRelationships(after, JSON.stringify({ 关系更新: [{ 人物A: '甲', 人物B: '乙', 方向: '↔', 关系: '朋友' }], 删除关系: [] }));
    assert.match(updated, /尚未厘清的旧事/);
    assert.match(updated, /甲 ↔ 乙：朋友/);
    assert.equal(upgradeArchiveContent({ content: after }, 'CWB:角色关系汇总'), after);
});

test('directories and rosters retain their entire payload while normalizing wrappers', () => {
    const cases = [
        ['CWB:角色档案目录', '【角色档案目录】\n[角色甲] → 世界书《支线》中的「动态-角色甲」', '【当前角色卡档案目录】'],
        ['CWB:世界书目录', '【世界书目录】\nname: “角色甲”\n需要保留的备注', '【小故事线目录】'],
        ['Amily2角色总集', '【登场角色】\n[角色甲: (详细查看绿灯角色条目)]\n【前120楼角色世界书已更新完成】', '【角色总览】'],
    ];
    for (const [marker, content, header] of cases) {
        const after = upgradeArchiveContent({ content }, marker);
        assert.ok(after.startsWith(header));
        assert.ok(after.includes('角色甲'));
        assert.equal(upgradeArchiveContent({ content: after }, marker), after);
    }
    assert.match(upgradeArchiveContent({ content: cases[1][1] }, cases[1][0]), /需要保留的备注/);
});
