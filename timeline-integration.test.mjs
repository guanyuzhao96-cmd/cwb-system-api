// Run with: node --experimental-vm-modules --test timeline-integration.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

test('settings button -> real API wrapper -> incremental prompt -> server readback, three rounds', { skip: !vm.SourceTextModule && 'Requires --experimental-vm-modules' }, async () => {
    const nodes = new Map(), requests = [], modules = new Map(), worldbookReads = [];
    let invalidCombined = false, failApiRequest = false;
    let relationRound = 0;
    let disk = { entries: {} }, cache = structuredClone(disk), failWrite = false, initialized;
    const extraBooks = new Map();
    const contextData = { chatId: 'integration-chat', chatMetadata: { integrity: 'stable-integration-chat' }, characterId: 0, name1: '主角', characters: [{ name: '测试角色卡', avatar: 'test-card.png', data: { extensions: { world: '主世界书' } } }], chat: [] };
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
        fetch: async (_url, options = {}) => {
            let name;
            try { name = JSON.parse(options.body ?? '{}').name; worldbookReads.push(name); } catch {}
            return { ok: true, json: async () => structuredClone(name && name !== '主世界书' ? extraBooks.get(name) || { entries: {} } : disk) };
        },
    });
    const script = {
        eventSource: { on() {} }, event_types: {}, saveSettingsDebounced() {}, getRequestHeaders: () => ({}),
        generateRaw: async options => {
            requests.push(options);
            if (failApiRequest) throw new TypeError('Load failed');
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
            return JSON.stringify({ 时间线: latest ? [{ 日期: '日期未知', 人物: '主角', 事件: failWrite ? '服务器拒写时的新事件' : `新增事件${latest}` }] : [] });
        },
    };
    const extensions = { extension_settings, getContext: () => contextData,
        renderExtensionTemplateAsync: async () => readFile(new URL('./settings.html', import.meta.url), 'utf8') };
    const world = {
        selected_world_info: [], world_info: {}, world_names: ['主世界书'],
        loadWorldInfo: async name => structuredClone(name && name !== '主世界书' ? extraBooks.get(name) || { entries: {} } : cache),
        saveWorldInfo: async (name, data) => {
            if (name && name !== '主世界书') { if (!failWrite) extraBooks.set(name, structuredClone(data)); return; }
            cache = structuredClone(data); if (!failWrite) disk = structuredClone(data);
        },
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
    const pluginState = modules.get(resolve(root, 'state.js')).namespace.state;
    for (const key of ['fullPrompt', 'incrementalPrompt']) {
        assert.ok(extension_settings.cwb_system_api[key].startsWith('旧的自定义'));
        assert.ok(extension_settings.cwb_system_api[key].includes('CWB角色档案整理规则'));
        assert.ok(extension_settings.cwb_system_api[key].includes('角色已知信息.N'));
        assert.ok(extension_settings.cwb_system_api[key].includes('性经历人数'));
    }
    assert.ok(extension_settings.cwb_system_api.timelineIncrementalPrompt.startsWith('旧自定义时间线提示词'));
    assert.ok(extension_settings.cwb_system_api.timelineIncrementalPrompt.includes('仅合并同一故事线中有因果关系的事件'));
    assert.ok(extension_settings.cwb_system_api.timelineIncrementalPrompt.includes('不因日期相同合并无关事件'));
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
    assert.match(savedProfile, /性经历人员\]:/);
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
    const identityTag = 'CWB:聊天身份:stable-integration-chat';
    assert.ok(Object.values(disk.entries).some(entry => entry.key.includes('CWB:更新状态') && entry.key.includes(identityTag)));
    contextData.chatId = 'integration-chat-renamed';
    modules.get(resolve(root, 'state.js')).namespace.state.chatId = 'integration-chat-renamed';
    const renamedProgress = await progressStore.getModuleProgress();
    assert.ok(renamedProgress.timeline.completed.length > 0, 'stable chat metadata retains progress after the chat filename changes');
    contextData.chatId = 'integration-chat';
    modules.get(resolve(root, 'state.js')).namespace.state.chatId = 'integration-chat';
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
    contextData.chatId = 'migration-chat';
    contextData.chatMetadata = { integrity: 'migration-integrity' };
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
    contextData.chatId = 'integration-recovered';
    contextData.chatMetadata = { integrity: 'new-integrity' };
    modules.get(resolve(root, 'state.js')).namespace.state.chatId = 'integration-recovered';
    const recoveryCandidates = await progressStore.getProgressRecoveryCandidates();
    assert.ok(recoveryCandidates.some(item => item.chatId === 'integration-chat'), 'unmatched prior progress is offered as an explicit recovery candidate');
    await progressStore.copyProgressFromChat('integration-chat');
    assert.ok(Object.values(disk.entries).some(entry => entry.key.includes('CWB:更新状态') && entry.key.includes('integration-chat')), 'source progress remains intact after recovery');
    assert.ok(Object.values(disk.entries).some(entry => entry.key.includes('CWB:更新状态') && entry.key.includes('integration-recovered')), 'recovered progress is copied under the current chat ID');
    contextData.chatId = 'integration-chat';
    contextData.chatMetadata = { integrity: 'stable-integration-chat' };
    modules.get(resolve(root, 'state.js')).namespace.state.chatId = 'integration-chat';
    const beforeDelete = structuredClone(disk);
    const lorebook = modules.get(resolve(root, 'lorebook.js')).namespace;
    const reviewBaseline = structuredClone(disk);
    const infoReview = await lorebook.getProfileInfoReviewQueue();
    const reviewedFact = infoReview.characters.flatMap(character => character.facts).find(fact => fact.category === '已知信息');
    assert.ok(reviewedFact, 'manual review finds generated known facts for the current chat');
    disk.entries[reviewedFact.uid].content += '\n并发修改保护测试';
    await assert.rejects(lorebook.deleteReviewedProfileFact(infoReview, reviewedFact), /档案已变化/);
    disk = structuredClone(reviewBaseline);
    cache = structuredClone(disk);
    await lorebook.deleteReviewedProfileFact(infoReview, reviewedFact);
    const reviewedEntryAfter = disk.entries[reviewedFact.uid];
    assert.ok(!reviewedEntryAfter.content.split(/\r?\n/).includes(reviewedFact.line), 'delete removes only the selected information line');
    assert.ok(reviewedEntryAfter.content.includes('[角色未知信息.0]'), 'other known/unknown fields remain untouched');
    assert.ok(reviewedEntryAfter.content.includes('[剧情.0]'), 'story fields remain untouched');
    disk = structuredClone(reviewBaseline);
    cache = structuredClone(disk);
    const infoEntry = disk.entries[reviewedFact.uid];
    const infoLines = infoEntry.content.split(/\r?\n/);
    infoLines[reviewedFact.lineIndex] = `${reviewedFact.line}，独立事实B,独立事实C`;
    infoEntry.content = infoLines.join('\n');
    cache = structuredClone(disk);
    const splitQueue = await lorebook.getProfileInfoReviewQueue();
    let splitFacts = splitQueue.characters.flatMap(character => character.facts).filter(fact => fact.field === reviewedFact.field);
    assert.equal(splitFacts.map(fact => fact.value).join('|'), '本轮确认的重要事实|独立事实B|独立事实C', 'comma and Chinese comma delimit separate review facts');
    const middle = splitFacts[1];
    const middleResult = await lorebook.deleteReviewedProfileFact(splitQueue, middle);
    assert.match(disk.entries[middle.uid].content, /本轮确认的重要事实[,，]独立事实C/);
    assert.doesNotMatch(disk.entries[middle.uid].content, /独立事实B/);
    const afterMiddleQueue = await lorebook.getProfileInfoReviewQueue();
    splitFacts = afterMiddleQueue.characters.flatMap(character => character.facts).filter(fact => fact.field === reviewedFact.field);
    assert.equal(splitFacts.map(fact => fact.value).join('|'), '本轮确认的重要事实|独立事实C', 'remaining adjacent facts remain independently reviewable');
    await lorebook.deleteReviewedProfileFact(afterMiddleQueue, splitFacts[1]);
    assert.match(disk.entries[reviewedFact.uid].content, /本轮确认的重要事实/);
    assert.doesNotMatch(disk.entries[reviewedFact.uid].content, /独立事实C/);
    assert.ok(middleResult.content.includes('[角色未知信息.0]'), 'segment deletion preserves other profile fields');
    disk = structuredClone(reviewBaseline);
    cache = structuredClone(disk);
    const batchInfoEntry = disk.entries[reviewedFact.uid];
    const batchInfoLines = batchInfoEntry.content.split(/\r?\n/);
    batchInfoLines[reviewedFact.lineIndex] = `${reviewedFact.line}，删除测试B,保留测试C，删除测试D`;
    batchInfoEntry.content = batchInfoLines.join('\n');
    cache = structuredClone(disk);
    const batchReview = await lorebook.getProfileInfoReviewQueue();
    const batchFacts = batchReview.characters.flatMap(character => character.facts).filter(fact => fact.field === reviewedFact.field);
    const batchResult = await lorebook.deleteUnretainedProfileFacts(batchReview, [batchFacts[1], batchFacts[3]]);
    const batchSaved = disk.entries[reviewedFact.uid].content;
    assert.match(batchSaved, /本轮确认的重要事实，保留测试C/);
    assert.doesNotMatch(batchSaved, /删除测试B|删除测试D/);
    assert.equal(batchResult.deleted, 2, 'batch delete removes all and only the unselected facts');
    disk = structuredClone(reviewBaseline);
    cache = structuredClone(disk);

    const auditQueue = await lorebook.getProfileCountAuditQueue();
    assert.ok(auditQueue.profiles.length > 0, 'manual count audit lists current-chat generated profiles');
    let auditProfile = auditQueue.profiles[0];
    const auditEntryBefore = disk.entries[auditProfile.uid].content;
    disk.entries[auditProfile.uid].content += '\n并发修改保护测试';
    await assert.rejects(lorebook.saveReviewedProfileCount(auditQueue, auditProfile, 7), /档案已变化/);
    disk = structuredClone(reviewBaseline);
    cache = structuredClone(disk);
    const freshAudit = await lorebook.getProfileCountAuditQueue();
    auditProfile = freshAudit.profiles[0];
    const auditSave = await lorebook.saveReviewedProfileCount(freshAudit, auditProfile, 7);
    const auditEntryAfter = disk.entries[auditProfile.uid].content;
    assert.match(auditEntryAfter, /\[性经历人数\]:7/);
    assert.equal(auditEntryAfter.replace(/^\[性经历人数\]:.*$/m, ''), auditEntryBefore.replace(/^\[性经历人数\]:.*$/m, ''), 'count edit changes no other profile fields');
    assert.equal(auditSave.count, 7);

    const auditButton = $('#cwb-start-profile-audit');
    auditButton.handlers.click.call(auditButton);
    for (let i = 0; i < 100 && auditButton.prop('disabled'); i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(auditButton.prop('disabled'), false);
    assert.match($('#cwb-profile-audit').html(), /选择要核对的角色档案/);
    const auditArea = $('#cwb-profile-audit');
    auditArea.handlers.change.call({ attr: () => auditProfile.id, prop: key => key === 'checked' });
    assert.match(auditArea.html(), /核对所选档案/);
    auditArea.handlers.click.call({ attr: () => 'begin' });
    assert.match(auditArea.html(), /用于对照的个人关键剧情/);
    $('#cwb-audit-dynamic-count').val('8');
    auditArea.handlers.click.call({ attr: () => 'compare' });
    assert.match(auditArea.html(), /动态信息：8 人/);
    assert.match(auditArea.html(), /存在出入/);
    $('#cwb-audit-count').val('7');
    await auditArea.handlers.click.call({ attr: () => 'confirm' });
    assert.match($('#cwb-status').text(), /人数不一致/);
    assert.match(disk.entries[auditProfile.uid].content, /\[性经历人数\]:7/);
    $('#cwb-audit-count').val('8');
    await auditArea.handlers.click.call({ attr: () => 'save' });
    assert.match(auditArea.html(), /核对完成/);
    assert.match(auditArea.html(), /修改 1 条/);
    assert.match(disk.entries[auditProfile.uid].content, /\[性经历人数\]:8/);

    const deleteUid = Math.max(-1, ...Object.keys(disk.entries).map(Number)) + 1;
    disk.entries[deleteUid] = { uid: deleteUid, key: ['手工条目', 'integration-chat'], comment: '手写资料', content: '必须保留' };
    disk.entries[deleteUid + 1] = { uid: deleteUid + 1, key: ['CWB:自动档案', 'other-chat', '角色甲', '1-3'], comment: '动态-角色甲', content: '其他聊天资料' };
    disk.entries[deleteUid + 2] = { uid: deleteUid + 2, key: ['CWB:世界书目录'], comment: '全局目录', content: '全局目录必须保留' };
    disk.entries[deleteUid + 3] = { uid: deleteUid + 3, key: ['CWB:自动档案', 'integration-chat', '角色乙', '1-3'], comment: '动态-角色乙', content: '当前聊天生成档案' };
    disk.entries[deleteUid + 4] = { uid: deleteUid + 4, key: ['integration-chat', '角色丙', 'CWB:自动档案', '1-3'], comment: '动态-角色丙', content: '旧版键顺序的当前聊天生成档案' };
    cache = structuredClone(disk);
    world.world_names.push('无关世界书');
    const previewProgress = [];
    worldbookReads.length = 0;
    const preview = await lorebook.getGeneratedContentPreview(item => previewProgress.push(item));
    assert.deepEqual(worldbookReads, ['主世界书'], 'cleanup uses the primary chat record and does not read unrelated worldbooks');
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
    const reviewButton = $('#cwb-start-info-review');
    reviewButton.handlers.click.call(reviewButton);
    for (let i = 0; i < 100 && reviewButton.prop('disabled'); i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(reviewButton.prop('disabled'), false);
    assert.equal($('#cwb-info-review').prop('hidden'), false);
    assert.match($('#cwb-info-review').html(), /角色 1\//);
    assert.match($('#cwb-info-review').html(), /选择保留/);
    assert.match($('#cwb-info-review').html(), /删除本角色未保留信息/);

    assert.equal(typeof deleteButton.handlers.click, 'function', 'cleanup action is available in the workbench');
    deleteButton.handlers.click.call(deleteButton);
    for (let i = 0; i < 100 && deleteButton.prop('disabled'); i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(deleteButton.prop('disabled'), false);
    assert.match(lastConfirmation, /原始\/手工条目/);
    assert.match(lastConfirmation, /其他聊天数据/);
    assert.match(lastConfirmation, /动态-角色乙/);
    assert.match(lastConfirmation, /动态-角色丙/);
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
    // The mock emits a genuinely new event on failure; stale cache contents no
    // longer control a server-based write, so cache clearing alone is irrelevant.
    cache.entries = {};
    await click();
    assert.ok($('#cwb-status').text().includes('回读与本次写入不一致'));
    assert.equal(Object.values(disk.entries)[0].content.match(/新增事件/g).length, 3);

    // A character profile belongs to the card, not a chat filename or branch.
    failWrite = false;
    const cardProfile = '[姓名]:跨聊天角色\n[角色已知信息.0]:认可与主角保持联系\n[性经历人数]:1\n[剧情.0]:保留在角色卡中的主线剧情';
    const cardOwnerKey = lorebook.getCardArchiveKey();
    world.world_names.push('角色世界书');
    extraBooks.set('角色世界书', { entries: {
        1: { uid: 1, comment: '动态-跨聊天角色', key: ['CWB:自动档案', cardOwnerKey, 'first-chat - Branch #3', '跨聊天角色', '1-20'], disable: true, content: '[姓名]:跨聊天角色\n[剧情.0]:旧聊天剧情' },
        2: { uid: 2, comment: '动态-跨聊天角色', key: ['CWB:自动档案', 'other-chat', '跨聊天角色', '21-40'], disable: false, content: '[姓名]:跨聊天角色\n[剧情.0]:重复条目内容' },
    } });
    contextData.chatMetadata.world_info = '角色世界书';
    disk = { entries: {
        3: { uid: 3, comment: '手工同名条目', key: ['跨聊天角色'], disable: false, content: '手工内容不能覆盖' },
        4: { uid: 4, comment: 'Amily2角色总集-Test - 2026-10-12@09h12m44s596ms - Branch #25-角色总览', key: ['Amily2角色总集', 'Test - 2026-10-12@09h12m44s596ms - Branch #25', '角色总览', '1-150'], disable: false, content: '[旧角色: (详细查看绿灯角色条目)]\n{{// 本条勿动，【前150楼角色世界书已更新完成】}}' },
    } }; cache = structuredClone(disk);
    const cardSettings = { incremental: true, enabled: true, multiWorldbookRouting: false, worldbookTarget: 'primary', scanDepth: 6 };
    contextData.chatId = 'Test - 2026-10-12@09h12m44s596ms - Branch #25';
    pluginState.chatId = contextData.chatId;
    const cardUid = await lorebook.saveCharacterDescription(cardSettings, '跨聊天角色', cardProfile, 0, 19);
    assert.equal(cardUid, '跨聊天角色');
    assert.equal(Object.keys(disk.entries).length + Object.keys(extraBooks.get('角色世界书').entries).length, 4, 'legacy duplicate archives are reused without creating or merging records');
    const canonical = Object.values(extraBooks.get('角色世界书').entries).find(entry => entry.key.includes(lorebook.getCardArchiveKey()) && entry.content.includes('认可与主角保持联系'));
    assert.ok(canonical, `saved archive has a stable character-card owner key: ${JSON.stringify(disk.entries)}`);
    assert.deepEqual(canonical.key, ['CWB:自动档案', cardOwnerKey, '跨聊天角色'], 'profile keys contain the card identity, not the chat ID or chat-floor range');
    const canonicalUid = canonical.uid;
    const untouchedDuplicate = Object.values(extraBooks.get('角色世界书').entries).find(entry => entry.uid !== canonicalUid);
    assert.ok(untouchedDuplicate.content.includes('旧聊天剧情') || untouchedDuplicate.content.includes('重复条目内容'));
    assert.deepEqual(extraBooks.get('角色世界书').entries[1].key, ['CWB:自动档案', cardOwnerKey, '跨聊天角色'], 'legacy card profile is re-keyed in place without deleting its saved copy');
    contextData.chatId = 'Test - 2026-10-12@09h12m44s596ms - Branch #31';
    pluginState.chatId = contextData.chatId;
    contextData.chatMetadata.integrity = 'different-chat-integrity';
    await lorebook.saveCharacterDescription(cardSettings, '跨聊天角色', `${cardProfile}\n[剧情.1]:新聊天补充的剧情`, 0, 19);
    assert.equal(Object.keys(disk.entries).length + Object.keys(extraBooks.get('角色世界书').entries).length, 4, 'changing chat and branch still reuses the same card profile');
    assert.equal(extraBooks.get('角色世界书').entries[canonicalUid].content.includes('新聊天补充的剧情'), true);
    assert.equal(disk.entries[3].content, '手工内容不能覆盖');
    await lorebook.updateRoster(cardSettings, ['跨聊天角色'], 0, 19);
    contextData.chatId = 'Test - 2026-10-12@09h12m44s596ms - Branch #32';
    pluginState.chatId = contextData.chatId;
    await lorebook.saveCharacterDescription(cardSettings, '跨聊天角色', `${cardProfile}\n[剧情.2]:同一聊天继续补充`, 0, 19);
    await lorebook.updateRoster(cardSettings, ['跨聊天角色'], 0, 19);
    assert.equal(Object.values(disk.entries).filter(entry => entry.key?.includes('Amily2角色总集')).length, 1, 'same logical chat branch updates reuse one role overview record');
    assert.equal(Object.values(extraBooks.get('角色世界书').entries).filter(entry => entry.key?.some(key => key.startsWith('CWB:角色卡:')) && entry.key?.includes('CWB:自动档案')).length, 1, 'same logical chat branch updates reuse one dynamic profile');
    assert.ok(Object.values(disk.entries).find(entry => entry.key?.includes('Amily2角色总集')).key.includes(lorebook.getCardArchiveKey()), 'role overview ownership is tied to the character card');
    await lorebook.verifyProfileContent(cardSettings, '跨聊天角色', extraBooks.get('角色世界书').entries[canonicalUid].content);
    assert.ok((await lorebook.getProfileInfoReviewQueue()).characters.some(character => character.name === '跨聊天角色'), 'card-owned profile remains visible in information review');
    assert.ok((await lorebook.getProfileCountAuditQueue()).profiles.some(profile => profile.name === '跨聊天角色'), 'card-owned profile remains visible in count review');
    const generatedPreview = await lorebook.getGeneratedContentPreview();
    assert.ok(generatedPreview.entries.some(entry => entry.uid === canonicalUid && entry.bookName === '角色世界书'), 'one-click preview finds the card-owned profile in its role worldbook');
    assert.ok(generatedPreview.entries.some(entry => entry.marker === 'Amily2角色总集' && entry.keys.includes(lorebook.getCardArchiveKey())), 'one-click preview finds the card-owned role overview record');

    // Explicit migration converts every legacy chat-owned profile in the card's
    // associated books, including entries from replaced chats, without merging.
    extraBooks.get('角色世界书').entries[20] = { uid: 20, comment: '动态-跨聊天角色旧副本', key: ['CWB:自动档案', 'replaced-chat-1', '跨聊天角色', '1-20'], disable: false, content: '[姓名]:跨聊天角色\n[剧情.0]:旧聊天关键剧情' };
    extraBooks.get('角色世界书').entries[21] = { uid: 21, comment: '动态-其他卡角色', key: ['CWB:自动档案', 'CWB:角色卡:other-card', '其他角色'], disable: false, content: '[姓名]:其他角色\n[剧情.0]:其他卡内容' };
    world.world_names.push('未激活旧档案世界书');
    extraBooks.set('未激活旧档案世界书', { entries: {
        30: { uid: 30, comment: '动态-未被目录引用的旧角色', key: ['CWB:自动档案', 'replaced-chat-3', '未被目录引用的旧角色', '1-20'], disable: false, content: '[姓名]:未被目录引用的旧角色\n[剧情.0]:未激活世界书里的旧档案' },
    } });
    disk.entries[12] = { uid: 12, comment: '主角档案-旧聊天', key: ['CWB:主角档案', 'replaced-chat-2', '主角', '1-20'], disable: false, content: '[姓名]:主角\n[剧情.0]:旧聊天主线信息' };
    cache = structuredClone(disk);
    const migrationPreview = await lorebook.previewChatBoundProfilesForCardMigration(cardSettings);
    assert.equal(JSON.stringify(migrationPreview.candidates.map(item => item.uid).sort((a, b) => a - b)), JSON.stringify([2, 12, 20, 30]), 'preview scans unreferenced books too, includes every old-chat copy and skips card-owned records');
    const scanButton = $('#cwb-scan-card-profile-migration');
    assert.equal(typeof scanButton.handlers.click, 'function', 'old profile migration scan button is registered');
    scanButton.handlers.click.call(scanButton);
    for (let i = 0; i < 100 && scanButton.prop('disabled'); i++) await new Promise(r => setTimeout(r, 5));
    assert.match($('#cwb-card-profile-migration-preview').text(), /UID 20/);
    assert.match($('#cwb-card-profile-migration-preview').text(), /UID 12/);
    assert.match($('#cwb-card-profile-migration-preview').text(), /UID 30/);
    const convertButton = $('#cwb-convert-card-profile-migration');
    assert.equal(typeof convertButton.handlers.click, 'function', 'confirmation button is registered after listing entries');
    convertButton.handlers.click.call(convertButton);
    for (let i = 0; i < 100 && convertButton.prop('disabled'); i++) await new Promise(r => setTimeout(r, 5));
    assert.match($('#cwb-status').text(), /4 条档案转换/);
    assert.equal(JSON.stringify(extraBooks.get('角色世界书').entries[2].key), JSON.stringify(['CWB:自动档案', cardOwnerKey, '跨聊天角色']));
    assert.equal(JSON.stringify(disk.entries[12].key), JSON.stringify(['CWB:主角档案', cardOwnerKey, '主角']));
    assert.equal(JSON.stringify(extraBooks.get('角色世界书').entries[20].key), JSON.stringify(['CWB:自动档案', cardOwnerKey, '跨聊天角色']));
    assert.equal(JSON.stringify(extraBooks.get('未激活旧档案世界书').entries[30].key), JSON.stringify(['CWB:自动档案', cardOwnerKey, '未被目录引用的旧角色']));
    assert.equal(disk.entries[12].content, '[姓名]:主角\n[剧情.0]:旧聊天主线信息', 'migration preserves profile content');
    assert.equal(extraBooks.get('角色世界书').entries[20].content, '[姓名]:跨聊天角色\n[剧情.0]:旧聊天关键剧情', 'migration preserves duplicate content rather than merging it');
    assert.ok(extraBooks.get('角色世界书').entries[21].key.includes('CWB:角色卡:other-card'), 'profile bound to a different card remains untouched');
    await assert.rejects(lorebook.migrateChatBoundProfilesToCard(cardSettings, migrationPreview), /扫描后档案列表发生变化/);
});
