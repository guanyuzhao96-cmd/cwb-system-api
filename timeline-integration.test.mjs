// Run with: node --experimental-vm-modules --test timeline-integration.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

test('settings button -> real API wrapper -> incremental prompt -> server readback, three rounds', { skip: !vm.SourceTextModule && 'Requires --experimental-vm-modules' }, async () => {
    const nodes = new Map(), requests = [], modules = new Map();
    let invalidCombined = false;
    let relationRound = 0;
    let disk = { entries: {} }, cache = structuredClone(disk), failWrite = false, initialized;
    const contextData = { chatId: 'integration-chat', characterId: 0, name1: '主角', characters: [{ data: { extensions: { world: '主世界书' } } }], chat: [] };
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
    const context = vm.createContext({ document, console, structuredClone, setTimeout, clearTimeout, $, window: {
        jQuery: f => initialized = f,
        confirm: message => { lastConfirmation = message; return true; },
    },
        fetch: async () => ({ ok: true, json: async () => structuredClone(disk) }),
    });
    const script = {
        eventSource: { on() {} }, event_types: {}, saveSettingsDebounced() {}, getRequestHeaders: () => ({}),
        generateRaw: async options => {
            requests.push(options);
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
        saveWorldInfo: async (_, data) => { cache = structuredClone(data); if (!failWrite) disk = structuredClone(data); },
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
    assert.ok($('#cwb-progress-timeline').text().includes('连续成功至第 12 楼'));

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
    // Legacy whole-chat tracking and module progress should converge into one
    // chat-scoped record without losing disjoint module or duplicate ranges.
    const beforeMigration = structuredClone(disk);
    const migrationUid = Math.max(-1, ...Object.keys(disk.entries).map(Number)) + 1;
    disk.entries[migrationUid] = { uid: migrationUid, key: ['CWB:更新记录', 'migration-chat', 'CWB:总结楼层:0-7', 'CWB:追踪起点:0', 'CWB:重复总结楼层:3-4'], content: '最近一次：旧版更新' };
    disk.entries[migrationUid + 1] = { uid: migrationUid + 1, key: ['CWB:模块进度', 'migration-chat'], content: JSON.stringify({ version: 1, modules: {
            profiles: { completed: [[0, 4]], failed: [] },
            timeline: { completed: [[0, 2]], failed: [] },
            relationships: { completed: [[0, 1]], failed: [] },
        } }) };
    cache = structuredClone(disk);
    modules.get(resolve(root, 'state.js')).namespace.state.chatId = 'migration-chat';
    await modules.get(resolve(root, 'lorebook.js')).namespace.recordModuleResult('relationships', 2, 3);
    const migrated = Object.values(disk.entries).filter(e => e.key.includes('CWB:更新状态') && e.key.includes('migration-chat'));
    assert.equal(migrated.length, 1);
    assert.equal(Object.values(disk.entries).some(e => e.key.includes('CWB:更新记录') || e.key.includes('CWB:模块进度')), false);
    const migratedState = JSON.parse(migrated[0].content);
    assert.deepEqual(migratedState.modules.profiles.completed, [[0, 4]]);
    assert.deepEqual(migratedState.modules.timeline.completed, [[0, 2]]);
    assert.deepEqual(migratedState.modules.relationships.completed, [[0, 3]]);
    assert.deepEqual(migratedState.tracking.completed, [[0, 7]]);
    assert.deepEqual(migratedState.tracking.duplicates, [[3, 4]]);
    disk = beforeMigration;
    cache = structuredClone(disk);
    modules.get(resolve(root, 'state.js')).namespace.state.chatId = 'integration-chat';
    const beforeDelete = structuredClone(disk);
    const deleteUid = Math.max(-1, ...Object.keys(disk.entries).map(Number)) + 1;
    disk.entries[deleteUid] = { uid: deleteUid, key: ['手工条目', 'integration-chat'], comment: '手写资料', content: '必须保留' };
    disk.entries[deleteUid + 1] = { uid: deleteUid + 1, key: ['CWB:自动档案', 'other-chat', '角色甲', '1-3'], comment: '动态-角色甲', content: '其他聊天资料' };
    disk.entries[deleteUid + 2] = { uid: deleteUid + 2, key: ['CWB:世界书目录'], comment: '全局目录', content: '全局目录必须保留' };
    disk.entries[deleteUid + 3] = { uid: deleteUid + 3, key: ['CWB:自动档案', 'integration-chat', '角色乙', '1-3'], comment: '动态-角色乙', content: '当前聊天生成档案' };
    cache = structuredClone(disk);
    const lorebook = modules.get(resolve(root, 'lorebook.js')).namespace;
    const previewProgress = [];
    const preview = await lorebook.getGeneratedContentPreview(item => previewProgress.push(item));
    assert.ok(previewProgress.some(item => item.phase === 'scan' && item.current === item.total));
    assert.ok(preview.entries.some(e => e.marker === 'CWB:自动档案'));
    assert.ok(preview.entries.some(e => e.marker === 'CWB:故事时间线'));
    assert.ok(preview.entries.some(e => e.marker === 'CWB:更新状态'));
    assert.equal(preview.entries.some(e => e.uid === deleteUid), false, 'manual entries are excluded from the deletion preview');
    assert.equal(preview.entries.some(e => e.uid === deleteUid + 1), false, 'entries from other chats are excluded from the deletion preview');
    assert.equal(preview.entries.some(e => e.uid === deleteUid + 2), false, 'global directory entries are excluded from the deletion preview');
    const changedTarget = preview.entries[0];
    disk.entries[changedTarget.uid].content += '\n预览后手动修改';
    const deleteProgress = [];
    await assert.rejects(lorebook.deleteGeneratedContent(preview, item => deleteProgress.push(item)), /发生变化/);
    assert.ok(deleteProgress.some(item => item.phase === 'verify'), 'deletion reports its recheck phase');
    assert.ok(Object.values(disk.entries).some(e => e.key.includes('CWB:故事时间线')), 'stale preview aborts before deleting any entries');
    cache = structuredClone(disk);
    const deleteButton = $('#cwb-delete-generated');
    assert.equal(typeof deleteButton.handlers.click, 'function', 'cleanup action is available in the workbench');
    deleteButton.handlers.click.call(deleteButton);
    for (let i = 0; i < 100 && deleteButton.prop('disabled'); i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(deleteButton.prop('disabled'), false);
    assert.match(lastConfirmation, /原始\/手工条目/);
    assert.match(lastConfirmation, /其他聊天数据/);
    const deletedUids = preview.entries.map(entry => entry.uid);
    assert.ok(deletedUids.length > 0);
    assert.equal(deletedUids.some(uid => disk.entries[uid]), false, 'all previewed generated entries are removed');
    assert.equal(Object.values(disk.entries).some(e => e.key.includes('integration-chat') && [
        'CWB:自动档案', 'CWB:主角档案', 'CWB:故事时间线', 'CWB:角色关系汇总', 'CWB:角色档案目录',
        'CWB:更新状态', 'CWB:更新记录', 'CWB:模块进度', 'Amily2角色总集',
    ].some(marker => e.key[0] === marker)), false, 'all plugin-generated entries for the selected chat are deleted');
    assert.equal(disk.entries[deleteUid].content, '必须保留');
    assert.equal(disk.entries[deleteUid + 1].content, '其他聊天资料');
    assert.equal(disk.entries[deleteUid + 2].content, '全局目录必须保留');
    disk = beforeDelete;
    cache = structuredClone(disk);
    failWrite = true;
    contextData.chat.push({ mes: '新增事件一。新增事件二。新增事件三。' });
    // Force a visibly different response, so readback must detect failed persistence.
    cache.entries = {};
    await click();
    assert.ok($('#cwb-status').text().includes('回读与本次写入不一致'));
    assert.equal(Object.values(disk.entries)[0].content.match(/新增事件/g).length, 3);
});
