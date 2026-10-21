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
import { batchUpdate, compactRoleProfiles, maybeAutoUpdate, onChatChanged, refreshChatState, updateRange, updateRecent, refreshTimeline, updateRelationships, refreshModuleProgress, retryMissingModule } from './core.js';
import { convertLegacyEntries, copyProgressFromChat, deleteGeneratedContent, deleteUnretainedProfileFacts, generateWorldbookDirectories, getGeneratedContentPreview, getProfileCountAuditQueue, getProfileInfoReviewQueue, getProgressRecoveryCandidates, listWorldbooks, migrateChatBoundProfilesToCard, previewChatBoundProfilesForCardMigration, routeSummary, saveReviewedProfileCount } from './lorebook.js';
import { MODULE_NAME, state, acquireOperationLock } from './state.js';
import { escapeHtml, notify } from './utils.js';
import { openViewer, updatePluginButton } from './viewer.js';
import { getProfileCompactionCandidates } from './lorebook.js';
import { openProfileCompactionDialog } from './profile-compaction-dialog.js';
import { previewArchiveFormatUpgrade, applyArchiveFormatUpgrade } from './lorebook.js';
import { openArchiveUpgradeDialog } from './archive-upgrade-ui.js';

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
let profileCountAudit = null;
let profileCountAuditSelected = new Set();
let cardProfileMigrationPreview = null;

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
    const factCards = character.facts.map((fact, index) => {
        const decisionLabel = fact.decision === 'keep' ? '已选择保留' : fact.decision === 'delete' ? '已删除' : '未选择保留';
        return `<article class="cwb-review-fact" data-decision="${fact.decision || 'pending'}">
            <div class="cwb-review-fact-head"><b>${escapeHtml(fact.category)} · 第 ${index + 1} 条</b><span>${decisionLabel}</span></div>
            <p>${escapeHtml(fact.value)}</p>
            ${fact.decision === 'delete' ? '' : `<div class="cwb-review-actions"><button class="menu_button" data-review-action="keep" data-fact-id="${escapeHtml(fact.id)}">${fact.decision === 'keep' ? '取消保留' : '选择保留'}</button></div>`}
        </article>`;
    }).join('');
    area.html(`<div class="cwb-review-head"><strong>角色 ${profileInfoReviewIndex + 1}/${characters.length}：${escapeHtml(character.name)}</strong><span>${decided}/${character.facts.length} 条已审查</span></div>
        ${factCards}
        <button class="menu_button cwb-full-width cwb-danger" data-review-delete-unkept ${character.facts.some(fact => !fact.decision) ? '' : 'disabled'}>删除本角色未保留信息（${character.facts.filter(fact => !fact.decision).length} 条）</button>
        <div class="cwb-review-nav"><button class="menu_button" data-review-nav="previous" ${profileInfoReviewIndex === 0 ? 'disabled' : ''}>上一位角色</button><button class="menu_button" data-review-nav="next">下一位角色</button></div>
        <small class="cwb-help">总进度 ${reviewed}/${profileInfoReview.totalFacts} 条；下一位角色仅跳过，不修改档案。点击删除按钮才移除当前角色未保留信息，核验成功后自动进入下一位。</small>`);
}

function assertActiveProfileReview() {
    if (state.operationOwner === '批量删除未保留的角色信息') throw Error('正在删除并核验，请稍候。');
    refreshChatState();
    if (!profileInfoReview || state.chatId !== profileInfoReview.chatId) {
        profileInfoReview = null;
        renderProfileInfoReview();
        throw Error('当前聊天已变化，请重新开始审查，未删除任何信息。');
    }
}

function renderProfileCountAudit() {
    const area = $('#cwb-profile-audit');
    if (!profileCountAudit) { area.prop('hidden', true).empty(); return; }
    area.prop('hidden', false);
    if (profileCountAudit.stage === 'select') {
        const profiles = profileCountAudit.queue.profiles;
        if (!profiles.length) {
            area.html('<div class="cwb-review-summary">当前聊天没有可核对的插件生成角色档案。</div>');
            return;
        }
        const items = profiles.map(profile => `<label class="cwb-audit-select-item">
            <input type="checkbox" data-audit-select="${escapeHtml(profile.id)}" ${profileCountAuditSelected.has(profile.id) ? 'checked' : ''}>
            <span><b>${escapeHtml(profile.name)}</b><small>世界书：${escapeHtml(profile.bookName)} · 当前人数：${profile.currentCount === null ? '未记录' : profile.currentCount} · 名单：${profile.partners.length} 人${profile.needsAttention ? ' · 建议核对' : ''}</small></span>
        </label>`).join('');
        area.html(`<div class="cwb-review-head"><strong>选择要核对的角色档案</strong><span>${profileCountAuditSelected.size}/${profiles.length} 已选</span></div>
            <div class="cwb-audit-select-list">${items}</div>
            <button class="menu_button cwb-full-width" data-audit-action="begin" ${profileCountAuditSelected.size ? '' : 'disabled'}>核对所选档案</button>
            <small class="cwb-help">只列出当前聊天中插件生成的角色档案和主角档案；手工条目及其他聊天不会修改。</small>`);
        return;
    }
    const profiles = profileCountAudit.profiles;
    if (profileCountAudit.index >= profiles.length) {
        area.html(`<div class="cwb-review-summary">核对完成：已检查 ${profileCountAudit.reviewed}/${profiles.length} 条，修改 ${profileCountAudit.corrected} 条。<button class="menu_button cwb-full-width" data-audit-action="close">结束核对</button></div>`);
        return;
    }
    const profile = profiles[profileCountAudit.index];
    const suggested = profile.referenceCount ?? profile.currentCount ?? profile.partners.length;
    const partnerText = profile.partners.length ? profile.partners.join('、') : '档案未列出对象姓名';
    const plotText = profile.plot.length ? profile.plot.join('\n') : '档案未记录个人关键剧情';
    const comparison = profile.referenceCount === undefined ? '' : `<div class="cwb-audit-warning" data-audit-diff="${profile.referenceCount === profile.currentCount ? 'same' : 'different'}">动态信息：${profile.referenceCount} 人；角色档案：${profile.currentCount === null ? '未记录' : `${profile.currentCount} 人`}；${profile.referenceCount === profile.currentCount ? '两者一致' : '存在出入，请核对后修改。'}</div>`;
    const warning = profile.needsAttention
        ? `名单中有 ${profile.partners.length} 个不同对象，高于当前记录的 ${profile.currentCount ?? 0} 人，请检查是否漏计。`
        : profile.currentCount === null
            ? '档案没有有效人数，请结合既往人数与剧情新增对象填写最终人数。'
            : '请按“旧档案人数 + 本轮剧情中新确认的不同对象”核对。人员名单可能只列出部分历史对象，不要直接把名单长度当作总人数。';
    area.html(`<div class="cwb-review-head"><strong>核对 ${profileCountAudit.index + 1}/${profiles.length}：${escapeHtml(profile.name)}</strong><span>${profileCountAudit.reviewed} 条已完成</span></div>
        ${comparison}<div class="cwb-audit-warning">${escapeHtml(warning)}</div>
        <div class="cwb-audit-evidence"><h4>当前档案人数</h4><p>${profile.currentCount === null ? '未记录' : `${profile.currentCount} 人`}</p></div>
        <div class="cwb-audit-evidence"><h4>性经历人员名单（${profile.partners.length} 个不同姓名）</h4><p>${escapeHtml(partnerText)}</p></div>
        <div class="cwb-audit-evidence"><h4>用于对照的个人关键剧情</h4><p>${escapeHtml(plotText)}</p></div>
        <label class="cwb-audit-count-row">动态信息人数<input id="cwb-audit-dynamic-count" class="text_pole" type="number" min="0" max="999999" step="1" inputmode="numeric" placeholder="手动填入动态信息中的人数" value="${profile.referenceCount === undefined ? '' : escapeHtml(profile.referenceCount)}"></label>
        <button class="menu_button cwb-full-width" data-audit-action="compare">对比动态信息与档案人数</button>
        <label class="cwb-audit-count-row">核对后的最终人数<input id="cwb-audit-count" class="text_pole" type="number" min="0" max="999999" step="1" inputmode="numeric" value="${escapeHtml(suggested)}"></label>
        <div class="cwb-audit-actions"><button class="menu_button" data-audit-action="confirm">确认当前档案无误</button><button class="menu_button cwb-primary" data-audit-action="save">保存修改并继续</button></div>
        <button class="menu_button cwb-full-width" data-audit-action="close">结束核对</button>
        <small class="cwb-help">保存只修改《${escapeHtml(profile.bookName)}》中该角色档案的“性经历人数”字段，并核验写回结果。</small>`);
}

function assertActiveProfileAudit() {
    refreshChatState();
    if (!profileCountAudit || state.chatId !== profileCountAudit.chatId) {
        profileCountAudit = null;
        profileCountAuditSelected = new Set();
        renderProfileCountAudit();
        throw Error('当前聊天已变化，请重新扫描档案；未修改任何信息。');
    }
}

function advanceProfileCountAudit(corrected = false) {
    profileCountAudit.reviewed++;
    if (corrected) profileCountAudit.corrected++;
    profileCountAudit.index++;
    renderProfileCountAudit();
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
            if (!fact || fact.decision === 'delete') throw Error('这条信息已处理或已不存在，请重新扫描。');
            if (action === 'keep') {
                fact.decision = fact.decision === 'keep' ? null : 'keep';
            } else {
                throw Error('未知的审查操作。');
            }
            renderProfileInfoReview();
        } catch (error) {
            notify('error', error.message);
            $('#cwb-status').text(`信息审查未完成：${error.message}`);
        }
    });
    $('#cwb-info-review').on('click', '[data-review-delete-unkept]', async function () {
        try {
            assertActiveProfileReview();
            const character = profileInfoReview.characters[profileInfoReviewIndex];
            const unkept = character.facts.filter(fact => !fact.decision);
            if (!unkept.length) return;
            const details = unkept.map((fact, index) => `${index + 1}. [${fact.category}] ${fact.value}`).join('\n');
            if (!window.confirm(`确认删除角色“${character.name}”未选择保留的 ${unkept.length} 条信息？\n\n${details}\n\n已选择保留的内容不会删除；只删除以上列出的档案信息。`)) return;
            const button = $(this);
            button.prop('disabled', true).text('正在批量删除并核验…');
            const release = acquireOperationLock(state, '批量删除未保留的角色信息');
            try {
                const result = await deleteUnretainedProfileFacts(profileInfoReview, unkept, update => {
                    const deletedIds = new Set(update.deletedFacts);
                    const updatedEntries = new Map(update.entries.map(entry => [entry.uid, entry.content]));
                    for (const item of profileInfoReview.characters.flatMap(entry => entry.facts)) {
                        if (item.bookName !== update.bookName) continue;
                        if (updatedEntries.has(item.uid)) item.content = updatedEntries.get(item.uid);
                        if (deletedIds.has(item.id)) item.decision = 'delete';
                    }
                    profileInfoReviewDeleted += update.deletedFacts.length;
                    $('#cwb-status').text(`已核验删除 ${profileInfoReviewDeleted} 条未保留信息…`);
                });
                $('#cwb-status').text(`已删除并核验 ${result.deleted} 条未保留信息。`);
            } finally { release(); }
            assertActiveProfileReview();
            profileInfoReviewIndex++;
            renderProfileInfoReview();
        } catch (error) {
            renderProfileInfoReview();
            notify('error', error.message);
            $('#cwb-status').text(`批量删除未完成：${error.message}`);
        }
    });
    $('#cwb-info-review').on('click', '[data-review-nav]', function () {
        try {
            assertActiveProfileReview();
            const action = $(this).attr('data-review-nav');
            if (action === 'previous') profileInfoReviewIndex = Math.max(0, profileInfoReviewIndex - 1);
            else if (action === 'next') {
                profileInfoReviewIndex++;
            } else if (action === 'close') {
                profileInfoReview = null;
            }
            renderProfileInfoReview();
        } catch (error) {
            notify('warning', error.message);
        }
    });
    $('#cwb-start-profile-audit').on('click', function () {
        runButton($(this), '读取档案中…', async () => {
            const release = acquireOperationLock(state, '性经历人数核对');
            try {
                refreshChatState();
                const queue = await getProfileCountAuditQueue();
                profileCountAudit = { stage: 'select', chatId: queue.chatId, queue };
                profileCountAuditSelected = new Set();
                renderProfileCountAudit();
                $('#cwb-status').text(`已读取 ${queue.total} 条当前角色卡插件档案；请勾选要核对的条目。`);
            } finally { release(); }
        });
    });
    $('#cwb-profile-audit').on('change', '[data-audit-select]', function () {
        const id = $(this).attr('data-audit-select');
        if ($(this).prop('checked')) profileCountAuditSelected.add(id);
        else profileCountAuditSelected.delete(id);
        renderProfileCountAudit();
    });
    $('#cwb-profile-audit').on('click', '[data-audit-action]', async function () {
        try {
            assertActiveProfileAudit();
            const action = $(this).attr('data-audit-action');
            if (action === 'close') {
                profileCountAudit = null;
                profileCountAuditSelected = new Set();
                renderProfileCountAudit();
                return;
            }
            if (action === 'begin') {
                const selected = profileCountAudit.queue.profiles.filter(profile => profileCountAuditSelected.has(profile.id));
                if (!selected.length) throw Error('请先至少勾选一条档案。');
                profileCountAudit = { stage: 'review', chatId: profileCountAudit.chatId, profiles: selected, index: 0, reviewed: 0, corrected: 0 };
                renderProfileCountAudit();
                return;
            }
            const profile = profileCountAudit.profiles[profileCountAudit.index];
            if (action === 'compare') {
                const referenceValue = String($('#cwb-audit-dynamic-count').val() ?? '').trim();
                const referenceCount = Number(referenceValue);
                if (!/^\d+$/.test(referenceValue) || !Number.isSafeInteger(referenceCount) || referenceCount < 0 || referenceCount > 999999) {
                    throw Error('请输入动态信息中 0 到 999999 之间的整数人数，再进行对比。');
                }
                profile.referenceCount = referenceCount;
                renderProfileCountAudit();
                $('#cwb-status').text(`已对比 ${profile.name}：动态信息 ${referenceCount} 人，档案 ${profile.currentCount === null ? '未记录' : `${profile.currentCount} 人`}。`);
                return;
            }
            const rawCount = String($('#cwb-audit-count').val() ?? '').trim();
            const count = Number(rawCount);
            if (!/^\d+$/.test(rawCount) || !Number.isSafeInteger(count) || count < 0 || count > 999999) {
                throw Error('请输入 0 到 999999 之间的整数人数。');
            }
            if (action === 'confirm') {
                if (profile.referenceCount !== undefined && profile.referenceCount !== profile.currentCount) throw Error('动态信息与档案人数不一致，请按既往人数和新增剧情核对后点击“保存修改并继续”。');
                if (profile.currentCount !== count) throw Error('输入值与当前档案人数不同；如需修正，请点击“保存修改并继续”。');
                advanceProfileCountAudit(false);
                return;
            }
            if (action === 'save') {
                if (profile.currentCount === count) {
                    advanceProfileCountAudit(false);
                    return;
                }
                const release = acquireOperationLock(state, '保存性经历人数核对结果');
                try {
                    const result = await saveReviewedProfileCount(profileCountAudit, profile, count);
                    profile.currentCount = count;
                    profile.rawCount = String(count);
                    profile.content = result.content;
                    profile.needsAttention = profile.partners.length > count;
                    advanceProfileCountAudit(true);
                    $('#cwb-status').text(`已核对 ${result.name}：性经历人数已更新为 ${count}，并完成服务端回读核验。`);
                } finally { release(); }
                return;
            }
            throw Error('未知的档案核对操作。');
        } catch (error) {
            notify('error', error.message);
            $('#cwb-status').text(`档案核对未完成：${error.message}`);
            renderProfileCountAudit();
        }
    });
    $('#cwb-scan-card-profile-migration').on('click', function () {
        runButton($(this), '扫描世界书…', async () => {
            const release = acquireOperationLock(state, '扫描旧聊天绑定角色档案');
            const preview = $('#cwb-card-profile-migration-preview');
            const convert = $('#cwb-convert-card-profile-migration');
            try {
                saveFromUi();
                preview.prop('hidden', false).text('正在扫描当前角色卡关联的世界书…');
                convert.prop('hidden', true);
                cardProfileMigrationPreview = await previewChatBoundProfilesForCardMigration(settings(), ({ current, total, bookName }) => {
                    preview.text(`正在扫描 ${current}/${total}：《${bookName}》…`);
                });
                const candidates = cardProfileMigrationPreview.candidates;
                if (!candidates.length) {
                    preview.text(`扫描完成：检查 ${cardProfileMigrationPreview.books.length} 本世界书，没有找到需要迁移的插件资料。`);
                    $('#cwb-status').text('旧档案扫描完成：没有需要转换的条目。');
                    return;
                }
                const lines = candidates.map((item, index) => `${index + 1}. ${item.name}｜${item.label}｜《${item.bookName}》｜${item.comment || '（无标题）'}｜UID ${item.uid}`).join('\n');
                preview.text(`扫描完成：检查 ${cardProfileMigrationPreview.books.length} 本世界书，找到 ${candidates.length} 条待迁移插件资料。\n\n将转换为当前角色卡：${decodeURIComponent(cardProfileMigrationPreview.cardKey.replace('CWB:角色卡:', ''))}\n\n${lines}\n\n请核对所列资料属于这张角色卡。所有条目 UID 和正文保留；已绑定其他角色卡的资料不在列表中。`);
                convert.text(`确认迁移全部 ${candidates.length} 条资料到当前角色卡`).prop('hidden', false);
                $('#cwb-status').text(`旧档案扫描完成：发现 ${candidates.length} 条，已列出完整世界书与 UID。`);
            } finally { release(); }
        });
    });
    $('#cwb-convert-card-profile-migration').on('click', async function () {
        const button = $(this);
        const preview = cardProfileMigrationPreview;
        if (!preview?.candidates?.length) return;
        const details = preview.candidates.map((item, index) => `${index + 1}. ${item.name}｜《${item.bookName}》｜UID ${item.uid}`).join('\n');
        if (!window.confirm(`即将把以下 ${preview.candidates.length} 条档案、时间线、关系或进度资料改为当前角色卡绑定：\n\n${details}\n\n确认它们属于当前角色卡后再迁移。只改归属键；原条目、UID 和内容均保留，不合并、不删除。确认转换？`)) return;
        const original = button.text();
        button.prop('disabled', true).text('正在逐条转换并核验…');
        let release;
        try {
            release = acquireOperationLock(state, '转换旧聊天绑定角色档案');
            const result = await migrateChatBoundProfilesToCard(settings(), preview, ({ phase, current, total, bookName }) => {
                button.text(phase === 'write' ? `转换并核验 ${current}/${total}：《${bookName}》…` : `复核扫描 ${current}/${total}…`);
            });
            cardProfileMigrationPreview = null;
            $('#cwb-card-profile-migration-preview').text(`转换完成并回读核验：${result.migrated} 条档案，扫描 ${result.booksScanned} 本关联世界书，修改 ${result.booksChanged} 本。所有内容和 UID 均保留；没有合并或删除条目。`);
            button.prop('hidden', true);
            $('#cwb-status').text(`已将 ${result.migrated} 条档案转换为当前角色卡绑定，并逐条核验成功。`);
            notify('success', `已转换并核验 ${result.migrated} 条旧档案。`);
        } catch (error) {
            $('#cwb-status').text(`旧档案转换未完成：${error.message}`);
            notify('error', `旧档案转换未完成：${error.message}`);
        } finally {
            release?.();
            button.prop('disabled', false);
            if (!button.prop('hidden')) button.text(original);
        }
    });
    $('#cwb-cleanup-profiles').on('click', function () {
        runButton($(this), '读取档案中…', async () => {
            refreshChatState();
            await openProfileCompactionDialog({
                load: () => getProfileCompactionCandidates(settings()),
                compact: (selection, onProgress) => compactRoleProfiles(settings(), onProgress, selection),
                escapeHtml,
            });
        });
    });
    $('#cwb-delete-generated').on('click', async function () {
        const button = $(this);
        const original = button.html();
        const showDeleteProgress = ({ phase, current, total }) => {
            const labels = { scan: '扫描世界书', verify: '复核条目', delete: '删除条目', readback: '核验保存' };
            button.text(`${labels[phase] ?? '处理中'} ${current}/${total}…`);
        };
        button.prop('disabled', true).text('正在核对当前角色卡条目…');
        let release;
        try {
            release = acquireOperationLock(state, '删除当前角色卡生成条目');
            refreshChatState();
            const preview = await getGeneratedContentPreview(showDeleteProgress);
            if (!preview.entries.length) {
                $('#cwb-status').text('当前角色卡没有可清理的插件生成条目。');
                notify('info', '当前角色卡没有可清理的插件生成条目。');
                return;
            }
            const details = preview.entries.map(entry => {
                const name = entry.comment || `${entry.label}（UID ${entry.uid}）`;
                return `《${entry.bookName}》｜${name}｜${entry.label}｜UID ${entry.uid}`;
            }).join('\n');
            const message = `即将删除当前角色卡的 ${preview.entries.length} 条插件生成内容：\n\n${details}\n\n仅删除条目键中明确标记为当前角色卡的数据。原始/手工条目、全局目录、其他角色卡数据和插件设置不会删除。此操作不可撤销。\n\n确认删除？`;
            if (!window.confirm(message)) return;
            button.text('正在删除并核验…');
            const result = await deleteGeneratedContent(preview, showDeleteProgress);
            const summary = Object.entries(result.byType).map(([type, count]) => `${type} ${count} 条`).join('、') || '无';
            $('#cwb-status').text(`已删除当前角色卡的 ${result.deleted} 条生成内容：${summary}。`);
            button.text('删除完成，刷新进度…');
            await refreshModuleProgress().catch(error => $('#cwb-progress-error').text(`进度读取失败：${error.message}`));
            notify('success', `已安全清理 ${result.deleted} 条当前角色卡生成内容。`);
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
        runButton($(this), '扫描资料格式…', async () => {
            const release = acquireOperationLock(state, '全部资料格式扫描');
            try {
                const preview = await previewArchiveFormatUpgrade(settings(), update => {
                    $('#cwb-status').text(`扫描资料格式 ${update.current}/${update.total}：《${update.bookName}》`);
                });
                openArchiveUpgradeDialog(preview, async (ids, options) => {
                    const unlock = acquireOperationLock(state, '全部资料格式升级');
                    try { return await applyArchiveFormatUpgrade(preview, ids, options); }
                    finally { unlock(); }
                });
            }
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
