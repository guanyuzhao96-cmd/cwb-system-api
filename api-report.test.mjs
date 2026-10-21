import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createErrorReport } from './error-report.js';
import { PLUGIN_VERSION } from './version.mjs';

test('release version agrees across manifest, visible UI and diagnostic reports', () => {
    const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
    const html = readFileSync(new URL('./settings.html', import.meta.url), 'utf8');
    const previous = globalThis.document;
    try {
        globalThis.document = { getElementById: () => null };
        const report = createErrorReport(Error('测试'), { responseDiagnostics: { responseCharacters: 12 } });
        assert.equal(report.pluginVersion, manifest.version);
        assert.equal(report.pluginVersion, PLUGIN_VERSION);
        assert.ok(html.includes(`WORLD BOOK · ${PLUGIN_VERSION}`));
        assert.equal(report.operation.responseDiagnostics.responseCharacters, 12);
    } finally {
        if (previous === undefined) delete globalThis.document;
        else globalThis.document = previous;
    }
});

test('system API rejects object/empty results instead of converting them into pretend text', { skip: !vm.SourceTextModule }, async () => {
    let reply, calls = 0;
    const context = vm.createContext({ console });
    const host = new vm.SyntheticModule(['generateRaw'], function () {
        this.setExport('generateRaw', async () => { calls++; return reply; });
    }, { context });
    const extensions = new vm.SyntheticModule(['getContext'], function () { this.setExport('getContext', () => ({ mainApi: 'openai' })); }, { context });
    const api = new vm.SourceTextModule(readFileSync(new URL('./api.js', import.meta.url), 'utf8'), { context });
    await api.link(path => path.includes('extensions.js') ? extensions : host);
    await api.evaluate();
    reply = { content: 'not the verified return contract' };
    await assert.rejects(api.namespace.callSystemApi([{ role: 'user', content: '测试' }]), /返回类型为 object/);
    reply = '   ';
    await assert.rejects(api.namespace.callSystemApi([{ role: 'user', content: '测试' }]), /未返回有效内容/);
    reply = '  正常文本  ';
    assert.equal(await api.namespace.callSystemApi([{ role: 'user', content: '测试' }]), '正常文本');
    assert.equal(calls, 3, 'each operation makes exactly one generation request');
});

test('structured requests pass the host schema only for chat completion and never retry a failed request', { skip: !vm.SourceTextModule }, async () => {
    let mainApi = 'openai', calls = 0, options, fail = false;
    const context = vm.createContext({ console });
    const host = new vm.SyntheticModule(['generateRaw'], function () {
        this.setExport('generateRaw', async value => { calls++; options = value; if (fail) throw Error('schema unsupported'); return '{"角色档案":[]}'; });
    }, { context });
    const extensions = new vm.SyntheticModule(['getContext'], function () { this.setExport('getContext', () => ({ mainApi })); }, { context });
    const api = new vm.SourceTextModule(readFileSync(new URL('./api.js', import.meta.url), 'utf8'), { context });
    await api.link(path => path.includes('extensions.js') ? extensions : host);
    await api.evaluate();
    const schema = { name: 'fixture', value: { type: 'object' } };
    await api.namespace.callSystemApi([{ role: 'user', content: 'JSON' }], 2048, { jsonSchema: schema });
    assert.equal(options.jsonSchema, schema);
    mainApi = 'textgenerationwebui';
    await api.namespace.callSystemApi([{ role: 'user', content: 'JSON' }], 2048, { jsonSchema: schema });
    assert.equal(options.jsonSchema, undefined);
    fail = true;
    await assert.rejects(api.namespace.callSystemApi([{ role: 'user', content: 'JSON' }], 2048, { jsonSchema: schema }), /schema unsupported/);
    assert.equal(calls, 3);
});
