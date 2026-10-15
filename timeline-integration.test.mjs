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
    let disk = { entries: {} }, cache = structuredClone(disk), failWrite = false, initialized;
    const contextData = { chatId: 'integration-chat', characterId: 0, name1: '主角', characters: [{ data: { extensions: { world: '主世界书' } } }], chat: [] };
    const extension_settings = {};
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
    const context = vm.createContext({ console, structuredClone, setTimeout, clearTimeout, $, window: { jQuery: f => initialized = f },
        fetch: async () => ({ ok: true, json: async () => structuredClone(disk) }),
    });
    const script = {
        eventSource: { on() {} }, event_types: {}, saveSettingsDebounced() {}, getRequestHeaders: () => ({}),
        generateRaw: async options => {
            requests.push(options);
            if (!options.systemPrompt.includes('INTEGRATION_CUSTOM_TIMELINE')) throw Error('custom timeline prompt not used');
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
    const button = $('#cwb-refresh-timeline');
    assert.equal(typeof button.handlers.click, 'function');
    assert.ok(extension_settings.cwb_system_api.timelineIncrementalPrompt.includes('增量整理器'));
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
    assert.equal(Object.values(disk.entries)[0].content.match(/新增事件/g).length, 3);
    assert.ok($('#cwb-timeline-debug').text().includes('保存成功'));
    await click();
    assert.equal(Object.values(disk.entries)[0].content.match(/新增事件/g).length, 3);
    assert.ok($('#cwb-timeline-debug').text().includes('新增 0 条'));
    failWrite = true;
    contextData.chat.push({ mes: '新增事件一。新增事件二。新增事件三。' });
    // Force a visibly different response, so readback must detect failed persistence.
    cache.entries = {};
    await click();
    assert.ok($('#cwb-status').text().includes('回读与本次写入不一致'));
    assert.equal(Object.values(disk.entries)[0].content.match(/新增事件/g).length, 3);
});
