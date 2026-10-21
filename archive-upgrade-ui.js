import { escapeHtml } from './utils.js';

export function openArchiveUpgradeDialog(preview, apply) {
    document.getElementById('cwb-format-upgrade-modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'cwb-format-upgrade-modal';
    modal.className = 'cwb-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', '全部资料格式升级');
    const candidates = preview.candidates;
    const available = candidates.filter(item => item.changed && !item.error);
    const blocked = candidates.filter(item => item.error);
    const clip = value => String(value ?? '').slice(0, 600) + (String(value ?? '').length > 600 ? '\n（预览节选，升级使用完整原文）' : '');
    modal.innerHTML = `<div class="cwb-modal-box cwb-upgrade-dialog">
        <div class="cwb-modal-head"><b>全部资料格式升级</b><button type="button" class="menu_button" data-close>关闭</button></div>
        <p class="cwb-help">扫描 ${preview.booksScanned} 本世界书，可升级 ${available.length} 条，需核对 ${blocked.length} 条。直接按原 UID 升级，不调用 AI，不下载或创建备份。</p>
        <p class="cwb-help">未确认归属的旧条目默认不勾选；请核对它们属于当前角色卡。全选会包含这些旧条目。</p>
        <div class="cwb-actions"><button type="button" class="menu_button" data-all>全选可升级资料</button><button type="button" class="menu_button" data-none>清空选择</button></div>
        <div class="cwb-upgrade-list">${candidates.map(item => {
            const disabled = item.error || !item.changed;
            const status = item.error ? `需核对：${item.error}` : !item.changed ? '已是最新格式' : item.needsOwnerConfirmation ? '旧资料，请确认归属后勾选' : '可升级';
            return `<div class="cwb-upgrade-item"><label><input type="checkbox" data-upgrade-id="${escapeHtml(item.id)}" ${disabled ? 'disabled' : ''} ${item.defaultSelected ? 'checked' : ''}><span><b>${escapeHtml(item.label)} · ${escapeHtml(item.title)}</b><small>《${escapeHtml(item.bookName)}》｜UID ${item.uid}｜${escapeHtml(status)}</small></span></label>
                ${item.next ? `<details><summary>预览转换前后</summary><b>转换前</b><pre class="cwb-route-status">${escapeHtml(clip(item.original.content))}</pre><b>转换后</b><pre class="cwb-route-status">${escapeHtml(clip(item.next.content))}</pre></details>` : ''}</div>`;
        }).join('') || '<p>没有找到插件生成的资料。</p>'}</div>
        <div class="cwb-actions"><button type="button" class="menu_button cwb-primary" data-apply>直接升级所选资料</button></div>
        <div data-status class="cwb-route-status" role="status"></div>
    </div>`;
    document.body.appendChild(modal);
    const close = modal.querySelector('[data-close]');
    const button = modal.querySelector('[data-apply]');
    const status = modal.querySelector('[data-status]');
    const checkboxes = [...modal.querySelectorAll('[data-upgrade-id]')];
    close.addEventListener('click', () => modal.remove());
    modal.querySelector('[data-all]').addEventListener('click', () => checkboxes.forEach(box => { if (!box.disabled) box.checked = true; }));
    modal.querySelector('[data-none]').addEventListener('click', () => checkboxes.forEach(box => { if (!box.disabled) box.checked = false; }));
    button.disabled = !available.length;
    button.addEventListener('click', async () => {
        const ids = checkboxes.filter(box => box.checked && !box.disabled).map(box => box.dataset.upgradeId);
        if (!ids.length) { status.textContent = '请先勾选要升级的资料'; return; }
        button.disabled = true;
        close.disabled = true;
        modal.querySelectorAll('[data-all], [data-none], [data-upgrade-id]').forEach(node => { node.disabled = true; });
        try {
            const result = await apply(ids, {
                onProgress: update => { status.textContent = `升级并核验 ${update.current}/${update.total}：《${update.bookName}》`; },
            });
            status.textContent = `升级完成：${result.converted} 条，${result.booksChanged} 本世界书。${Object.entries(result.byType).map(([type, count]) => `${type} ${count} 条`).join('；')}。`;
            button.textContent = '升级完成';
        } catch (error) {
            status.textContent = `升级已停止：${error.message}。关闭后重新扫描即可继续。`;
        } finally { close.disabled = false; }
    });
}
