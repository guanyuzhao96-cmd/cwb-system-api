import {
    eventSource,
    event_types,
    saveSettingsDebounced,
} from '/script.js';
import {
    extension_settings,
    renderExtensionTemplateAsync,
} from '/scripts/extensions.js';
import { cwbCompleteDefaultSettings } from './defaults.js';
import { testSystemApi } from './api.js';
import { batchUpdate, maybeAutoUpdate, onChatChanged, refreshChatState, updateRange, updateRecent } from './core.js';
import { convertLegacyEntries, listWorldbooks, routeSummary } from './lorebook.js';
import { MODULE_NAME, state } from './state.js';
import { notify } from './utils.js';
import { openViewer, updateViewerButton } from './viewer.js';

const defaults = {
    enabled: false,
    autoUpdate: false,
    incremental: true,
    viewerEnabled: true,
    threshold: 20,
    scanDepth: 6,
    responseLength: 0,
    worldbookTarget: 'primary',
    customWorldbook: '',
    multiWorldbookRouting: true,
    worldbookRoutes: {},
    breakPrompt: cwbCompleteDefaultSettings.cwb_break_armor_prompt,
    fullPrompt: cwbCompleteDefaultSettings.cwb_char_card_prompt,
    incrementalPrompt: cwbCompleteDefaultSettings.cwb_incremental_char_card_prompt,
};

function settings() {
    extension_settings[MODULE_NAME] ??= structuredClone(defaults);
    Object.entries(defaults).forEach(([key, value]) => {
        if (extension_settings[MODULE_NAME][key] === undefined) extension_settings[MODULE_NAME][key] = value;
    });
    return extension_settings[MODULE_NAME];
}

function saveFromUi() {
    const value = settings();
    value.enabled = $('#cwb-enabled').prop('checked');
    value.autoUpdate = $('#cwb-auto-update').prop('checked');
    value.incremental = $('#cwb-incremental').prop('checked');
    value.viewerEnabled = $('#cwb-viewer-enabled').prop('checked');
    value.multiWorldbookRouting = $('#cwb-multi-routing').prop('checked');
    value.threshold = Math.max(1, Number($('#cwb-threshold').val()) || 20);
    value.scanDepth = Math.max(1, Number($('#cwb-scan-depth').val()) || 6);
    value.responseLength = Math.max(0, Number($('#cwb-response-length').val()) || 0);
    value.worldbookTarget = $('#cwb-worldbook-target').val();
    value.customWorldbook = $('#cwb-custom-worldbook').val() || '';
    value.breakPrompt = $('#cwb-break-prompt').val();
    value.fullPrompt = $('#cwb-full-prompt').val();
    value.incrementalPrompt = $('#cwb-incremental-prompt').val();
    try { value.worldbookRoutes = JSON.parse($('#cwb-worldbook-routes').val() || '{}'); }
    catch { value.worldbookRoutes = {}; }
    state.routeCache = null;
    saveSettingsDebounced();
    $('#cwb-custom-worldbook-wrap').toggle(value.worldbookTarget === 'custom');
    updateViewerButton(value);
}

function loadUi() {
    const value = settings();
    $('#cwb-enabled').prop('checked', value.enabled);
    $('#cwb-auto-update').prop('checked', value.autoUpdate);
    $('#cwb-incremental').prop('checked', value.incremental);
    $('#cwb-viewer-enabled').prop('checked', value.viewerEnabled);
    $('#cwb-multi-routing').prop('checked', value.multiWorldbookRouting);
    $('#cwb-threshold').val(value.threshold);
    $('#cwb-scan-depth').val(value.scanDepth);
    $('#cwb-response-length').val(value.responseLength);
    $('#cwb-worldbook-target').val(value.worldbookTarget);
    const select = $('#cwb-custom-worldbook').empty();
    select.append('<option value="">请选择</option>');
    listWorldbooks().forEach(name => select.append($('<option>').val(name).text(name)));
    select.val(value.customWorldbook);
    $('#cwb-break-prompt').val(value.breakPrompt);
    $('#cwb-full-prompt').val(value.fullPrompt);
    $('#cwb-incremental-prompt').val(value.incrementalPrompt);
    $('#cwb-worldbook-routes').val(JSON.stringify(value.worldbookRoutes || {}, null, 2));
    $('#cwb-custom-worldbook-wrap').toggle(value.worldbookTarget === 'custom');
    updateViewerButton(value);
}

async function runButton(button, label, action) {
    const original = button.html();
    button.prop('disabled', true).text(label);
    try { await action(); }
    catch (error) {
        console.error('[CWB]', error);
        notify('error', error.message);
        $('#cwb-status').text(`错误：${error.message}`);
    } finally { button.prop('disabled', false).html(original); }
}

function bindUi() {
    $('#cwb-system-settings').on('input change', 'input, textarea, select', saveFromUi);
    $('#cwb-test-api').on('click', function () {
        runButton($(this), '测试中…', async () => notify('success', await testSystemApi()));
    });
    $('#cwb-manual-update').on('click', function () {
        runButton($(this), '更新中…', () => updateRecent(settings()));
    });
    $('#cwb-range-update').on('click', function () {
        runButton($(this), '更新中…', () => {
            const start = Number($('#cwb-start-floor').val());
            const end = Number($('#cwb-end-floor').val());
            if (!start || !end || start > end) throw new Error('请输入有效的起止楼层。');
            return updateRange(settings(), start - 1, end - 1);
        });
    });
    $('#cwb-batch-update').on('click', async function () {
        if (state.batchRunning) {
            state.batchStopRequested = true;
            $(this).text('正在停止…');
            return;
        }
        const button = $(this);
        const original = button.html();
        try {
            await batchUpdate(settings(), (current, total) => {
                button.text(current ? `点击停止（${current}/${total}）` : '批量更新全聊天');
            });
        } catch (error) { notify('error', `批量更新失败：${error.message}`); }
        finally { button.html(original); }
    });
    $('#cwb-open-viewer').on('click', () => openViewer(settings()));
    $('#cwb-convert-format').on('click', function () {
        runButton($(this), '转换中…', () => convertLegacyEntries(settings()));
    });
    $('#cwb-reset-prompts').on('click', () => {
        const value = settings();
        value.breakPrompt = defaults.breakPrompt;
        value.fullPrompt = defaults.fullPrompt;
        value.incrementalPrompt = defaults.incrementalPrompt;
        saveSettingsDebounced();
        loadUi();
        notify('success', '已加载 v0.4 新版提示词，主角与角色更新规则均已启用。');
    });
    $('#cwb-scan-routes').on('click', async function () {
        try {
            const summary = await routeSummary(settings());
            $('#cwb-route-status').text(summary || '没有发现可识别的世界书。');
            notify('success', '世界书角色归属扫描完成。');
        } catch (error) { notify('error', `扫描失败：${error.message}`); }
    });
}

async function init() {
    const html = await renderExtensionTemplateAsync('third-party/cwb-system-api', 'settings');
    $('#extensions_settings2').append(html);
    loadUi();
    bindUi();
    refreshChatState();
    await onChatChanged(settings()).catch(error => console.warn('[CWB] 初始化聊天状态失败', error));
    eventSource.on(event_types.CHAT_CHANGED, () => setTimeout(() => onChatChanged(settings()).catch(console.error), 200));
    eventSource.on(event_types.MESSAGE_RECEIVED, () => maybeAutoUpdate(settings()));
    console.info('[CWB] 角色世界书（系统 API 版）已加载。');
}

window.jQuery(init);
