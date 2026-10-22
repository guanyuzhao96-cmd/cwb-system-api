// Run with: node --experimental-vm-modules --test timeline-integration.test.mjs
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

test('settings button -> real API wrapper -> incremental prompt -> server readback, three rounds', { skip: !vm.SourceTextModule && 'Requires --experimental-vm-modules' }, async () => {
    const nodes = new Map(), requests = [], modules = new Map(), worldbookReads = [];
    let invalidCombined = false, failApiRequest = false, suppliedReply = null;
    let relationRound = 0;
    let disk = { entries: {} }, cache = structuredClone(disk), failWrite = false, initialized, booksByName = null;
    let readFailures = 0, readTimeouts = 0, throwOnWrite = false, blockedReadBook = null;
    const contextData = { chatId: 'integration-chat', chatMetadata: { integrity: 'stable-integration-chat' }, characterId: 0, name1: '主角', characters: [{ avatar: 'Test.png', data: { extensions: { world: '主世界书' } } }], chat: [] };
    const extension_settings = { cwb_system_api: { fullPrompt: '旧的自定义全量提示词', incrementalPrompt: '旧的自定义增量提示词', timelineIncrementalPrompt: '旧自定义时间线提示词' } };
    function $(key) {
        if (typeof key === 'object') return key;
        if (!nodes.has(key)) nodes.set(key, {
            length: key === '#top-settings-holder' || key === '#top-bar' ? 0 : 1, values: {}, handlers: {},
            val(v) { if (v === undefined) return this.values.val; this.values.val = v; return this; },
            prop(k, v) { if (v === undefined) return this.values[k]; this.values[k] = v; return this; },
            text(v) { if (v === undefined) return this.values.text; this.values.text = v; return this; },
            html(v) { if (v === undefined) return this.values.html; this.values.html = v; return this; },
            attr() { return String(key).replace(/^#/, ''); }, on(e, ...args) { this.handlers[e] = args.at(-1); return this; },
            off() { return this; }, append() { return this; }, empty() { return this; }, toggle() { return this; }, remove() { return this; },
        });
        return nodes.get(key);
    }
    const documentNodes = new Map();
    const document = { getElementById: id => { if (!documentNodes.has(id)) documentNodes.set(id, { open: false, scrollIntoView() { this.scrolled = true; } }); return documentNodes.get(id); } };
    let lastConfirmation = '';
    const context = vm.createContext({ crypto: webcrypto, TextEncoder, document, console, structuredClone, AbortController,
        setTimeout: (fn, ms) => setTimeout(fn, ms === 30000 || ms === 60000 ? 10 : ms), clearTimeout, $, window: {
        jQuery: f => initialized = f,
        confirm: message => { lastConfirmation = message; return true; },
    },
        fetch: async (_url, options = {}) => {
            const name = JSON.parse(options.body ?? '{}').name;
            worldbookReads.push(name);
            if (readTimeouts > 0) {
                readTimeouts--;
                return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
            }
            if (name === blockedReadBook) throw new TypeError('Load failed');
            if (readFailures > 0) { readFailures--; throw new TypeError('Load failed'); }
            return { ok: true, json: async () => structuredClone(booksByName ? booksByName.get(name) : disk) };
        },
    });
    const script = {
        eventSource: { on() {} }, event_types: {}, saveSettingsDebounced() {}, getRequestHeaders: () => ({}),
        generateRaw: async options => {
            requests.push(options);
            if (failApiRequest) throw new TypeError('Load failed');
            if (suppliedReply !== null) return suppliedReply;
            if (options.systemPrompt.includes('本次必须在同一条回复中输出三部分')) {
                if (invalidCombined) return '[--档案无变化--]';
                relationRound++;
                const input = options.prompt.map(x => x.content).join('\n');
                const latest = [...input.matchAll(/新增事件([一二三])/g)].at(-1)?.[1];
                return '[--角色档案开始--]\n[档案类型]:主角\n[姓名]:主角\n[角色已知信息.0]:本轮确认的重要事实\n[角色未知信息.0]:对角色隐藏的关键事实\n[性经历人员.0]:成年对象\n[性经历人数]:1\n[额外补充.0]:影响后续判断的事实\n[剧情.0]:日期未知｜本轮关键事件改变主线走向并造成重要后果\n[--角色档案结束--]\n'
                    + '[--时间线增量开始--]\n' + JSON.stringify({ 时间线: latest ? [{ 日期: '日期未知', 人物: '主角', 事件: `新增事件${latest}` }] : [] }) + '\n[--时间线增量结束--]\n'
                    + '[--关系增量开始--]\n' + JSON.stringify({ 关系更新: [{ 人物A: 'B', 方向: '↔', 人物B: 'C', 关系: '互相讨厌' }], 删除关系: [] }) + '\n[--关系增量结束--]';
            }

            if (options.systemPrompt.includes('角色关系增量整理器')) {
                relationRound++;
                return JSON.stringify({ 关系更新: relationRound === 2
                    ? [{ 人物A: 'B', 方向: '↔', 人物B: 'C', 关系: '互相讨厌' }]
                    : [{ 人物A: 'A', 方向: '↔', 人物B: 'B', 关系: relationRound === 1 ? '同班同学、情侣' : '同班同学、已分手' }] });
            }
            if (!options.systemPrompt.includes('INTEGRATION_CUSTOM_TIMELINE')) return '本次没有角色档案变化';
            const input = options.prompt.map(x => x.content).join('\n');
            const latest = [...input.matchAll(/新增事件([一二三])/g)].at(-1)?.[1];
            return JSON.stringify({ 时间线: latest ? [{ 日期: '日期未知', 人物: '主角', 事件: `新增事件${latest}` }] : [] });
        },
    };
    const extensions = { extension_settings, getContext: () => contextData,
        renderExtensionTemplateAsync: async () => readFile(new URL('./settings.html', import.meta.url), 'utf8') };
    const world = {
        selected_world_info: [], world_info: {}, world_names: ['主世界书'],
        loadWorldInfo: async () => structuredClone(cache),
        saveWorldInfo: async (name, data) => { if (throwOnWrite) throw new TypeError('Load failed'); cache = structuredClone(data); if (!failWrite) { if (booksByName) booksByName.set(name, structuredClone(data)); else disk = structuredClone(data); } },
        createWorldInfoEntry: (_, data) => { const uid = Math.max(-1, ...Object.keys(data.entries).map(Number)) + 1; return data.entries[uid] = { uid }; },
    };
    const root = dirname(fileURLToPath(import.meta.url));
    async function load(id) {
        if (modules.has(id)) return modules.get(id);
        const mock = id === '/script.js' ? script : id === '/scripts/extensions.js' ? extensions : id === '/scripts/world-info.js' ? world : null;
        const mod = mock ? new vm.SyntheticModule(Object.keys(mock), function () { for (const [k, v] of Object.entries(mock)) this.setExport(k, v); }, { context, identifier: id })
            : new vm.SourceTextModule(readFileSync(id, 'utf8'), { context, identifier: id });
        modules.set(id, mod);
        return mod;
    }
    const index = await load(resolve(root, 'index.js')); await index.link((specifier, parent) => load(specifier.startsWith('/') ? specifier : resolve(dirname(parent.identifier), specifier))); await index.evaluate(); await initialized();
    for (const key of ['fullPrompt', 'incrementalPrompt']) {
        assert.ok(extension_settings.cwb_system_api[key].startsWith('旧的自定义'));
        assert.ok(extension_settings.cwb_system_api[key].includes('CWB角色档案整理规则'));
        assert.ok(extension_settings.cwb_system_api[key].includes('角色已知信息.N'));
        assert.ok(extension_settings.cwb_system_api[key].includes('性经历人数'));
    }
    assert.ok(extension_settings.cwb_system_api.timelineIncrementalPrompt.startsWith('旧自定义时间线提示词'));
    assert.ok(extension_settings.cwb_system_api.timelineIncrementalPrompt.includes('同一天仅将属于同一故事线的关键进展合并为一条'));
    $('#cwb-system-settings').handlers.click.call({ attr: () => 'timeline' });
    assert.equal(document.getElementById('cwb-progress-details').open, true);
    assert.equal(document.getElementById('cwb-detail-timeline').scrolled, true);
    const button = $('#cwb-refresh-timeline');
    assert.equal(typeof button.handlers.click, 'function');
    assert.ok(extension_settings.cwb_system_api.timelineIncrementalPrompt.includes('旧自定义时间线提示词'));
    $('#cwb-timeline-incremental-prompt').val('INTEGRATION_CUSTOM_TIMELINE 按新增聊天提取事件，只输出时间线 JSON');
    $('#cwb-system-settings').handlers['input change']();
    assert.ok(extension_settings.cwb_system_api.timelineIncrementalPrompt.startsWith('INTEGRATION_CUSTOM_TIMELINE'));
    async function click() {
        button.handlers.click.call(button);
        for (let i = 0; i < 100 && button.prop('disabled'); i++) await new Promise(r => setTimeout(r, 5));
        assert.equal(button.prop('disabled'), false);
    }
    for (const n of ['一', '二', '三']) {
        contextData.chat.push({ name: '角色', mes: `新增事件${n}` });
        await click();
        const timelines = Object.values(disk.entries).filter(e => e.key.includes('CWB:故事时间线'));
        assert.equal(timelines.length, 1);
        assert.ok(timelines[0].content.includes(`新增事件${n}`));
    }
    assert.equal(requests.length, 3);
    assert.ok(requests[0].systemPrompt.includes('日期只出现一次'));
    assert.ok(requests[0].systemPrompt.includes('不得单独列出出场角色'));
    assert.equal(Object.values(disk.entries)[0].content.match(/新增事件/g).length, 3);
    assert.equal(Object.values(disk.entries)[0].content.match(/日期未知/g).length, 1, 'same-day updates should share a single date prefix');
    assert.ok(!Object.values(disk.entries)[0].content.includes('｜主角｜'), 'people must not have a separate column');
    assert.ok($('#cwb-timeline-debug').text().includes('保存成功'));
    await click();
    assert.equal(Object.values(disk.entries)[0].content.match(/新增事件/g).length, 3);
    assert.ok($('#cwb-timeline-debug').text().includes('新增 0 条'));
    const relationButton = $('#cwb-update-relationships');
    relationButton.handlers.click.call(relationButton);
    for (let i = 0; i < 100 && relationButton.prop('disabled'); i++) await new Promise(r => setTimeout(r, 5));
    assert.ok(Object.values(disk.entries).find(e => e.key.includes('CWB:角色关系汇总')).content.includes('情侣'));
    // Exercise actual role update -> timeline -> relationship update, not just the standalone helper.
    const callsBeforeCombined = requests.length;
    await modules.get(resolve(root, 'core.js')).namespace.updateRange(extension_settings.cwb_system_api, 0, 2, { silent: true });
    assert.equal(requests.length - callsBeforeCombined, 1);
    assert.equal(Object.values(disk.entries).filter(e => e.key.includes('CWB:主角档案')).length, 1);
    const savedProfile = Object.values(disk.entries).find(e => e.key.includes('CWB:主角档案')).content;
    assert.match(savedProfile, /角色已知信息\.0/);
    assert.match(savedProfile, /角色未知信息\.0/);
    assert.match(savedProfile, /性经历人员\.0/);
    assert.match(savedProfile, /性经历人数]:1/);
    assert.match(savedProfile, /额外补充\.0/);
    assert.ok(Object.values(disk.entries).find(e => e.key.includes('CWB:角色关系汇总')).content.includes('B ↔ C：互相讨厌'));
    // Third round: newly appended message must trigger another request and update A/B.
    contextData.chat.push({ mes: 'A和B分手，仍为同班同学' });
    relationButton.handlers.click.call(relationButton);
    for (let i = 0; i < 100 && relationButton.prop('disabled'); i++) await new Promise(r => setTimeout(r, 5));
    const relationEntries = Object.values(disk.entries).filter(e => e.key.includes('CWB:角色关系汇总'));
    assert.equal(relationEntries.length, 1);
    assert.ok(relationEntries[0].content.includes('已分手'));
    assert.ok(!relationEntries[0].content.includes('情侣'));
    assert.ok(relationEntries[0].content.includes('B ↔ C：互相讨厌'));
    assert.ok(relationEntries[0].key.includes('CWB:关系楼层:0-3'));
    // An eight-message gap must be processed in full, rather than just the most recent six.
    const relationCallsBefore = relationRound;
    contextData.chat.push(...Array.from({ length: 8 }, () => ({ mes: '后续互动' })));
    await modules.get(resolve(root, 'core.js')).namespace.updateRelationships({ threshold: 2 });
    assert.equal(relationRound - relationCallsBefore, 4);
    assert.ok(Object.values(disk.entries).find(e => e.key.includes('CWB:角色关系汇总')).key.includes('CWB:关系楼层:0-11'));
    assert.equal(Object.values(disk.entries).filter(e => e.key.includes('CWB:故事时间线')).length, 1);
    const beforeBatch = requests.length;
    const batchSettings = { ...extension_settings.cwb_system_api, threshold: 4 };
    await modules.get(resolve(root, 'core.js')).namespace.batchUpdate(batchSettings);
    assert.equal(requests.length - beforeBatch, 3, '12 messages / 4 = 3 batches, exactly 3 AI requests');
    const beforeRepeat = requests.length;
    await modules.get(resolve(root, 'core.js')).namespace.batchUpdate(batchSettings);
    assert.equal(requests.length, beforeRepeat, 'repeated batch must call AI zero times');
    contextData.chat.push(...Array.from({ length: 4 }, () => ({ mes: '新一批剧情' })));
    invalidCombined = true;
    const beforeInvalid = requests.length;
    const savedBeforeInvalid = Object.values(disk.entries).filter(e => !e.key.includes('CWB:更新状态')).map(e => JSON.stringify(e)).join('');
    await assert.rejects(modules.get(resolve(root, 'core.js')).namespace.batchUpdate(batchSettings), /关系|时间线/);
    assert.equal(requests.length - beforeInvalid, 1, 'invalid reply does not trigger hidden retries');
    assert.equal(Object.values(disk.entries).filter(e => !e.key.includes('CWB:更新状态')).map(e => JSON.stringify(e)).join(''), savedBeforeInvalid, 'invalid content sections must not overwrite existing content');
    assert.equal(Object.values(disk.entries).filter(e => e.key.includes('CWB:更新状态')).length, 1, 'module progress and whole-chat tracking share one hidden state entry');
    const ledgerAfterFailure = await modules.get(resolve(root, 'lorebook.js')).namespace.getModuleProgress();
    assert.deepEqual(JSON.parse(JSON.stringify(ledgerAfterFailure.profiles.failed)), []);
    assert.deepEqual(JSON.parse(JSON.stringify(ledgerAfterFailure.timeline.failed)), [[12, 15]]);
    assert.deepEqual(JSON.parse(JSON.stringify(ledgerAfterFailure.relationships.failed)), [[12, 15]]);
    assert.ok($('#cwb-progress-timeline').text().includes('当前正文连续核验至第 12 楼'));

    // A 30-floor request remains one AI call and exposes a downloadable,
    // content-free diagnostic report when the system API transport fails.
    const previousChat = contextData.chat;
    const progressBeforeLoadFailure = structuredClone(disk);
    contextData.chat = Array.from({ length: 30 }, (_, i) => ({ mes: `第${i + 1}楼剧情` }));
    const callsBeforeLoadFailure = requests.length;
    failApiRequest = true;
    await assert.rejects(
        modules.get(resolve(root, 'core.js')).namespace.updateRange({ ...batchSettings, threshold: 30 }, 0, 29, { silent: true, modules: ['profiles'] }),
        /AI 请求失败.*输入约.*酒馆系统 API 请求失败：Load failed/,
    );
    failApiRequest = false;
    assert.equal(requests.length - callsBeforeLoadFailure, 1, '30 floors still use exactly one AI call');
    assert.ok($('#cwb-status').text().includes('AI 请求失败'));
    assert.ok($('#cwb-status').text().includes('输入约'));
    assert.equal(document.getElementById('cwb-download-error-report').hidden, false, 'failed updates expose a downloadable diagnostic report');
    contextData.chat = previousChat;
    disk = progressBeforeLoadFailure;
    cache = structuredClone(disk);


    invalidCombined = false;
    const beforeRepair = requests.length;
    const profileSnapshot = JSON.stringify(Object.values(disk.entries).find(e => e.key.includes('CWB:主角档案')));
    await modules.get(resolve(root, 'core.js')).namespace.retryMissingModule(batchSettings, 'timeline');
    assert.equal(requests.length - beforeRepair, 1);
    assert.equal(JSON.stringify(Object.values(disk.entries).find(e => e.key.includes('CWB:主角档案'))), profileSnapshot, 'timeline repair must not rewrite profiles');
    let progressAfterRepair = await modules.get(resolve(root, 'lorebook.js')).namespace.getModuleProgress();
    assert.deepEqual(JSON.parse(JSON.stringify(progressAfterRepair.timeline.failed)), []);
    assert.deepEqual(JSON.parse(JSON.stringify(progressAfterRepair.relationships.failed)), [[12, 15]]);
    // Batch should now request only the relationship gap, then the next batch should be a no-op.
    const beforeRelationshipRepair = requests.length;
    await modules.get(resolve(root, 'core.js')).namespace.batchUpdate(batchSettings);
    assert.equal(requests.length - beforeRelationshipRepair, 1);
    const beforeFinalRepeat = requests.length;
    await modules.get(resolve(root, 'core.js')).namespace.batchUpdate(batchSettings);
    assert.equal(requests.length, beforeFinalRepeat);
    contextData.chat.push(...Array.from({ length: 4 }, () => ({ mes: '自动阈值新剧情' })));
    const beforeAuto = requests.length;
    modules.get(resolve(root, 'core.js')).namespace.maybeAutoUpdate({ ...batchSettings, enabled: true, autoUpdate: true });
    await new Promise(resolve => setTimeout(resolve, 1350));
    assert.equal(requests.length - beforeAuto, 1, 'automatic threshold update uses one combined call and skips completed floors');
    const progressStore = modules.get(resolve(root, 'lorebook.js')).namespace;
    const owner = 'CWB:角色卡:Test.png';
    assert.ok(Object.values(disk.entries).some(entry => entry.key.includes('CWB:更新状态') && entry.key.includes(owner)));
    assert.ok(Object.values(disk.entries).every(entry => !entry.key.some(key => String(key).startsWith('CWB:聊天身份:'))));
    const savedTimeline = await progressStore.getTimelineEntries();
    const savedRelations = await progressStore.getRelationshipSummary();
    const savedProfiles = Object.values(disk.entries).filter(entry => entry.key.includes('CWB:主角档案')).map(entry => entry.content);
    const originalChat = contextData.chat;
    contextData.chatId = 'renamed-chat';
    contextData.chatMetadata = {};
    assert.ok((await progressStore.getModuleProgress()).timeline.completed.length > 0, 'same source content retains receipts after rename');
    contextData.chat = [{ name: '角色', mes: '全新剧情，与旧聊天同楼层不同正文' }];
    assert.equal((await progressStore.getModuleProgress()).timeline.completed.length, 0, 'new chat must not inherit old floor completion');
    assert.equal((await progressStore.getTimelineEntries())[0].content, savedTimeline[0].content, 'new chat reads same card timeline');
    assert.equal(await progressStore.getRelationshipSummary(), savedRelations, 'new chat reads same card relationships');
    assert.deepEqual(Object.values(disk.entries).filter(entry => entry.key.includes('CWB:主角档案')).map(entry => entry.content), savedProfiles);
    await progressStore.recordModuleResult('timeline', 0, 0);
    assert.deepEqual(JSON.parse(JSON.stringify((await progressStore.getModuleProgress()).timeline.completed)), [[0, 0]]);
    contextData.chat = originalChat;
    assert.ok((await progressStore.getModuleProgress()).timeline.completed[0][1] > 0, 'returning to original source restores original receipts');
    contextData.chat = structuredClone(originalChat);
    contextData.chat[0].mes = '编辑了第一楼正文';
    assert.equal((await progressStore.getModuleProgress()).timeline.completed.length, 0, 'changed first floor invalidates suffix receipts');
    contextData.chat = originalChat;

    const uid = Math.max(...Object.keys(disk.entries).map(Number)) + 1;
    disk.entries[uid] = { uid, key: ['CWB:自动档案', 'deleted-chat', '角色乙', '1-3'], comment: '动态-角色乙', content: '[姓名]:角色乙\n[剧情.0]:原来聊天已删除的重要剧情' };
    disk.entries[uid + 1] = { uid: uid + 1, key: ['CWB:自动档案', 'CWB:角色卡:Other.png', '角色乙'], comment: '他卡资料', content: '另一角色卡的资料' };
    disk.entries[uid + 2] = { uid: uid + 2, key: ['手工条目'], content: '手工资料' };
    const migrated = await progressStore.getEntries('主世界书');
    assert.ok(migrated.find(entry => entry.uid === uid).key.includes(owner), 'exclusive primary recovers archives whose source chat is gone');
    assert.ok(!migrated.find(entry => entry.uid === uid).key.includes('deleted-chat'));
    assert.equal(disk.entries[uid].content, '[姓名]:角色乙\n[剧情.0]:原来聊天已删除的重要剧情');
    assert.equal(disk.entries[uid + 1].content, '另一角色卡的资料');
    const preview = await progressStore.getGeneratedContentPreview();
    assert.ok(preview.entries.some(entry => entry.uid === uid));
    assert.ok(!preview.entries.some(entry => entry.uid === uid + 1 || entry.uid === uid + 2));
    const prior = structuredClone(disk);
    disk.entries[uid].content += '编辑';
    await assert.rejects(progressStore.deleteGeneratedContent(preview), /发生变化/);
    disk = prior;
    await progressStore.deleteGeneratedContent(await progressStore.getGeneratedContentPreview());
    assert.equal(disk.entries[uid + 1].content, '另一角色卡的资料');
    assert.equal(disk.entries[uid + 2].content, '手工资料');
    disk = prior;
    contextData.characters.push({ avatar: 'Other.png', data: { extensions: { world: '主世界书' } } });
    contextData.characterId = 1;
    await progressStore.manageChatEntries({ enabled: true, worldbookTarget: 'primary', multiWorldbookRouting: false });
    assert.equal(disk.entries[uid].disable, true, 'switching cards disables old card injection without deleting data');
    await assert.rejects(progressStore.patchEntries('主世界书', [{ uid, content: '错误覆盖' }]), /另一张角色卡/);
    await assert.rejects(progressStore.deleteEntries('主世界书', [uid]), /不属于/);
    assert.equal((await progressStore.getModuleProgress()).timeline.completed.length, 0, 'different card has no receipts from first card');
    assert.equal(await progressStore.getRelationshipSummary(), '', 'different card cannot read first card relations');
    const otherPreview = await progressStore.getGeneratedContentPreview();
    assert.deepEqual(Array.from(otherPreview.entries, entry => entry.uid), [uid + 1]);
    contextData.characterId = 0;
    await progressStore.manageChatEntries({ enabled: true, worldbookTarget: 'primary', multiWorldbookRouting: false });
    assert.equal(disk.entries[uid].disable, false, 'switching back reactivates the original card archive');
    const contentBefore = disk.entries[uid].content;
    failWrite = true;
    await assert.rejects(progressStore.recordModuleResult('profiles', 0, 0, '新错误'), /回读不一致/);
    failWrite = false;
    assert.equal(disk.entries[uid].content, contentBefore, 'failed receipt write does not remove archives');
    assert.equal((await progressStore.getProgressRecoveryCandidates()).length, 0);
    // Screenshot regression: existing Test2.png timeline is reachable even when
    // the host retains a groupId. Exercise the actual worldbook reader, no AI.
    contextData.characters.push({ avatar: 'Test2.png', data: { extensions: { world: '主世界书' } } });
    contextData.characterId = '2';
    contextData.groupId = 'existing-group';
    const screenshotUid = Math.max(...Object.keys(disk.entries).map(Number)) + 1;
    disk.entries[screenshotUid] = { uid: screenshotUid, key: ['CWB:故事时间线', 'CWB:角色卡:Test2.png', 'CWB:时间线楼层:1-25', '故事时间线'],
        content: '【主线时间线】\n「日期未知」1.原有故事资料', disable: false, constant: true, selective: false };
    const beforeReadRequests = requests.length;
    const screenshotEntries = await progressStore.getTimelineEntries();
    assert.equal(screenshotEntries.length, 1);
    assert.equal(screenshotEntries[0].uid, screenshotUid);
    assert.equal(screenshotEntries[0].content, disk.entries[screenshotUid].content);
    contextData.groups = [{ id: 'existing-group', members: ['Test2.png'] }];
    contextData.characterId = undefined;
    assert.equal((await progressStore.getTimelineEntries())[0].uid, screenshotUid, 'unique group member resolves the same file and primary worldbook');
    assert.equal(requests.length, beforeReadRequests, 'reading existing archives does not generate AI output');

    // Separate named server books reproduce the actual location mismatch: the
    // previous mock returned the same data for every requested book name.
    contextData.characterId = 2;
    contextData.chat = [{ mes: '新聊天的第一楼' }];
    contextData.characters[2].data.extensions.world = '';
    world.world_names.push('已有书', '其他卡书', '空书', '角色分卷');
    booksByName = new Map(world.world_names.map(name => [name, { entries: {} }]));
    booksByName.get('已有书').entries = {
        10: structuredClone(disk.entries[screenshotUid]),
        11: { uid: 11, key: ['CWB:角色关系汇总', 'CWB:角色卡:Test2.png', '角色关系'], content: '【角色关系汇总】\n甲 ↔ 乙：同学' },
        12: { uid: 12, key: ['CWB:更新状态', 'CWB:角色卡:Test2.png'], content: JSON.stringify({ modules: { timeline: { completed: [[0, 24]] } } }) },
        13: { uid: 13, key: ['CWB:角色档案目录', 'CWB:角色卡:Test2.png'], content: '[角色甲] → 世界书《角色分卷》中的「动态-角色甲」' },
    };
    booksByName.get('角色分卷').entries[1] = { uid: 1, key: ['CWB:自动档案', 'CWB:角色卡:Test2.png', '角色甲'], content: '[姓名]:角色甲\n[剧情.0]:已有的重要剧情' };
    booksByName.get('其他卡书').entries[10] = { uid: 10, key: ['CWB:故事时间线', 'CWB:角色卡:Other.png'], content: '其他卡的资料' };
    extension_settings.cwb_system_api.worldbookTarget = 'primary';
    progressStore.resetArchiveLocation();
    const originalExisting = JSON.stringify(booksByName.get('已有书'));
    assert.equal(await progressStore.getArchiveWorldbook(), '已有书', 'no primary binding: discovers the existing card-owned global book');
    assert.equal((await progressStore.getTimelineEntries())[0].uid, screenshotUid);
    assert.match(await progressStore.getRelationshipSummary(), /同学/);
    assert.equal((await progressStore.getModuleProgress()).timeline.completed.length, 0, 'legacy floor-only progress is not represented as verified content');
    const available = await progressStore.getArchiveAvailability();
    assert.equal(available.bookName, '已有书');
    assert.equal(available.timeline, 1);
    assert.equal(available.relationships, 1);
    assert.equal(available.profiles, 1, 'directory-linked profiles are included in the archive viewer and count');
    await modules.get(resolve(root, 'core.js')).namespace.refreshModuleProgress();
    assert.match($('#cwb-archive-availability').text(), /已有档案 1 条、时间线 1 条、关系 1 条/);
    assert.equal($('#cwb-through-timeline').text(), '25 楼（旧）');
    assert.equal(JSON.stringify(booksByName.get('已有书')), originalExisting, 'reading existing owned records preserves their content');

    // Explicit selection wins even when another primary book is bound and the
    // multi-worldbook profile routing option was enabled in saved settings.
    contextData.characters[2].data.extensions.world = '空书';
    extension_settings.cwb_system_api.worldbookTarget = 'custom';
    extension_settings.cwb_system_api.customWorldbook = '已有书';
    progressStore.resetArchiveLocation();
    assert.equal(await progressStore.getArchiveWorldbook(), '已有书');
    await progressStore.saveTimeline(extension_settings.cwb_system_api, '2025-09-02｜指定书的新事件', 0, 0);
    await progressStore.saveRelationshipSummary('甲 ↔ 乙：合作', 0, 0);
    await progressStore.saveUserDescription(extension_settings.cwb_system_api, '主角', '[姓名]:主角\n[剧情.0]:新的关键剧情', 0, 0);
    await progressStore.saveCharacterDescription(extension_settings.cwb_system_api, '角色甲', '[姓名]:角色甲\n[剧情.0]:角色关键剧情', 0, 0);
    await progressStore.recordModuleResult('timeline', 0, 0);
    await progressStore.recordChatUpdateRange(0, 0, 1, '检查完成');
    assert.match((await progressStore.getTimelineEntries())[0].content, /新事件/);
    assert.match(await progressStore.getRelationshipSummary(), /合作/);
    assert.equal((await progressStore.getModuleProgress()).timeline.completed[0][1], 0);
    assert.equal((await progressStore.getChatUpdateTracking(1)).completedRanges.length, 1);
    assert.equal(Object.values(booksByName.get('空书').entries).length, 0, 'primary book must not receive accidental writes');
    assert.equal(booksByName.get('其他卡书').entries[10].content, '其他卡的资料');
    assert.ok(Object.values(booksByName.get('已有书').entries).some(entry => entry.key.includes('CWB:主角档案')));
    assert.ok(Object.values(booksByName.get('已有书').entries).some(entry => entry.key.includes('CWB:自动档案')));
    assert.equal((await progressStore.getCardArchiveEntries()).entries.some(entry => entry.bookName === '角色分卷'), true);
    booksByName.get('已有书').entries[1] = { uid: 1, key: ['手工'], content: '同UID的手工资料' };
    await modules.get(resolve(root, 'viewer.js')).namespace.openViewer(extension_settings.cwb_system_api);
    const routedCard = { data: () => 1, attr: () => '角色分卷', find: () => ({ val: () => '[姓名]:角色甲\n[剧情.0]:修改后的分卷剧情' }) };
    await $('.cwb-save-profile').handlers.click.call({ closest: () => routedCard });
    assert.match(booksByName.get('角色分卷').entries[1].content, /修改后的分卷剧情/);
    assert.equal(booksByName.get('已有书').entries[1].content, '同UID的手工资料', 'viewer writes to the entry source book, not the currently selected central book');
    assert.equal(requests.length, beforeReadRequests, 'location discovery and direct persistence do not call AI');

    // Same metadata shape as the supplied worldbook: Chinese one-based ledger.
    booksByName.get('已有书').entries[12].content = JSON.stringify({ 存档版本: 3,
        时间线: { 已保存楼层: '1-25', 失败楼层: '无' },
        角色档案: { 已保存楼层: '无', 失败楼层: '1-25', 最近更新: { 错误: '未写入本轮资料' } },
        角色关系: { 已保存楼层: '无', 失败楼层: '1-25' } });
    contextData.chat = Array.from({ length: 572 }, (_, i) => ({ mes: `正文${i}` }));
    await modules.get(resolve(root, 'core.js')).namespace.refreshModuleProgress();
    assert.equal($('#cwb-through-timeline').text(), '25 楼（旧）');
    assert.equal($('#cwb-gap-timeline').text(), '547 楼待补；25 楼旧记录待核验');
    assert.match($('#cwb-progress-profiles').text(), /旧失败记录：1-25/);
    assert.match($('#cwb-progress-profiles').text(), /旧错误：未写入本轮资料/);
    await progressStore.recordModuleResult('timeline', 0, 9);
    const legacyReloaded = await progressStore.getModuleProgress();
    assert.equal(legacyReloaded.timeline.legacy.completed[0][1], 24, 'old history survives subsequent successful writes and reload');
    await modules.get(resolve(root, 'core.js')).namespace.refreshModuleProgress();
    assert.match($('#cwb-gap-timeline').text(), /15 楼旧记录待核验/);
    const readsBeforeRetry = worldbookReads.length;
    blockedReadBook = '空书';
    readFailures = 1;
    await progressStore.getModuleProgress();
    blockedReadBook = null;
    assert.equal(worldbookReads.length - readsBeforeRetry, 2, 'one transient read failure is retried once');
    readTimeouts = 1;
    const beforeTimeoutRetry = worldbookReads.length;
    await progressStore.getModuleProgress();
    assert.equal(worldbookReads.length - beforeTimeoutRetry, 2, 'timed-out read retries without repeating AI');
    readTimeouts = 2;
    await assert.rejects(progressStore.getModuleProgress(), error => error.cwbDiagnostics.attempts === 2 && /超过60秒/.test(error.message));
    // A stale installed-book name must never become a dependency of this card.
    blockedReadBook = '空书';
    const relatedReadStart = worldbookReads.length;
    const scopedSettings = { worldbookTarget: 'custom', customWorldbook: '已有书', multiWorldbookRouting: true, incremental: true };
    await progressStore.getCardArchiveEntries(scopedSettings);
    await progressStore.getTriggeredOldProfiles(scopedSettings, [{ message: '角色甲' }]);
    await progressStore.discoverWorldbookRoutes(scopedSettings);
    await progressStore.updateMasterDirectory(scopedSettings);
    await progressStore.manageChatEntries(scopedSettings);
    assert.ok(!worldbookReads.slice(relatedReadStart).includes('空书'), 'unrelated unreadable installed book is never fetched');
    blockedReadBook = null;
    // Primary mode also writes new profiles without static NPC directories.
    contextData.characters[2].data.extensions.world = '已有书';
    progressStore.resetArchiveLocation();
    blockedReadBook = '空书';
    const primarySettings = { ...scopedSettings, worldbookTarget: 'primary' };
    await progressStore.saveCharacterDescription(primarySettings, '新角色', '[姓名]:新角色\n[剧情.0]:2025-09-01｜关键剧情', 0, 24);
    await progressStore.verifyProfileContent(primarySettings, '新角色', '[姓名]:新角色\n[剧情.0]:2025-09-01｜关键剧情');
    await progressStore.updateRoster(primarySettings, ['新角色'], 0, 24);
    assert.ok(Object.values(booksByName.get('已有书').entries).some(entry => entry.key?.includes('新角色')));
    blockedReadBook = null;
    readFailures = 2;
    await assert.rejects(progressStore.getModuleProgress(), error => {
        const report = modules.get(resolve(root, 'error-report.js')).namespace.createErrorReport(error, error.cwbDiagnostics);
        assert.equal(report.operation.stage, 'Worldbook read');
        assert.equal(report.operation.requestPath, '/api/worldinfo/get');
        assert.equal(report.operation.attempts, 2);
        return /读取失败.*Load failed/.test(error.message);
    });
    const beforeFailedWrite = JSON.stringify(booksByName.get('已有书'));
    throwOnWrite = true;
    await assert.rejects(progressStore.recordModuleResult('timeline', 10, 24), error => error.cwbDiagnostics?.requestPath === '/api/worldinfo/edit' && /保存结果未确认/.test(error.message));
    throwOnWrite = false;
    assert.equal(JSON.stringify(booksByName.get('已有书')), beforeFailedWrite, 'failed persistence does not advance progress');
    assert.equal(requests.length, beforeReadRequests, 'network handling never repeats AI generation');

    // Full nine-profile batch through the actual update/save/readback pipeline.
    // Optional private fixture stays outside the repository and release tree.
    suppliedReply = process.env.CWB_PRIVATE_RESPONSE_FIXTURE
        ? readFileSync(process.env.CWB_PRIVATE_RESPONSE_FIXTURE, 'utf8')
        : ['林清', '许宁', '沈雨', '陆云', '江平', '苏兰', '方明', '陈青', '主角'].map((name, i) =>
            `[--角色档案开始--]\n[档案类型]:${i === 8 ? '主角' : '角色'}\n[姓名]:${name}\n[角色已知信息.0]:已确认的关键事实\n[剧情.0]:2025-09-01｜作出重要决定并改变后续关系\n[--角色档案结束--]`).join('\n')
            + '\n[--时间线增量开始--]\n{"时间线":[{"日期":"2025-09-01","事件":"重要决定改变后续关系"}]}\n[--时间线增量结束--]'
            + '\n[--关系增量开始--]\n{"关系更新":[],"删除关系":[]}\n[--关系增量结束--]';
    const parser = modules.get(resolve(root, 'combined-response.mjs')).namespace;
    const utils = modules.get(resolve(root, 'utils.js')).namespace;
    const suppliedParts = parser.parseCombinedParts(suppliedReply);
    assert.equal(suppliedParts.profiles.value.length, 9);
    const writesBeforeBatch = requests.length;
    blockedReadBook = '空书';
    await modules.get(resolve(root, 'core.js')).namespace.updateRange({ ...extension_settings.cwb_system_api, ...scopedSettings }, 0, 24, { silent: true });
    assert.equal(requests.length - writesBeforeBatch, 1);
    for (const block of suppliedParts.profiles.value) {
        const name = utils.parseCustomFormat(block).姓名;
        assert.ok(Object.values(booksByName.get('已有书').entries).some(entry => entry.key?.includes(name) && entry.content.includes('[剧情.0]')), `profile persisted: ${name}`);
    }
    const savedBatchProgress = await progressStore.getModuleProgress();
    for (const module of ['profiles', 'timeline', 'relationships']) assert.equal(savedBatchProgress[module].completed[0][1], 24);
    throwOnWrite = true;
    await assert.rejects(modules.get(resolve(root, 'core.js')).namespace.updateRange({ ...extension_settings.cwb_system_api, ...scopedSettings }, 0, 24, { silent: true, modules: ['profiles'] }), error =>
        error.cwbDiagnostics.stage === 'Worldbook write'
        && error.cwbDiagnostics.worldbookName === '已有书'
        && error.cwbDiagnostics.requestPath === '/api/worldinfo/edit'
        && error.stack.includes('Caused by:'));
    throwOnWrite = false;
    suppliedReply = null;
    blockedReadBook = null;

    contextData.characters[2].data.extensions.world = '';
    booksByName.get('空书').entries[10] = structuredClone(booksByName.get('已有书').entries[10]);
    extension_settings.cwb_system_api.worldbookTarget = 'primary';
    progressStore.resetArchiveLocation();
    const ambiguousBefore = JSON.stringify([...booksByName]);
    await assert.rejects(progressStore.getArchiveWorldbook(), /分散在多个世界书/);
    assert.equal(JSON.stringify([...booksByName]), ambiguousBefore, 'ambiguous discovery is read-only');

    // No binding and no owned archive must never choose an arbitrary global book.
    contextData.characters.push({ avatar: 'New.png', data: { extensions: {} } });
    contextData.characterId = 3;
    extension_settings.cwb_system_api.worldbookTarget = 'primary';
    progressStore.resetArchiveLocation();
    await assert.rejects(progressStore.getArchiveWorldbook(), /指定已有世界书/);
});
