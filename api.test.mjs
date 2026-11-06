import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const reply = '[--角色档案开始--]\n[档案类型]:主角\n[姓名]:主角\n[剧情.0]:2025-09-02｜重要约定改变后续安排\n[--角色档案结束--]\n[--时间线增量开始--]\n{"时间线":[]}\n[--时间线增量结束--]';
const messages = [{ role: 'system', content: '只整理档案' }, { role: 'user', content: '已发生的重要约定' }];
const ready = 'chat-completion-settings-ready';

async function harness({ api = 'openai', content = reply, finish = 'stop', fail = false, completionTokens = false } = {}) {
    const listeners = new Map(), requests = [], other = { messages: [{ role: 'user', content: '另一个请求' }], max_tokens: 999 };
    const eventSource = {
        on(event, fn) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); },
        removeListener(event, fn) { listeners.get(event)?.delete(fn); },
        async emit(event, data) { for (const fn of listeners.get(event) ?? []) await fn(data); },
    };
    let cleanups = 0;
    const host = {
        main_api: api, eventSource, event_types: { CHAT_COMPLETION_SETTINGS_READY: ready },
        createRawPrompt: (prompt, _api, _instruct, _quiet, system) => [{ role: 'system', content: system }, ...prompt],
        extractMessageFromData: data => data.choices[0].message.content,
        generateRaw: async () => { cleanups++; return content.replace(/\[--角色档案开始--][\s\S]*?\[--角色档案结束--]/g, ''); },
    };
    const openai = { sendOpenAIRequest: async (type, prompt) => {
        await eventSource.emit(ready, other);
        const request = { type, messages: prompt.filter(Boolean), ...(completionTokens ? { max_completion_tokens: 2048 } : { max_tokens: 2048 }) };
        await eventSource.emit(ready, request);
        requests.push(request);
        if (fail) throw Error('model request failed');
        return { choices: [{ message: { content }, finish_reason: finish }] };
    } };
    const context = vm.createContext({ AbortController });
    const module = new vm.SourceTextModule(readFileSync(new URL('./api.js', import.meta.url), 'utf8'), { context });
    await module.link(specifier => {
        const values = specifier === '/script.js' ? host : openai;
        return new vm.SyntheticModule(Object.keys(values), function () { for (const [key, value] of Object.entries(values)) this.setExport(key, value); }, { context });
    });
    await module.evaluate();
    return { api: module.namespace, requests, listeners, other, cleanups: () => cleanups };
}

test('native chat returns the profile envelope before host AI-output regex cleanup', async () => {
    const h = await harness();
    let details;
    assert.equal(await h.api.callSystemApi(messages, null, value => details = value), reply);
    assert.equal(h.cleanups(), 0);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].type, 'quiet');
    assert.equal(details.transport, 'native-chat-unprocessed');
    assert.equal(details.finishReason, 'stop');
    assert.equal(messages.length, 2, 'host formatting must not mutate caller messages');
});

test('per-request token limit leaves concurrent request and global defaults alone', async () => {
    for (const completionTokens of [false, true]) {
        const h = await harness({ completionTokens });
        await h.api.callSystemApi(messages, 4096);
        assert.equal(h.requests[0][completionTokens ? 'max_completion_tokens' : 'max_tokens'], 4096);
        assert.equal(h.other.max_tokens, 999);
        assert.equal(h.listeners.get(ready).size, 0);
    }
});

test('native request failure cleans up the temporary listener and does not retry', async () => {
    const h = await harness({ fail: true });
    await assert.rejects(h.api.callSystemApi(messages, 4096), /model request failed/);
    assert.equal(h.listeners.get(ready).size, 0);
    assert.equal(h.requests.length, 1);
});

test('empty and length-limited replies retain diagnostic finish reason', async () => {
    const h = await harness({ content: '', finish: 'length' });
    await assert.rejects(h.api.callSystemApi(messages), error => error.cwbDiagnostics.finishReason === 'length' && /未返回有效正文/.test(error.message));
});

test('text completion remains compatible and explicitly identifies host cleanup', async () => {
    const h = await harness({ api: 'textgenerationwebui' });
    let details;
    const output = await h.api.callSystemApi(messages, null, value => details = value);
    assert.equal(h.cleanups(), 1);
    assert.equal(h.requests.length, 0);
    assert.ok(!output.includes('[--角色档案开始--]'));
    assert.equal(details.transport, 'generateRaw-host-cleanup');
});

// Optional pinned host source makes the regression exercise the *actual* cleanup
// implementation. No source is downloaded or executed during ordinary tests.
test('pinned SillyTavern generateRaw reproduces profile loss; native chat preserves it', { skip: !process.env.CWB_HOST_SCRIPT_FIXTURE && 'Set CWB_HOST_SCRIPT_FIXTURE to inspected SillyTavern 1.13.5 public/script.js' }, async () => {
    const source = readFileSync(process.env.CWB_HOST_SCRIPT_FIXTURE, 'utf8');
    const slice = (name, following) => source.slice(source.indexOf('export ' + name), source.indexOf(following, source.indexOf('export ' + name))).replace(/^export /, '');
    const script = slice('function createRawPrompt(', '/**\n * Generates a message using')
        + slice('async function generateRaw(', 'class TempResponseLength')
        + slice('function extractMessageFromData(', '/**\n * Extracts JSON from the response')
        + slice('function cleanUpMessage(', '/**\n * Adds an image to the message');
    let nativeCalls = 0, cleanupCalls = 0;
    const context = vm.createContext({
        AbortController, console, main_api: 'openai', name1: '用户', name2: '角色', selected_group: false,
        power_user: { instruct: { enabled: false }, allow_name1_display: true, allow_name2_display: true },
        event_types: { GENERATION_STOPPED: 'stop', CHAT_COMPLETION_PROMPT_READY: 'prompt' },
        eventSource: { on() {}, removeListener() {}, async emit() {} },
        TempResponseLength: { setupEventHook() {}, isCustomized: () => false },
        substituteParams: text => text, getStoppingStrings: () => [],
        regex_placement: { AI_OUTPUT: 2 },
        getRegexedString: text => { cleanupCalls++; return text.replace(/\[--角色档案开始--][\s\S]*?\[--角色档案结束--]/g, ''); },
        PromptReasoning: { getLatestPrefix: () => '' },
        sendOpenAIRequest: async () => { nativeCalls++; return { choices: [{ message: { content: reply }, finish_reason: 'stop' }] }; },
    });
    vm.runInContext(script, context);
    const cleaned = await context.generateRaw({ prompt: messages.map(item => ({ ...item })), trimNames: false });
    assert.ok(!cleaned.includes('[--角色档案开始--]'));
    assert.equal(cleanupCalls, 1, 'trimNames:false does not disable regex execution');
    const raw = context.extractMessageFromData(await context.sendOpenAIRequest('quiet', []), 'openai');
    assert.equal(raw, reply);
    assert.equal(nativeCalls, 2);
    assert.equal(cleanupCalls, 1);
});
