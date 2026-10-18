import { countProfileTokens, tokenReduction } from './profile-compaction.mjs';

export async function openProfileCompactionDialog({ load, compact, escapeHtml: e }) {
    if (document.querySelector('.cwb-compaction-dialog')) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'cwb-compaction-dialog';
    dialog.innerHTML = '<h3>选择要精简的角色档案</h3><p data-summary role="status">正在读取档案和 token 数…</p><div data-rows></div><p class="cwb-help">统计完整档案正文的 token 数，使用酒馆当前分词器。默认不勾选；每次 AI 请求处理最多5个角色，自动分批精简所选档案的剧情栏目。</p><div class="cwb-secondary-actions"><button type="button" class="menu_button" data-all>全选</button><button type="button" class="menu_button" data-none>全不选</button><button type="button" class="menu_button" data-start disabled>开始精简</button><button type="button" class="menu_button" data-close>关闭</button></div>';
    document.body.appendChild(dialog);
    const summary = dialog.querySelector('[data-summary]');
    const rows = dialog.querySelector('[data-rows]');
    const start = dialog.querySelector('[data-start]');
    let busy = false, preview;
    const close = () => { if (!busy) dialog.close(); };
    dialog.querySelector('[data-close]').addEventListener('click', close);
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('close', () => dialog.remove());
    dialog.showModal();
    const checked = () => [...rows.querySelectorAll('input:checked')].map(input => preview.candidates[Number(input.value)]);
    const update = () => {
        const selected = checked();
        summary.textContent = `已选 ${selected.length}/${preview.candidates.length} 份档案，共 ${selected.reduce((sum, item) => sum + item.tokens, 0)} tokens`;
        start.disabled = !selected.length;
    };
    rows.addEventListener('change', update);
    for (const [selector, value] of [['[data-all]', true], ['[data-none]', false]]) {
        dialog.querySelector(selector).addEventListener('click', () => {
            rows.querySelectorAll('input').forEach(input => { input.checked = value; });
            if (preview) update();
        });
    }
    try {
        preview = await load();
        for (const item of preview.candidates) item.tokens = await countProfileTokens(item.original);
        if (!dialog.isConnected) return;
        rows.innerHTML = preview.candidates.map((item, index) => `<label class="cwb-compaction-row"><input type="checkbox" value="${index}"><span><strong>${e(item.name)}</strong><small>${e(item.bookName)} · UID ${e(String(item.uid))}</small></span><span>${item.tokens} tokens</span></label>`).join('');
        if (!preview.candidates.length) { summary.textContent = '当前角色卡没有可精简的档案。'; return; }
        update();
    } catch (error) { summary.textContent = `读取失败：${error.message}`; return; }
    start.addEventListener('click', async () => {
        const candidates = checked();
        if (!candidates.length || busy) return;
        busy = true;
        let completed = [];
        dialog.querySelectorAll('button, input').forEach(input => { input.disabled = true; });
        const showResults = results => {
            if (!results?.length) return;
            completed = results;
            rows.innerHTML = results.map(item => `<div class="cwb-compaction-row"><span>${e(item.name)}<small>${e(item.bookName)}</small></span><span>${item.before} → ${item.after} tokens<br>${tokenReduction(item.before, item.after)}</span></div>`).join('');
        };
        try {
            const result = await compact({ ...preview, candidates }, progress => {
                summary.textContent = progress.phase === 'batch'
                    ? `正在精简第 ${progress.batch}/${progress.batches} 批（每批最多5个角色）：${progress.names.join('、')}`
                    : `正在保存核验 ${progress.current}/${progress.total}：${progress.name}`;
                showResults(progress.results);
            });
            showResults(result.results);
            summary.textContent = `精简完成：${result.results.length} 份档案，${result.before} → ${result.after} tokens，${tokenReduction(result.before, result.after)}。`;
        } catch (error) {
            summary.textContent = `精简已停止：${error.message}。已完成并核验 ${completed.length} 份档案。`;
        } finally {
            busy = false;
            dialog.querySelector('[data-close]').disabled = false;
        }
    });
}
