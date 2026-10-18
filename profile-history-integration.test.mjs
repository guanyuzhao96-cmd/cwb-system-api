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
    const contextData = { chatId: 'history-chat', chatMetadata: { integrity: 'history-identity' },
        characterId: 0, name1: '主角', name2: '测试角色卡',
        characters: [{ name: '测试角色卡', avatar: 'card.png', data: { extensions: { world: '主世界书' } } }],
        chat: [{ name: '叙述者', mes: '她终于公开了证据。' }] };
    let duringAI = () => {}, nextResponse = response(profile([newEvent]));
    const sandbox = vm.createContext({ console, structuredClone, AbortController, setTimeout, clearTimeout,
        window: { toastr: { warning() {}, error() {}, success() {}, info() {} } },
        document: { getElementById: () => null },
        $: () => ({ text() {}, prop() {} }),
        fetch: async () => ({ ok: true, json: async () => structuredClone(disk) }),
    });
    const mocks = {
        '/scripts/tokenizers.js': { getTokenCountAsync: async text => text.length },
        '/script.js': { getRequestHeaders: () => ({}), generateRaw: async options => { requests.push(options); duringAI(); return typeof nextResponse === 'function' ? nextResponse(options) : nextResponse; } },
        '/scripts/extensions.js': { getContext: () => contextData, extension_settings: {} },
        '/scripts/world-info.js': { world_names: ['主世界书'], selected_world_info: [], world_info: {},
            loadWorldInfo: async () => structuredClone(cache),
            saveWorldInfo: async (_, data) => { disk = structuredClone(data); },
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
        data: () => disk, duringAI: fn => { duringAI = fn; }, reply: content => { nextResponse = content; } };
}

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
