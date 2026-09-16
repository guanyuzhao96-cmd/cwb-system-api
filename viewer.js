import { state } from './state.js';
import { deleteEntries, getEntries, getTargetWorldbook, patchEntries } from './lorebook.js';
import { escapeHtml, notify, parseCustomFormat } from './utils.js';

function currentEntries(entries) {
    const chatId = state.chatId.replace(/ imported/g, '');
    return entries.filter(entry => Array.isArray(entry.keys)
        && entry.keys.includes(chatId)
        && !entry.keys.includes('Amily2角色总集'));
}

export async function openViewer(settings) {
    const bookName = getTargetWorldbook(settings);
    if (!bookName) return notify('warning', '未找到目标世界书。');
    const entries = currentEntries(await getEntries(bookName));
    $('#cwb-viewer-modal').remove();
    const cards = entries.length ? entries.map(entry => {
        const parsed = parseCustomFormat(entry.content);
        const name = parsed?.name || entry.comment || `UID ${entry.uid}`;
        return `<details class="cwb-card" data-uid="${entry.uid}">
            <summary>${escapeHtml(name)} <small>UID ${entry.uid}</small></summary>
            <textarea class="text_pole textarea_compact cwb-profile-content">${escapeHtml(entry.content)}</textarea>
            <div class="cwb-actions">
                <button class="menu_button cwb-save-profile"><i class="fa-solid fa-floppy-disk"></i> 保存</button>
                <button class="menu_button redWarningBG cwb-delete-profile"><i class="fa-solid fa-trash"></i> 删除</button>
            </div>
        </details>`;
    }).join('') : '<div class="cwb-note">当前聊天还没有角色档案。</div>';
    $('body').append(`<div id="cwb-viewer-modal" class="cwb-modal">
        <div class="cwb-modal-box">
            <div class="cwb-modal-head"><b>角色档案 · ${escapeHtml(bookName)}</b><button class="menu_button cwb-close-viewer">关闭</button></div>
            ${cards}
        </div>
    </div>`);
    $('#cwb-viewer-modal').on('click', event => {
        if (event.target.id === 'cwb-viewer-modal') $('#cwb-viewer-modal').remove();
    });
    $('.cwb-close-viewer').on('click', () => $('#cwb-viewer-modal').remove());
    $('.cwb-save-profile').on('click', async function () {
        const card = $(this).closest('.cwb-card');
        const uid = Number(card.data('uid'));
        try {
            await patchEntries(bookName, [{ uid, content: card.find('.cwb-profile-content').val() }]);
            notify('success', '角色档案已保存。');
        } catch (error) { notify('error', `保存失败：${error.message}`); }
    });
    $('.cwb-delete-profile').on('click', async function () {
        const card = $(this).closest('.cwb-card');
        const uid = Number(card.data('uid'));
        if (!confirm(`确定删除 UID ${uid} 的角色档案吗？`)) return;
        try {
            await deleteEntries(bookName, [uid]);
            card.remove();
            notify('success', '角色档案已删除。');
        } catch (error) { notify('error', `删除失败：${error.message}`); }
    });
}

export function updateViewerButton(settings) {
    let button = $('#cwb-viewer-button');
    if (!button.length) {
        $('body').append('<button id="cwb-viewer-button" class="menu_button" title="角色档案"><i class="fa-solid fa-address-card"></i></button>');
        button = $('#cwb-viewer-button');
    }
    button.toggle(Boolean(settings.enabled && settings.viewerEnabled));
    button.off('click.cwb').on('click.cwb', () => openViewer(settings));
}
