import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const supported = { skip: !vm.SourceTextModule && 'Requires --experimental-vm-modules' };
const owner = 'CWB:角色卡:card.png';
const profile = events => `[--角色档案开始--]\n[姓名]:角色甲\n${events.map((event, index) => `[剧情.${index}]:${event}`).join('\n')}\n[--角色档案结束--]`;
const oldEvent = '2025-09-01｜甲发现身份被隐瞒，决定停止合作';
const newEvent = '2025-09-03｜甲取得关键证据，向同伴揭露真相';
const response = content => `${content}\n[--时间线增量开始--]\n{"时间线":[]}\n[--时间线增量结束--]\n[--关系增量开始--]\n{"关系更新":[],"删除关系":[]}\n[--关系增量结束--]`;

async function harness(events = [oldEvent]) {
    let disk = { entries: {
        1: { uid: 1, key: ['CWB:自动档案', owner, '角色甲'], comment: '动态-角色甲', disable: false, content: profile(events) },
        9: { uid: 9, key: ['原始设定'], content: '手工资料保留' },
    } };
    // Deliberately stale and never updated on writes. Any cache-based whole-book
    // write would erase the latest profile and the manual entry on the server.
    const cache = { entries: {} };
    const requests = [], modules = new Map();
    const contextData = { mainApi: 'openai', chatId: 'history-chat', chatMetadata: { integrity: 'history-identity' },
        characterId: 0, name1: '主角', name2: '测试角色卡',
        characters: [{ name: '测试角色卡', avatar: 'card.png', data: { extensions: { world: '主世界书' } } }],
        chat: [{ name: '叙述者', mes: '她终于公开了证据。' }] };
    let duringAI = () => {}, nextResponse = response(profile([newEvent])), readFailures = 0, saveFailure = false;
    const sandbox = vm.createContext({ console, structuredClone, AbortController, setTimeout, clearTimeout,
        window: { toastr: { warning() {}, error() {}, success() {}, info() {} } },
        document: { getElementById: () => null },
        $: () => ({ text() {}, prop() {} }),
        fetch: async () => { if (readFailures > 0) { readFailures--; throw Error('Load failed'); } return { ok: true, json: async () => structuredClone(disk) }; },
    });
    const mocks = {
        '/scripts/tokenizers.js': { getTokenCountAsync: async text => text.length },
        '/script.js': { getRequestHeaders: () => ({}), generateRaw: async options => { requests.push(options); duringAI(); return typeof nextResponse === 'function' ? nextResponse(options) : nextResponse; } },
        '/scripts/extensions.js': { getContext: () => contextData, extension_settings: {} },
        '/scripts/world-info.js': { world_names: ['主世界书'], selected_world_info: [], world_info: {},
            loadWorldInfo: async () => structuredClone(cache),
            saveWorldInfo: async (_, data) => { if (saveFailure) throw Error('Load failed'); disk = structuredClone(data); },
            createWorldInfoEntry: (_, data) => { const uid = Math.max(-1, ...Object.keys(data.entries).map(Number)) + 1; return data.entries[uid] = { uid }; },
        },
    };
    async function load(id) {
        if (modules.has(id)) return modules.get(id);
        const mock = mocks[id];
        const mod = mock ? new vm.SyntheticModule(Object.keys(mock), function () { for (const [key, value] of Object.entries(mock)) this.setExport(key, value); }, { context: sandbox, identifier: id })
            : new vm.SourceTextModule(readFileSync(id, 'utf8'), { context: sandbox, identifier: id,
                importModuleDynamically: async path => {
                    const imported = await load(path);
                    if (imported.status === 'unlinked') await imported.link(() => { throw Error('Unexpected tokenizer dependency'); });
                    if (imported.status === 'linked') await imported.evaluate();
                    return imported;
                },
            });
        modules.set(id, mod);
        return mod;
    }
    const mod = await load(resolve(root, 'core.js'));
    await mod.link((path, parent) => load(path.startsWith('/') ? path : resolve(dirname(parent.identifier), path)));
    await mod.evaluate();
    const settings = { incremental: true, enabled: true, worldbookTarget: 'primary', multiWorldbookRouting: false,
        incrementalPrompt: '更新角色档案', fullPrompt: '整理角色档案', responseLength: 8000 };
    return { core: mod.namespace, lorebook: modules.get(resolve(root, 'lorebook.js')).namespace,
        state: modules.get(resolve(root, 'state.js')).namespace.state, settings, contextData, requests,
        data: () => disk, failReads: count => { readFailures = count; }, failSave: () => { saveFailure = true; },
        duringAI: fn => { duringAI = fn; }, reply: content => { nextResponse = content; } };
}

test('direct format upgrade previews all archive types, creates no backups and is repeatable', supported, async () => {
    const h = await harness();
    const fixtures = [
        ['CWB:主角档案', '[姓名]:主角\n[剧情.0]:旧剧情\n[自定义]:原信息'],
        ['CWB:故事时间线', '2025-09-01｜甲发现真相'],
        ['CWB:角色关系汇总', '甲 -> 乙：同伴\n旧版关系说明'],
        ['CWB:角色档案目录', '角色乙：主世界书'],
        ['Amily2角色总集', '角色乙：旧总览'],
        ['CWB:更新状态', JSON.stringify({ version: 2, modules: { profiles: { completed: [[0, 2], [5, 7]], failed: [[3, 4]] } }, tracking: { completed: [[0, 7]] } })],
        ['CWB:更新记录', '1-8'],
        ['CWB:模块进度', JSON.stringify({ modules: { timeline: { completed: [[0, 7]] } } })],
        ['CWB:世界书目录', '主世界书：原目录'],
    ];
    for (const [index, [marker, content]] of fixtures.entries()) h.data().entries[20 + index] = {
        uid: 20 + index, key: [marker, 'old-chat'], comment: `旧资料${index}`, content,
    };
    h.data().entries[40] = { uid: 40, key: ['CWB:自动档案', 'CWB:角色卡:other.png'], content: '[姓名]:其他卡' };
    const original = structuredClone(h.data());
    const preview = await h.lorebook.previewArchiveFormatUpgrade(h.settings);
    assert.deepEqual(h.data(), original);
    assert.equal(preview.foreignSkipped, 1);
    assert.equal(preview.candidates.length, 10);
    assert.ok(preview.candidates.every(item => !item.error), JSON.stringify(preview.candidates.map(item => item.error)));
    const result = await h.lorebook.applyArchiveFormatUpgrade(preview, preview.candidates.map(item => item.id));
    assert.equal(result.converted, 10);
    for (const item of preview.candidates) {
        const stored = h.data().entries[item.uid];
        assert.equal(stored.uid, item.uid);
        assert.equal(stored.cwbFormatUpgradeBackup, undefined);
        if (item.marker !== 'CWB:世界书目录') assert.ok(stored.key.includes(owner));
        assert.ok(!stored.key.includes('old-chat'));
    }
    assert.match(h.data().entries[25].content, /1-3、6-8/);
    assert.deepEqual(h.data().entries[9], original.entries[9]);
    assert.deepEqual(h.data().entries[40], original.entries[40]);
    assert.equal(h.requests.length, 0);
    const again = await h.lorebook.previewArchiveFormatUpgrade(h.settings);
    assert.ok(again.candidates.every(item => !item.changed && !item.error));
});

test('format upgrade refuses stale previews and card switches before writing', supported, async () => {
    const h = await harness();
    const preview = await h.lorebook.previewArchiveFormatUpgrade(h.settings);
    h.data().entries[1].content += '\n[备注]:预览后的编辑';
    const edited = structuredClone(h.data());
    await assert.rejects(h.lorebook.applyArchiveFormatUpgrade(preview, [preview.candidates[0].id]), /发生变化/);
    assert.deepEqual(h.data(), edited);
    h.contextData.characters[0].avatar = 'other.png';
    await assert.rejects(h.lorebook.applyArchiveFormatUpgrade(preview, [preview.candidates[0].id]), /角色卡/);
    assert.deepEqual(h.data(), edited);
});

test('direct upgrade retries transient reads and reports persistent read or save failures', supported, async () => {
    const h = await harness();
    let preview = await h.lorebook.previewArchiveFormatUpgrade(h.settings);
    h.failReads(1);
    assert.equal((await h.lorebook.applyArchiveFormatUpgrade(preview, [preview.candidates[0].id])).converted, 1);
    const other = await harness();
    preview = await other.lorebook.previewArchiveFormatUpgrade(other.settings);
    const original = structuredClone(other.data());
    other.failReads(2);
    await assert.rejects(other.lorebook.applyArchiveFormatUpgrade(preview, [preview.candidates[0].id]), /主世界书.*升级前复核失败.*Load failed.*已核验 0 条/);
    assert.deepEqual(other.data(), original);
    other.failSave();
    await assert.rejects(other.lorebook.applyArchiveFormatUpgrade(preview, [preview.candidates[0].id]), /主世界书.*保存请求失败.*保存结果未确认/);
    assert.deepEqual(other.data(), original);
});

test('compaction writes only selected profiles and reports verified token totals', supported, async () => {
    const h = await harness([oldEvent, newEvent]);
    h.state.chatId = h.contextData.chatId;
    h.data().entries[2] = { ...structuredClone(h.data().entries[1]), uid: 2, content: profile([newEvent]).replace('角色甲', '角色乙') };
    const untouched = h.data().entries[2].content;
    const preview = await h.lorebook.getProfileCompactionCandidates(h.settings);
    assert.equal(preview.candidates.length, 2);
    const selected = preview.candidates.find(item => item.uid === 1);
    h.reply(JSON.stringify({ 角色档案: [{ id: selected.id, 姓名: selected.name, 剧情: ['2025-09-03｜甲揭露真相，终止合作'] }] }));
    const result = await h.core.compactRoleProfiles(h.settings, () => {}, { ...preview, candidates: [selected] });
    assert.equal(h.requests.length, 1);
    assert.equal(result.results.length, 1);
    assert.equal(result.before, selected.original.length);
    assert.equal(result.after, h.data().entries[1].content.length);
    assert.ok(result.after < result.before);
    assert.equal(h.data().entries[2].content, untouched);
    assert.equal(h.data().entries[9].content, '手工资料保留');
});

test('compaction rejects changed selection and an empty selection never invokes AI', supported, async () => {
    const h = await harness();
    h.state.chatId = h.contextData.chatId;
    const preview = await h.lorebook.getProfileCompactionCandidates(h.settings);
    const empty = await h.core.compactRoleProfiles(h.settings, () => {}, { ...preview, candidates: [] });
    assert.equal(empty.results.length, 0);
    h.data().entries[1].content = profile([newEvent]);
    await assert.rejects(h.core.compactRoleProfiles(h.settings, () => {}, preview), /档案已发生变化/);
    assert.equal(h.requests.length, 0);
});

function seedCompactionProfiles(h, count) {
    h.state.chatId = h.contextData.chatId;
    h.data().entries[99] = h.data().entries[9];
    delete h.data().entries[9];
    for (let uid = 1; uid <= count; uid++) {
        const name = uid <= 2 ? '同名角色' : `角色${uid}`;
        h.data().entries[uid] = { uid, key: ['CWB:自动档案', owner, name], content: `[姓名]:${name}\n[角色已知信息.0]:决定拒绝旧同伴\n[剧情.0]:2025-09-01｜第${uid}份档案查到重要证据并与旧同伴对质\n[剧情.1]:2025-09-02｜第${uid}份档案决定解除合作关系` };
    }
}

function compactBatchReply(options) {
    const input = JSON.parse(options.prompt.at(-1).content).角色档案;
    return { 角色档案: input.map(item => ({ id: item.id, 姓名: item.姓名, 剧情: [`2025-09-02｜第${JSON.parse(item.id)[1]}份档案查证后解除合作`] })).reverse() };
}

test('eleven selected profiles use three AI requests of five, five and one with per-role token totals', supported, async () => {
    const h = await harness();
    seedCompactionProfiles(h, 11);
    const selection = await h.lorebook.getProfileCompactionCandidates(h.settings);
    const sizes = [], progress = [];
    h.reply(options => {
        sizes.push(JSON.parse(options.prompt.at(-1).content).角色档案.length);
        return JSON.stringify(compactBatchReply(options));
    });
    const result = await h.core.compactRoleProfiles(h.settings, update => progress.push(update), selection);
    assert.deepEqual(sizes, [5, 5, 1]);
    assert.equal(h.requests.length, 3);
    assert.equal(result.results.length, 11);
    assert.equal(result.before, result.results.reduce((sum, item) => sum + item.before, 0));
    assert.equal(result.after, result.results.reduce((sum, item) => sum + item.after, 0));
    assert.ok(result.after < result.before);
    for (let uid = 1; uid <= 11; uid++) {
        assert.ok(h.data().entries[uid].content.includes(`第${uid}份档案查证后解除合作`), 'reversed output and duplicate names still map to the correct UID');
        assert.ok(h.data().entries[uid].content.includes('决定拒绝旧同伴'), 'other fields remain present');
    }
    assert.equal(progress.filter(update => update.phase === 'batch').length, 3);
    assert.equal(h.data().entries[99].content, '手工资料保留');
});

test('duplicate IDs in a five-role result reject the complete batch before its first write', supported, async () => {
    const h = await harness();
    seedCompactionProfiles(h, 5);
    const selection = await h.lorebook.getProfileCompactionCandidates(h.settings);
    const before = structuredClone(h.data());
    h.reply(options => {
        const output = compactBatchReply(options);
        output.角色档案[4] = output.角色档案[0];
        return JSON.stringify(output);
    });
    await assert.rejects(h.core.compactRoleProfiles(h.settings, () => {}, selection), /角色标识或姓名不匹配/);
    assert.deepEqual(h.data(), before);
    assert.equal(h.requests.length, 1);
});

test('a malformed later batch preserves earlier verified results and all not-yet-written profiles', supported, async () => {
    const h = await harness();
    seedCompactionProfiles(h, 7);
    const selection = await h.lorebook.getProfileCompactionCandidates(h.settings);
    const originalSix = h.data().entries[6].content, originalSeven = h.data().entries[7].content;
    let latestResults = [];
    h.reply(options => {
        const output = compactBatchReply(options);
        if (h.requests.length === 2) output.角色档案.pop();
        return JSON.stringify(output);
    });
    await assert.rejects(h.core.compactRoleProfiles(h.settings, update => { if (update.results) latestResults = update.results; }, selection), /缺少或多出角色/);
    assert.equal(h.requests.length, 2);
    assert.equal(latestResults.length, 5);
    assert.equal(h.data().entries[6].content, originalSix);
    assert.equal(h.data().entries[7].content, originalSeven);
});

test('selected profiles without plot events do not make an AI request', supported, async () => {
    const h = await harness([]);
    h.state.chatId = h.contextData.chatId;
    const selection = await h.lorebook.getProfileCompactionCandidates(h.settings);
    const result = await h.core.compactRoleProfiles(h.settings, () => {}, selection);
    assert.equal(result.results.length, 1);
    assert.equal(h.requests.length, 0);
});

test('save entry point preserves server history when no full name triggered an old profile', supported, async () => {
    const h = await harness();
    await h.core.updateRange(h.settings, 0, 0, { modules: ['profiles'], silent: true });
    assert.ok(!h.requests[0].prompt.some(message => message.content.includes(oldEvent)), 'the prompt really missed this old profile');
    assert.ok(h.data().entries[1].content.includes(oldEvent));
    assert.ok(h.data().entries[1].content.includes(newEvent));
    assert.equal(h.data().entries[9].content, '手工资料保留');
    assert.equal(Object.values(h.data().entries).filter(entry => entry.key.includes('CWB:自动档案')).length, 1);
});

test('full mode reads raw legacy plot and preserves keyword-containing historical events', supported, async () => {
    const historical = '2025-09-02｜甲拒绝他交付的任务，二人的合作关系破裂';
    const h = await harness([oldEvent, historical]);
    h.settings.incremental = false;
    h.contextData.chat[0].mes = '角色甲公开了证据';
    await h.core.updateRange(h.settings, 0, 0, { modules: ['profiles'], silent: true });
    assert.ok(h.requests[0].prompt.some(message => message.content.includes(historical)), 'old context is neither disabled nor pre-filtered');
    assert.ok(h.data().entries[1].content.includes(oldEvent));
    assert.ok(h.data().entries[1].content.includes(historical));
});

test('late server events survive AI delay and later timeline/relationship whole-book saves', supported, async () => {
    const h = await harness();
    h.contextData.chat[0].mes = '角色甲公开了证据';
    const lateEvent = '2025-09-02｜甲从旧信件中确认另一个秘密';
    h.duringAI(() => { h.data().entries[1].content = profile([oldEvent, lateEvent]); });
    await h.core.updateRange(h.settings, 0, 0, { silent: true });
    for (const event of [oldEvent, lateEvent, newEvent]) assert.ok(h.data().entries[1].content.includes(event));
    assert.equal(h.data().entries[9].content, '手工资料保留');
    const markers = Object.values(h.data().entries).flatMap(entry => entry.key);
    assert.ok(markers.includes('CWB:故事时间线'));
    assert.ok(markers.includes('CWB:角色关系汇总'));
    const progress = await h.lorebook.getModuleProgress();
    assert.equal(progress.profiles.completed.length, 1);
});

test('save receipt verifies the exact entry and rejects post-save loss', supported, async () => {
    const h = await harness();
    h.state.chatId = h.contextData.chatId;
    const receipt = await h.lorebook.saveCharacterDescription(h.settings, '角色甲', profile([newEvent]), 0, 0, { returnReceipt: true });
    assert.equal(receipt.uid, 1);
    assert.ok(receipt.content.includes(oldEvent));
    h.data().entries[1].content = profile([newEvent]);
    await assert.rejects(h.lorebook.verifyProfileContent(h.settings, '角色甲', receipt.content, false, receipt), /旧剧情保留校验失败/);
});

test('unreadable old profile fails closed without replacing its text', supported, async () => {
    const h = await harness();
    h.state.chatId = h.contextData.chatId;
    h.data().entries[1].content = '无法识别的旧版本剧情正文';
    await assert.rejects(h.lorebook.saveCharacterDescription(h.settings, '角色甲', profile([newEvent]), 0, 0), /旧档案格式无法安全识别/);
    assert.equal(h.data().entries[1].content, '无法识别的旧版本剧情正文');
});

test('output overflow is a failure, not a no-change success', supported, async () => {
    const h = await harness();
    h.reply(response('[--档案输出超长--]'));
    await assert.rejects(h.core.updateRange(h.settings, 0, 0, { modules: ['profiles'], silent: true }), /输出长度不足/);
    assert.equal(h.data().entries[1].content, profile([oldEvent]));
    const progress = await h.lorebook.getModuleProgress();
    assert.equal(progress.profiles.completed.length, 0);
    assert.equal(progress.profiles.failed.length, 1);
});


test('every primary archive migrates in place and survives a completely different chat identity', supported, async () => {
    const h = await harness();
    h.core.refreshChatState();
    const ledger = JSON.stringify({ version: 2, modules: {
        profiles: { completed: [[0, 29]], failed: [] },
        timeline: { completed: [[0, 19]], failed: [[20, 29]] },
        relationships: { completed: [[0, 29]], failed: [] },
    }, tracking: { startIndex: 0, totalMessages: 30, completed: [[0, 19]], duplicates: [] } });
    const rows = [
        ['CWB:故事时间线', '[时间线.0]:2025-09-01｜甲｜原聊天关键事件'],
        ['CWB:角色关系汇总', '甲 ↔ 乙：同学'],
        ['CWB:更新状态', ledger],
        ['CWB:角色档案目录', '档案目录原文'],
        ['Amily2角色总集', '角色总览原文'],
        ['CWB:主角档案', '[姓名]:主角\n[剧情.0]:主角原经历'],
    ];
    for (let i = 0; i < rows.length; i++) h.data().entries[20 + i] = {
        uid: 20 + i, key: [rows[i][0], 'deleted-old-chat'], content: rows[i][1], disable: true,
    };
    h.data().entries[50] = { uid: 50, key: ['CWB:角色关系汇总', 'CWB:角色卡:foreign.png'], content: '其他卡关系', disable: true };
    const foreign = structuredClone(h.data().entries[50]);
    await h.lorebook.manageChatEntries(h.settings);
    for (let i = 0; i < rows.length; i++) {
        const saved = h.data().entries[20 + i];
        assert.equal(saved.content, rows[i][1], 'ownership migration retains the original content and UID');
        assert.ok(saved.key.includes(owner));
        assert.ok(!saved.key.includes('deleted-old-chat'));
        assert.ok(saved.cwbLegacyOwnerKeys.includes('deleted-old-chat'));
    }
    assert.deepEqual(h.data().entries[50], foreign);
    const before = await h.lorebook.getModuleProgress();
    h.contextData.chatId = 'entirely-new-chat - Branch #99';
    h.contextData.chatMetadata = { integrity: 'brand-new-integrity', main_chat: 'different-source' };
    h.core.refreshChatState();
    await h.lorebook.manageChatEntries(h.settings);
    const after = await h.lorebook.getModuleProgress();
    assert.equal(JSON.stringify(after), JSON.stringify(before));
    assert.match(await h.lorebook.getRelationshipSummary(), /甲 ↔ 乙：同学/);
    const timelines = await h.lorebook.getTimelineEntries();
    assert.equal(timelines.length, 1);
    assert.equal(timelines[0].uid, 20);
    for (const uid of [20, 21]) assert.equal(h.data().entries[uid].disable, false);
    await h.lorebook.saveRelationshipSummary('甲 ↔ 乙：朋友', 30, 39);
    assert.equal(h.data().entries[21].content, '甲 ↔ 乙：朋友');
    assert.equal(Object.values(h.data().entries).filter(e => e.key.includes('CWB:角色关系汇总') && e.key.includes(owner)).length, 1);
    assert.ok((await h.lorebook.getCardArchiveEntries('主世界书')).some(e => e.uid === 1));
    h.contextData.characters[0].avatar = 'different-card.png';
    h.core.refreshChatState();
    assert.equal(JSON.stringify(await h.lorebook.getModuleProgress()), '{}');
    assert.equal(await h.lorebook.getRelationshipSummary(), '');
    assert.equal((await h.lorebook.getTimelineEntries()).length, 0);
});

test('shared worldbooks never auto-adopt another unidentified legacy chat', supported, async () => {
    const h = await harness();
    h.core.refreshChatState();
    h.contextData.characters.push({ name: '另一张卡', avatar: 'other.png', data: { extensions: { world: '主世界书' } } });
    h.data().entries[20] = { uid: 20, key: ['CWB:角色关系汇总', 'unknown-old-chat'], content: '无法确定归属的关系' };
    const original = structuredClone(h.data().entries[20]);
    assert.equal(await h.lorebook.getRelationshipSummary(), '');
    assert.deepEqual(h.data().entries[20], original);
});

test('switching cards with the same chat filename during AI generation blocks archive writes', supported, async () => {
    const h = await harness();
    h.duringAI(() => { h.contextData.characters[0].avatar = 'other-card.png'; });
    await assert.rejects(h.core.updateRange(h.settings, 0, 0, { silent: true }), /切换了聊天/);
    assert.equal(h.data().entries[1].content, profile([oldEvent]));
    assert.equal(h.state.operationOwner, null);
});

test('explicit migration covers archives, timeline, relationships, directory and progress from any old chat', supported, async () => {
    const h = await harness();
    h.core.refreshChatState();
    const markers = ['CWB:自动档案', 'CWB:主角档案', 'CWB:故事时间线', 'CWB:角色关系汇总',
        'CWB:角色档案目录', 'CWB:更新状态', 'CWB:更新记录', 'CWB:模块进度', 'Amily2角色总集'];
    for (let i = 0; i < markers.length; i++) h.data().entries[20 + i] = {
        uid: 20 + i, key: [markers[i], 'deleted-chat-file', 'CWB:聊天身份:old-integrity'],
        comment: `旧资料${i}`, content: i < 2 ? `[姓名]:角色乙\n[剧情.0]:旧剧情${i}` : `原资料${i}`,
    };
    const originals = structuredClone(h.data());
    const preview = await h.lorebook.previewChatBoundProfilesForCardMigration(h.settings);
    assert.equal(preview.candidates.length, markers.length);
    h.contextData.chatId = 'new-chat-without-source-file';
    h.core.refreshChatState();
    const result = await h.lorebook.migrateChatBoundProfilesToCard(h.settings, preview);
    assert.equal(result.migrated, markers.length);
    for (let i = 0; i < markers.length; i++) {
        const stored = h.data().entries[20 + i];
        assert.equal(stored.uid, 20 + i);
        assert.equal(stored.content, originals.entries[20 + i].content);
        assert.ok(stored.key.includes(owner));
        assert.ok(!stored.key.includes('deleted-chat-file'));
        assert.ok(!stored.key.some(key => key.startsWith('CWB:聊天身份:')));
    }
    assert.deepEqual(h.data().entries[9], originals.entries[9]);
    assert.equal((await h.lorebook.previewChatBoundProfilesForCardMigration(h.settings)).candidates.length, 0);
});

test('card archives and enabled references can be read without an existing chat file', supported, async () => {
    const h = await harness();
    h.contextData.chatId = '';
    h.state.chatId = 'unknown_chat_init';
    h.data().entries[20] = { uid: 20, key: ['CWB:角色关系汇总', owner], content: '甲 ↔ 乙：同学', disable: true };
    await h.lorebook.manageChatEntries(h.settings);
    assert.equal(h.data().entries[20].disable, false);
    assert.match(await h.lorebook.getRelationshipSummary(), /甲 ↔ 乙/);
    assert.ok((await h.lorebook.getCardArchiveEntries('主世界书')).some(entry => entry.uid === 1));
});

test('unified generation ignores conflicting standalone prompts and saves through one request', supported, async () => {
    const h = await harness();
    Object.assign(h.settings, { breakPrompt: 'CONFLICT_BREAK', incrementalPrompt: 'CONFLICT_PROFILE', timelineIncrementalPrompt: 'CONFLICT_TIMELINE' });
    await h.core.updateRange(h.settings, 0, 0, { silent: true });
    assert.equal(h.requests.length, 1);
    assert.ok(!h.requests[0].systemPrompt.includes('CONFLICT_'));
    assert.match(h.requests[0].systemPrompt, /角色已知信息（字符串数组）/);
    assert.equal(h.requests[0].jsonSchema.name, 'cwb_archive_update');
    assert.match(h.data().entries[1].content, /取得关键证据/);
    assert.match(h.data().entries[1].content, /决定停止合作/);
    const single = await harness();
    single.settings.incrementalPrompt = 'KEEP_SINGLE_MODULE_CUSTOM';
    await single.core.updateRange(single.settings, 0, 0, { silent: true, modules: ['profiles'] });
    assert.ok(single.requests[0].systemPrompt.includes('KEEP_SINGLE_MODULE_CUSTOM'));
});

test('equals-heading reply never saves a freeform profile or marks any module completed', supported, async () => {
    const h = await harness();
    const original = structuredClone(h.data().entries[1]);
    h.reply('===角色档案===\n姓名：角色甲\n好感度：35\n===角色档案结束===\n===时间线增量===\n任务完成\n===时间线增量结束===\n===关系增量===\n甲—乙：好感35\n===关系增量结束===');
    await assert.rejects(h.core.updateRange(h.settings, 0, 0, { silent: true }), /自由人物卡/);
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.data().entries[1], original);
    for (const entry of Object.values(h.data().entries)) assert.ok(!['CWB:故事时间线', 'CWB:角色关系汇总'].some(marker => entry.key.includes(marker)));
    const progress = await h.lorebook.getModuleProgress();
    for (const module of ['profiles', 'timeline', 'relationships']) assert.equal(JSON.stringify(progress[module].completed), '[]');
});

test('JSON-only generation persists objects with history and never applies schema to a single-module request', supported, async () => {
    const h = await harness();
    h.reply(JSON.stringify({ 完成状态: '完整', 角色档案: [{ 档案类型: '角色', 姓名: '角色甲', 角色已知信息: [], 角色未知信息: [], 性经历人员: '', 性经历人数: '', 额外补充: [], 剧情: [oldEvent, newEvent] }],
        时间线: [{ 日期: '2025-09-03', 事件: '甲揭露真相' }], 关系更新: [{ 人物A: '甲', 人物B: '乙', 方向: '↔', 关系: '解除合作' }], 删除关系: [] }));
    await h.core.updateRange(h.settings, 0, 0, { silent: true });
    assert.equal(h.requests.length, 1);
    assert.ok(h.requests[0].jsonSchema);
    assert.match(h.data().entries[1].content, /决定停止合作/);
    assert.match(h.data().entries[1].content, /取得关键证据/);
    assert.match(await h.lorebook.getRelationshipSummary(), /解除合作/);
    const single = await harness();
    await single.core.updateRange(single.settings, 0, 0, { silent: true, modules: ['profiles'] });
    assert.equal(single.requests[0].jsonSchema, undefined);
});

test('completion status synonyms and object metadata save all validated modules instead of failing the whole batch', supported, async () => {
    for (const status of ['已完成', { 角色档案: '完成', 时间线: '完成', 关系: '完成' }]) {
        const h = await harness();
        h.reply(JSON.stringify({ 完成状态: status, 角色档案: [{ 档案类型: '角色', 姓名: '角色甲', 角色已知信息: [], 角色未知信息: [], 性经历人员: '', 性经历人数: '', 额外补充: [], 剧情: [oldEvent, newEvent] }],
            时间线: [{ 日期: '2025-09-03', 事件: '甲揭露真相，终止合作' }], 关系更新: [{ 人物A: '甲', 人物B: '乙', 方向: '↔', 关系: '解除合作' }], 删除关系: [] }));
        await h.core.updateRange(h.settings, 0, 0, { silent: true });
        assert.equal(h.requests.length, 1);
        assert.match(h.data().entries[1].content, /决定停止合作/);
        assert.match(h.data().entries[1].content, /取得关键证据/);
        assert.match(await h.lorebook.getRelationshipSummary(), /解除合作/);
        const timeline = Object.values(h.data().entries).find(entry => entry.key.includes('CWB:故事时间线'));
        assert.match(timeline.content, /甲揭露真相，终止合作/);
        const progress = await h.lorebook.getModuleProgress();
        for (const module of ['profiles', 'timeline', 'relationships']) assert.equal(JSON.stringify(progress[module].completed), '[[0,0]]');
    }
});

test('reply-format failures record structural evidence and never confirm missing modules', supported, async () => {
    const h = await harness();
    const privateReply = 'PRIVATE_UNSTRUCTURED_MODEL_REPLY';
    h.reply(privateReply);
    let failure;
    try { await h.core.updateRange(h.settings, 0, 0, { silent: true }); }
    catch (error) { failure = error; }
    assert.ok(failure);
    assert.equal(h.requests.length, 1);
    assert.equal(failure.cwbDiagnostics.stage, 'response_validation');
    assert.equal(failure.cwbDiagnostics.responseDiagnostics.responseCharacters, privateReply.length);
    assert.equal(failure.cwbDiagnostics.responseDiagnostics.format, 'unrecognized');
    assert.ok(!JSON.stringify(failure.cwbDiagnostics).includes(privateReply));
    const progress = await h.lorebook.getModuleProgress();
    for (const module of ['profiles', 'timeline', 'relationships']) {
        assert.equal(JSON.stringify(progress[module].completed), '[]');
        assert.equal(JSON.stringify(progress[module].failed), '[[0,0]]');
    }
    assert.equal(h.data().entries[1].content, profile([oldEvent]));
});
