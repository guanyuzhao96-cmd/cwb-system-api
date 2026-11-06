import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { archiveSource, prepareArchiveMessages } from './archive-source.mjs';

test('summary-only floor preserves confirmed facts without body or variable patches', () => {
    const value = '<plot_summary>2025-09-01｜甲将重要证据交给乙，乙据此决定申诉</plot_summary><UpdateVariable><JSONPatch>private-state</JSONPatch></UpdateVariable>';
    assert.deepEqual(archiveSource(value), { kind: 'summary', text: '2025-09-01｜甲将重要证据交给乙，乙据此决定申诉' });
});
test('nonempty dream_body wins over summaries', () => {
    assert.deepEqual(archiveSource('<dream_body>过程细节</dream_body><plot_summary>决定申诉</plot_summary><plot_summary>决定申诉</plot_summary>'), { kind: 'body', text: '过程细节' });
});
test('mixed body, user message and missing-source floors keep their positions and raw receipts', () => {
    const input = [{ mes: '计划寻找证据', is_user: true }, { mes: '<dream_body>找到证据</dream_body>' }, { mes: '<dream_plot><UpdateVariable><Analysis>状态</Analysis></UpdateVariable></dream_plot><StatusPlaceHolderImpl/>' }];
    const original = JSON.stringify(input), result = prepareArchiveMessages(input);
    assert.deepEqual(result.map(row => row.archiveSourceKind), ['body', 'body', 'missing']);
    assert.equal(result[1].message, '找到证据');
    assert.equal(result.length, input.length);
    assert.equal(JSON.stringify(input), original);
    assert.deepEqual(result.map(row => row.mes), input.map(row => row.mes));
});
test('machine-embedded fake summaries never become facts, unknown narrative text remains', () => {
    assert.deepEqual(archiveSource('<UpdateVariable><plot_summary>假事实</plot_summary></UpdateVariable>真实叙述'), { kind: 'body', text: '真实叙述' });
    assert.equal(archiveSource('<plot_summary> </plot_summary><dream_body>仍有正文</dream_body>').text, '仍有正文');
});

test('optional private summary-only chat preserves all floors and each retained summary', { skip: !process.env.CWB_PRIVATE_SUMMARY_CHAT }, () => {
    const rows = readFileSync(process.env.CWB_PRIVATE_SUMMARY_CHAT, 'utf8').trim().split('\n').map(JSON.parse).slice(1);
    const original = JSON.stringify(rows), prepared = prepareArchiveMessages(rows);
    assert.equal(prepared.length, rows.length);
    let count = 0;
    rows.forEach((row, index) => {
        const chunks = [...row.mes.matchAll(/<plot_summary>([\s\S]*?)<\/plot_summary>/g)].map(m => m[1].trim()).filter(Boolean);
        if (!chunks.length) return;
        count++;
        const bodies = [...row.mes.matchAll(/<dream_body\b[^>]*>([\s\S]*?)<\/dream_body\s*>/gi)].map(m => archiveSource(m[0])).filter(source => source.kind === 'body');
        if (bodies.length) { assert.equal(prepared[index].archiveSourceKind, 'body'); return; }
        assert.equal(prepared[index].archiveSourceKind, 'summary');
        for (const chunk of chunks) assert.ok(prepared[index].message.includes(chunk));
        assert.ok(!prepared[index].message.includes('<UpdateVariable>'));
    });
    assert.ok(count > 0);
    assert.equal(JSON.stringify(rows), original);
    console.log(JSON.stringify({ privateSummaryFloors: rows.length, summariesRead: count }));
});

test('empty or machine-only dream_body falls back to deduplicated summaries', () => {
 assert.deepEqual(archiveSource('<dream_body>  <UpdateVariable>补丁</UpdateVariable></dream_body><plot_summary>确认事实</plot_summary><plot_summary>确认事实</plot_summary>'), {kind:'summary',text:'确认事实'});
});
