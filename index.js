import {
    eventSource,
    event_types,
    saveSettingsDebounced,
} from '/script.js';
import {
    extension_settings,
    renderExtensionTemplateAsync,
} from '/scripts/extensions.js';
import { cwbCompleteDefaultSettings, DEFAULT_TIMELINE_INCREMENTAL_PROMPT, migrateBuiltinProfilePrompt, ensureProfilePromptRules, ensureTimelinePromptRules } from './defaults.js';
import { testSystemApi } from './api.js';
import { createErrorReport, downloadLatestErrorReport } from './error-report.js';
import { batchUpdate, maybeAutoUpdate, onChatChanged, refreshChatState, updateRange, updateRecent, refreshTimeline, updateRelationships, refreshModuleProgress, retryMissingModule } from './core.js';
import { cleanupProfileFields, convertLegacyEntries, copyProgressFromChat, deleteGeneratedContent, deleteReviewedProfileFact, generateWorldbookDirectories, getGeneratedContentPreview, getProfileInfoReviewQueue, getProgressRecoveryCandidates, listWorldbooks, routeSummary } from './lorebook.js';
import { MODULE_NAME, state, acquireOperationLock } from './state.js';
import { escapeHtml, notify } from './utils.js';
import { openViewer, updatePluginButton } from './viewer.js';

const defaults = {
    enabled: false,
    autoUpdate: false,
    incremental: true,
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
    timelineIncrementalPrompt: DEFAULT_TIMELINE_INCREMENTAL_PROMPT,
};

let profileInfoReview = null;
let profileInfoReviewIndex = 0;
let profileInfoReviewDeleted = 0;

function settings() {
    extension_settings[MODULE_NAME] ??= structuredClone(defaults);
    Object.entries(defaults).forEach(([key, value]) => {
        if (extension_settings[MODULE_NAME][key] === undefined) extension_settings[MODULE_NAME][key] = value;
    });
    const current = extension_settings[MODULE_NAME];
    let promptsChanged = false;
    for (const key of ['fullPrompt', 'incrementalPrompt']) {
        const migrated = migrateBuiltinProfilePrompt(current[key], key);
        const enforced = ensureProfilePromptRules(migrated);
        if (enforced !== current[key]) { current[key] = enforced; promptsChanged = true; }
    }
    const timelinePrompt = ensureTimelinePromptRules(current.timelineIncrementalPrompt);
    if (timelinePrompt !== current.timelineIncrementalPrompt) { current.timelineIncrementalPrompt = timelinePrompt; promptsChanged = true; }
    if (promptsChanged) saveSettingsDebounced();
    return extension_settings[MODULE_NAME];
}

function saveFromUi() {
    const value = settings();
    value.enabled = $('#cwb-enabled').prop('checked');
    value.autoUpdate = $('#cwb-auto-update').prop('checked');
    value.incremental = $('#cwb-incremental').prop('checked');
    value.multiWorldbookRouting = $('#cwb-multi-routing').prop('checked');
    value.threshold = Math.max(1, Number($('#cwb-threshold').val()) || 20);
    value.scanDepth = Math.max(1, Number($('#cwb-scan-depth').val()) || 6);
    value.responseLength = Math.max(0, Number($('#cwb-response-length').val()) || 0);
    value.worldbookTarget = $('#cwb-worldbook-target').val();
    value.customWorldbook = $('#cwb-custom-worldbook').val() || '';
    value.breakPrompt = $('#cwb-break-prompt').val();
    value.fullPrompt = $('#cwb-full-prompt').val();
    value.incrementalPrompt = $('#cwb-incremental-prompt').val();
    value.timelineIncrementalPrompt = $('#cwb-timeline-incremental-prompt').val();
    state.routeCache = null;
    saveSettingsDebounced();
    $('#cwb-custom-worldbook-wrap').toggle(value.worldbookTarget === 'custom');
    updatePluginButton();
}

function loadUi() {
    const value = settings();
    $('#cwb-enabled').prop('checked', value.enabled);
    $('#cwb-auto-update').prop('checked', value.autoUpdate);
    $('#cwb-incremental').prop('checked', value.incremental);
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
    $('#cwb-timeline-incremental-prompt').val(value.timelineIncrementalPrompt);
    $('#cwb-custom-worldbook-wrap').toggle(value.worldbookTarget === 'custom');
    updatePluginButton();
}

function renderProfileInfoReview() {
    const area = $('#cwb-info-review');
    if (!profileInfoReview) { area.prop('hidden', true).empty(); return; }
    area.prop('hidden', false);
    const characters = profileInfoReview.characters;
    if (!characters.length) {
        area.html('<div class="cwb-review-summary">当前聊天中没有可审查的已知 / 未知信息。</div>');
        return;
    }
    const reviewed = characters.flatMap(character => character.facts).filter(fact => fact.decision).length;
    if (profileInfoReviewIndex >= characters.length) {
        area.html(`<div class="cwb-review-summary">审查完成：已检查 ${reviewed}/${profileInfoReview.totalFacts} 条，删除 ${profileInfoReviewDeleted} 条。<button class="menu_button cwb-full-width" data-review-nav="close">结束审查</button></div>`);
        return;
    }
    const character = characters[profileInfoReviewIndex];
    const decided = character.facts.filter(fact => fact.decision).length;
    const allDecided = decided === character.facts.length;
    const factCards = character.facts.map((fact, index) => {
        const decisionLabel = fact.decision === 'keep' ? '已保留' : fact.decision === 'delete' ? '已删除' : '待审查';
        const disabled = fact.decision ? 'disabled' : '';
        return `<article class="cwb-review-fact" data-decision="${fact.decision || 'pending'}">
            <div class="cwb-review-fact-head"><b>${escapeHtml(fact.category)} · 第 ${index + 1} 条</b><span>${decisionLabel}</span></div>
            <p>${escapeHtml(fact.value)}</p>
            ${fact.decision ? '' : `<div class="cwb-review-actions"><button class="menu_button" data-review-action="keep" data-fact-id="${escapeHtml(fact.id)}" ${disabled}>保留这条</button><button class="menu_button cwb-danger" data-review-action="delete" data-fact-id="${escapeHtml(fact.id)}" ${disabled}>删除这条</button></div>`}
        </article>`;
    }).join('');
    area.html(`<div class="cwb-review-head"><strong>角色 ${profileInfoReviewIndex + 1}/${characters.length}：${escapeHtml(character.name)}</strong><span>${decided}/${character.facts.length} 条已审查</span></div>
        ${factCards}
        <div class="cwb-review-nav"><button class="menu_button" data-review-nav="previous" ${profileInfoReviewIndex === 0 ? 'disabled' : ''}>上一位角色</button><button class="menu_button" data-review-nav="next" ${!allDecided ? 'disabled' : ''}>下一位角色</button></div>
        <small class="cwb-help">总进度 ${reviewed}/${profileInfoReview.totalFacts} 条；删除会立即写回并核验，只移除对应信息行。</small>`);
}

function assertActiveProfileReview() {
    refreshChatState();
    if (!profileInfoReview || state.chatId !== profileInfoReview.chatId) {
        profileInfoReview = null;
        renderProfileInfoReview();
        throw Error('当前聊天已变化，请重新开始审查，未删除任何信息。');
    }
}

async function runButton(button, label, action) {
    const original = button.html();
    button.prop('disabled', true).text(label);
    try { await action(); }
    catch (error) {
        console.error('[CWB]', error);
        notify('error', error.message);
        $('#cwb-status').text(`错误：${error.message}`);
        if (!error.cwbReportGenerated) {
            createErrorReport(error, error.cwbDiagnostics || { stage: `UI action: ${label}` });
            error.cwbReportGenerated = true;
        }
        if (button.attr('id') === 'cwb-generate-directories') $('#cwb-route-status').text(`目录生成失败：${error.message}`);
    } finally { button.prop('disabled', false).html(original); }
}

function bindUi() {
    $('#cwb-system-settings').on('input change', 'input, textarea, select', saveFromUi);
    $('#cwb-system-settings').on('click', '[data-cwb-progress]', function () {
        const module = $(this).attr('data-cwb-progress');
        const details = document.getElementById('cwb-progress-details');
        if (details) details.open = true;
        document.getElementById(`cwb-detail-${module}`)?.scrollIntoView({ block: 'start', behavior: 'auto' });
    });
    $('#cwb-update-relationships').on('click', function () {
        runButton($(this), '关系更新中…', () => updateRelationships(settings()));
    });
    $('#cwb-refresh-timeline').on('click', function () {
        runButton($(this), '时间线更新中…', async () => {
            saveFromUi();
            await refreshTimeline(settings());
        });
    });
    $('#cwb-check-progress').on('click', function () { runButton($(this), '读取中…', refreshModuleProgress); });
    $('#cwb-recover-progress').on('click', function () {
        runButton($(this), '读取候选…', async () => {
            refreshChatState();
            const candidates = await getProgressRecoveryCandidates();
            if (!candidates.length) throw Error('没有找到其他聊天的可恢复进度。');
            const details = candidates.map((item, index) => `${index + 1}. ${item.comment || item.chatId}\n   已完成至 ${item.through} 楼；记录总楼数 ${item.totalMessages || '未知'}`).join('\n');
            let choice;
            if (candidates.length === 1) {
                if (!window.confirm(`仅复制进度状态，不复制档案、时间线或关系条目；原进度保留。请确认来源是同一剧情的旧聊天记录：\n\n${details}\n\n继续复制？`)) return;
                choice = 0;
            } else {
                const answer = window.prompt(`仅复制进度状态，不复制档案、时间线或关系条目。请选择同一剧情的来源编号；原进度会保留：\n\n${details}\n\n输入编号：`);
                choice = Number(answer) - 1;
                if (!Number.isInteger(choice) || choice < 0 || choice >= candidates.length) return;
                if (!window.confirm(`确认从“${candidates[choice].comment || candidates[choice].chatId}”复制进度状态到当前聊天？来源记录保留，档案和时间线条目不会复制。`)) return;
            }
            const result = await copyProgressFromChat(candidates[choice].chatId);
            await refreshModuleProgress();
            notify('success', `已复制进度到当前聊天；来源《${result.bookName}》中的原存档已保留。`);
        });
    });
    for (const module of ['profiles', 'timeline', 'relationships']) {
        $(`#cwb-retry-${module}`).on('click', function () { runButton($(this), '补漏中…', () => retryMissingModule(settings(), module)); });
    }
    $('#cwb-start-info-review').on('click', function () {
        runButton($(this), '读取档案中…', async () => {
            const release = acquireOperationLock(state, '已知 / 未知信息审查');
            try {
                refreshChatState();
                profileInfoReview = await getProfileInfoReviewQueue();
                profileInfoReviewIndex = 0;
                profileInfoReviewDeleted = 0;
                renderProfileInfoReview();
                $('#cwb-status').text(`已读取 ${profileInfoReview.characters.length} 个角色、${profileInfoReview.totalFacts} 条已知 / 未知信息；请逐条审查。`);
            } finally { release(); }
        });
    });
    $('#cwb-info-review').on('click', '[data-review-action]', async function () {
        try {
            assertActiveProfileReview();
            const action = $(this).attr('data-review-action');
            const factId = $(this).attr('data-fact-id');
            const character = profileInfoReview.characters[profileInfoReviewIndex];
            const fact = character?.facts.find(item => item.id === factId);
            if (!fact || fact.decision) throw Error('这条信息已处理或已不存在，请重新扫描。');
            if (action === 'keep') {
                fact.decision = 'keep';
            } else if (action === 'delete') {
                const confirmed = window.confirm(`确认从世界书《${fact.bookName}》的角色档案中删除这一条${fact.category}？\n\n${fact.value}\n\n只删除这条信息，不会删除整个角色档案。`);
                if (!confirmed) return;
                const button = $(this);
                button.prop('disabled', true).text('正在删除并核验…');
                const release = acquireOperationLock(state, '删除单条角色信息');
                try {
                    await deleteReviewedProfileFact(profileInfoReview, fact);
                    fact.decision = 'delete';
                    profileInfoReviewDeleted++;
                } finally { release(); }
            } else {
                throw Error('未知的审查操作。');
            }
            renderProfileInfoReview();
        } catch (error) {
            notify('error', error.message);
            $('#cwb-status').text(`信息审查未完成：${error.message}`);
        }
    });
    $('#cwb-info-review').on('click', '[data-review-nav]', function () {
        try {
            assertActiveProfileReview();
            const action = $(this).attr('data-review-nav');
            if (action === 'previous') profileInfoReviewIndex = Math.max(0, profileInfoReviewIndex - 1);
            else if (action === 'next') {
                const character = profileInfoReview.characters[profileInfoReviewIndex];
                if (character.facts.some(fact => !fact.decision)) throw Error('请先决定当前角色的每一条信息，再进入下一位角色。');
                profileInfoReviewIndex++;
            } else if (action === 'close') {
                profileInfoReview = null;
            }
            renderProfileInfoReview();
        } catch (error) {
            notify('warning', error.message);
        }
    });
    $('#cwb-cleanup-profiles').on('click', function () {
        runButton($(this), '精简中…', async () => {
            const release = acquireOperationLock(state, '角色档案精简');
            try {
                refreshChatState();
                const result = await cleanupProfileFields(settings());
                $('#cwb-status').text(`已精简 ${result.changed} 条当前聊天档案；未识别格式跳过 ${result.skipped} 条。本操作不调用 AI。`);
            } finally { release(); }
        });
    });
    $('#cwb-delete-generated').on('click', async function () {
        const button = $(this);
        const original = button.html();
        const showDeleteProgress = ({ phase, current, total }) => {
            const labels = { scan: '扫描世界书', verify: '复核条目', delete: '删除条目', readback: '核验保存' };
            button.text(`${labels[phase] ?? '处理中'} ${current}/${total}…`);
        };
        button.prop('disabled', true).text('正在核对当前聊天条目…');
        let release;
        try {
            release = acquireOperationLock(state, '删除当前聊天生成条目');
            refreshChatState();
            const preview = await getGeneratedContentPreview(showDeleteProgress);
            if (!preview.entries.length) {
                $('#cwb-status').text('当前聊天没有可清理的插件生成条目。');
                notify('info', '当前聊天没有可清理的插件生成条目。');
                return;
            }
            const details = preview.entries.map(entry => {
                const name = entry.comment || `${entry.label}（UID ${entry.uid}）`;
                return `《${entry.bookName}》｜${name}｜${entry.label}｜UID ${entry.uid}`;
            }).join('\n');
            const message = `即将删除当前聊天的 ${preview.entries.length} 条插件生成内容：\n\n${details}\n\n仅删除条目键中明确标记为当前聊天的数据。原始/手工条目、全局目录、其他聊天数据和插件设置不会删除。此操作不可撤销。\n\n确认删除？`;
            if (!window.confirm(message)) return;
            button.text('正在删除并核验…');
            const result = await deleteGeneratedContent(preview, showDeleteProgress);
            const summary = Object.entries(result.byType).map(([type, count]) => `${type} ${count} 条`).join('、') || '无';
            $('#cwb-status').text(`已删除当前聊天的 ${result.deleted} 条生成内容：${summary}。`);
            button.text('删除完成，刷新进度…');
            await refreshModuleProgress().catch(error => $('#cwb-progress-error').text(`进度读取失败：${error.message}`));
            notify('success', `已安全清理 ${result.deleted} 条当前聊天生成内容。`);
        } catch (error) {
            console.error('[CWB] 清理生成条目失败', error);
            $('#cwb-status').text(`删除未完成：${error.message}`);
            notify('error', `删除未完成：${error.message}`);
        } finally {
            release?.();
            button.prop('disabled', false).html(original);
        }
    });
    $('#cwb-test-api').on('click', function () {
        runButton($(this), '测试中…', async () => notify('success', await testSystemApi()));
    });
    $('#cwb-download-error-report').on('click', function () {
        if (!downloadLatestErrorReport()) notify('warning', '当前没有可下载的错误报告。');
    });
    $('#cwb-manual-update').on('click', function () {
        runButton($(this), '更新中…', () => updateRecent(settings()));
    });
    $('#cwb-range-update').on('click', function () {
        runButton($(this), '更新中…', () => {
            const start = Number($('#cwb-start-floor').val());
            const end = Number($('#cwb-end-floor').val());
            if (!start || !end || start > end) throw new Error('请输入有效的起止楼层。');
            const module = $('#cwb-range-module').val() || 'all';
            return updateRange(settings(), start - 1, end - 1, module === 'all' ? {} : { modules: [module] });
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
                button.text(current ? `点击停止（${current}/${total}）` : '批量补齐未完成内容');
            });
        } catch (error) {
            notify('error', `批量更新失败：${error.message}`);
            if (!error.cwbReportGenerated) {
                createErrorReport(error, error.cwbDiagnostics || { stage: 'Batch update' });
                error.cwbReportGenerated = true;
            }
            $('#cwb-status').text(`批量更新失败：${error.message}。诊断报告已生成，可点击下载。`);
        }
        finally { button.html(original); }
    });
    $('#cwb-open-viewer').on('click', () => openViewer(settings()));
    $('#cwb-convert-format').on('click', function () {
        runButton($(this), '转换中…', async () => {
            const release = acquireOperationLock(state, '旧格式转换');
            try { return await convertLegacyEntries(settings()); }
            finally { release(); }
        });
    });
    $('#cwb-reset-prompts').on('click', () => {
        const value = settings();
        value.breakPrompt = defaults.breakPrompt;
        value.fullPrompt = defaults.fullPrompt;
        value.incrementalPrompt = defaults.incrementalPrompt;
        value.timelineIncrementalPrompt = defaults.timelineIncrementalPrompt;
        saveSettingsDebounced();
        loadUi();
        notify('success', '已恢复角色与时间线默认提示词。');
    });
    $('#cwb-scan-routes').on('click', async function () {
        try {
            $('#cwb-route-status').text('正在读取已生成目录…');
            const summary = await routeSummary(settings());
            $('#cwb-route-status').text(summary);
            notify('success', '已生成目录查看完成。');
        } catch (error) {
            $('#cwb-route-status').text(`读取目录失败：${error.message}`);
            notify('error', `扫描失败：${error.message}`);
        }
    });
    $('#cwb-generate-directories').on('click', function () {
        runButton($(this), '生成中…', async () => {
            const release = acquireOperationLock(state, '世界书目录生成');
            try {
                saveFromUi();
                $('#cwb-route-status').text('正在读取当前激活的世界书…');
                const result = await generateWorldbookDirectories(message => $('#cwb-route-status').text(message));
                const lines = [`已扫描激活世界书：${result.activeBooks.join('、')}`];
                if (result.generated.length) lines.push(`已生成目录：${result.generated.map(item => `${item.bookName}（${item.count}名）`).join('；')}`);
                if (result.skippedBooks.length) lines.push(`没有识别到角色条目，未生成目录：${result.skippedBooks.join('、')}`);
                if (result.duplicates.length) lines.push('重复角色（未写入目录，请手动处理）：', ...result.duplicates);
                $('#cwb-route-status').text(lines.join('\n'));
                if (result.duplicates.length) notify('warning', `目录已扫描，发现 ${result.duplicates.length} 个重复角色，请查看详情。`);
                else if (!result.generated.length) notify('warning', '激活的世界书中没有识别到角色条目。');
                else notify('success', `已在 ${result.generated.length} 本激活世界书中生成目录。`);
            } finally { release(); }
        });
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
