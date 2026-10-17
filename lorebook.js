import { parseTimelineRecords, formatTimelineRecords } from './timeline-utils.mjs';
import { sanitizeProfileContent } from './profile-utils.mjs';
import { applyModuleResult, intersectRanges, mergeModuleProgress, MODULE_LABELS } from './module-progress.mjs';
import { getRequestHeaders } from '/script.js';
import { extension_settings, getContext } from '/scripts/extensions.js';
import {
    createWorldInfoEntry,
    loadWorldInfo,
    saveWorldInfo,
    selected_world_info,
    world_info,
    world_names,
} from '/scripts/world-info.js';
import { state } from './state.js';
import { notify, parseCustomFormat, sanitizeName } from './utils.js';
import { directoryContent, duplicateLines, findRoutedBook, namesFromDirectory, namesFromRoleEntries } from './directory-utils.mjs';
import { mergeRanges, missingRanges, overlappingRanges, parseTaggedRanges } from './update-tracker.mjs';

const getKeys = entry => Array.isArray(entry?.key) ? entry.key : (Array.isArray(entry?.keys) ? entry.keys : []);
const isEnabled = entry => entry?.enabled !== false && entry?.disable !== true;
const PLUGIN_REFERENCE_KEYS = ['CWB:世界书目录', 'CWB:角色档案目录', 'CWB:故事时间线', 'CWB:角色关系汇总', 'CWB:更新状态', 'CWB:更新记录', 'CWB:模块进度'];
const isPluginReferenceEntry = entry => getKeys(entry).some(key => PLUGIN_REFERENCE_KEYS.includes(key));
const ALWAYS_ON_REFERENCE_KEYS = ['CWB:故事时间线', 'CWB:角色关系汇总'];
const isAlwaysOnReferenceEntry = entry => getKeys(entry).some(key => ALWAYS_ON_REFERENCE_KEYS.includes(key));
const GENERATED_ENTRY_TYPES = [
    ['CWB:自动档案', '角色档案'], ['CWB:主角档案', '主角档案'],
    ['CWB:故事时间线', '时间线'], ['CWB:角色关系汇总', '角色关系'],
    ['CWB:角色档案目录', '档案目录'], ['CWB:更新状态', '更新进度'],
    ['CWB:更新记录', '旧版更新记录'], ['CWB:模块进度', '旧版模块进度'],
    ['Amily2角色总集', '角色总览'],
];

export function getPrimaryWorldbook() {
    const context = getContext();
    const character = context?.characters?.[context.characterId];
    return character?.data?.extensions?.world || character?.extensions?.world || null;
}

export function listWorldbooks() {
    return [...world_names].sort((a, b) => String(a).localeCompare(String(b)));
}

export function getTargetWorldbook(settings) {
    if (settings.worldbookTarget === 'custom' && settings.customWorldbook) return settings.customWorldbook;
    return getPrimaryWorldbook();
}

function routeNames(entries) {
    const directories = entries.filter(entry => getKeys(entry).includes('CWB:世界书目录'));
    const names = new Set();
    for (const entry of directories) namesFromDirectory(entry.content).forEach(name => names.add(name));
    return [...names];
}

function getActiveWorldbookNames() {
    const context = getContext();
    const active = new Set();
    const add = value => {
        const name = String(value ?? '').trim();
        if (name && world_names.includes(name)) active.add(name);
    };
    (Array.isArray(selected_world_info) ? selected_world_info : []).forEach(add);
    add(context?.chatMetadata?.world_info);

    const character = context?.characters?.[context.characterId];
    add(character?.data?.extensions?.world || character?.extensions?.world);
    const avatarKey = String(character?.avatar ?? '').replace(/\.[^/.]+$/, '');
    const extraBooks = world_info?.charLore?.find(item => item.name === avatarKey)?.extraBooks;
    if (Array.isArray(extraBooks)) extraBooks.forEach(add);

    add(context?.powerUserSettings?.persona_description_lorebook);
    return [...active].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

export async function generateWorldbookDirectories(onProgress = () => {}) {
    const targetBooks = getActiveWorldbookNames();
    if (!targetBooks.length) throw new Error('当前没有已激活的世界书。请检查全局选择、当前角色、当前聊天或当前 Persona 的世界书绑定。');
    const plans = [];
    const occurrences = new Map();
    for (const bookName of targetBooks) {
        onProgress(`正在读取已激活世界书《${bookName}》中的角色条目…`);
        const entries = await getEntries(bookName);
        const names = namesFromRoleEntries(entries);
        if (!names.size) continue;
        plans.push({ bookName, entries, names: [...names.keys()] });
        for (const [name, sourceEntries] of names) {
            if (!occurrences.has(name)) occurrences.set(name, []);
            occurrences.get(name).push(...sourceEntries.map(entry => ({ bookName, ...entry })));
        }
    }
    const duplicates = new Map([...occurrences].filter(([, entries]) => entries.length > 1));
    const generated = [];
    for (const plan of plans) {
        const names = plan.names.filter(name => !duplicates.has(name));
        const data = {
            comment: `CWB目录｜${plan.bookName}`,
            content: directoryContent(names),
            keys: ['CWB:世界书目录'],
            enabled: false,
            type: 'selective',
            preventRecursion: true,
        };
        const directories = plan.entries.filter(entry => getKeys(entry).includes('CWB:世界书目录'));
        if (directories.length) await patchEntries(plan.bookName, directories.map(entry => ({ uid: entry.uid, ...data })));
        else await createEntries(plan.bookName, [data]);
        generated.push({ bookName: plan.bookName, count: names.length });
    }
    state.routeCache = null;
    return {
        activeBooks: targetBooks,
        generated,
        skippedBooks: targetBooks.filter(bookName => !generated.some(item => item.bookName === bookName)),
        duplicates: duplicateLines(duplicates),
    };
}

export async function discoverWorldbookRoutes(settings = {}) {
    const primary = getPrimaryWorldbook();
    const result = {};
    for (const bookName of listWorldbooks()) {
        const entries = await getEntries(bookName);
        if (!entries.some(entry => getKeys(entry).includes('CWB:世界书目录'))) continue;
        result[bookName] = { names: routeNames(entries), primary: bookName === primary };
    }
    state.routeCache = result;
    return result;
}

async function routeWorldbook(settings, characterName) {
    if (!settings.multiWorldbookRouting) return getTargetWorldbook(settings);
    const routes = state.routeCache || await discoverWorldbookRoutes(settings);
    return findRoutedBook(routes, characterName);
}

export async function routeSummary(settings = {}) {
    const routes = await discoverWorldbookRoutes(settings);
    return Object.entries(routes).map(([book, route]) => `${book}: ${route.names.slice(0, 30).join('、') || '目录已生成，暂无角色'}`).join('\n') || '当前没有已生成的目录。';
}

export async function getEntries(bookName) {
    if (!bookName) return [];
    const data = await loadWorldInfo(bookName);
    if (!data?.entries) return [];
    return Object.values(data.entries).map(entry => ({
        ...entry,
        keys: getKeys(entry),
        enabled: isEnabled(entry),
    }));
}

function applyEntryPatch(target, patch) {
    if ('keys' in patch) target.key = [...patch.keys];
    if ('enabled' in patch) target.disable = !patch.enabled;
    if ('type' in patch) {
        target.constant = patch.type === 'constant';
        target.selective = patch.type !== 'constant';
    }
    if ('preventRecursion' in patch) target.preventRecursion = Boolean(patch.preventRecursion);
    if ('prevent_recursion' in patch) target.preventRecursion = Boolean(patch.prevent_recursion);
    Object.entries(patch).forEach(([key, value]) => {
        if (['keys', 'enabled', 'type', 'preventRecursion', 'prevent_recursion', 'uid'].includes(key)) return;
        target[key] = value;
    });
}

export async function patchEntries(bookName, patches) {
    const data = await loadWorldInfo(bookName);
    if (!data?.entries) throw new Error(`无法读取世界书《${bookName}》。`);
    for (const patch of patches) {
        const target = data.entries[patch.uid] ?? Object.values(data.entries).find(entry => Number(entry.uid) === Number(patch.uid));
        if (target) applyEntryPatch(target, patch);
    }
    await saveWorldInfo(bookName, data, true);
}

export async function createEntries(bookName, entries) {
    const data = await loadWorldInfo(bookName);
    if (!data?.entries) throw new Error(`无法读取世界书《${bookName}》。`);
    for (const entry of entries) {
        const target = createWorldInfoEntry(bookName, data);
        if (!target) throw new Error('创建世界书条目 UID 失败。');
        applyEntryPatch(target, entry);
    }
    await saveWorldInfo(bookName, data, true);
}

export async function deleteEntries(bookName, uids) {
    const data = await loadWorldInfo(bookName);
    if (!data?.entries) throw new Error(`无法读取世界书《${bookName}》。`);
    for (const uid of uids) {
        delete data.entries[uid];
        const matchingKey = Object.keys(data.entries).find(key => Number(data.entries[key]?.uid) === Number(uid));
        if (matchingKey) delete data.entries[matchingKey];
    }
    await saveWorldInfo(bookName, data, true);
}

async function mapWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
            const index = next++;
            if (index >= items.length) return;
            results[index] = await worker(items[index], index);
        }
    }));
    return results;
}

function referencedProfileBooks(primaryData, chatId) {
    const books = new Set();
    for (const entry of Object.values(primaryData?.entries ?? {})) {
        const keys = getKeys(entry);
        if (!keys.includes('CWB:角色档案目录') || !keys.includes(chatId)) continue;
        // Follow only the current chat's existing directory; ignore unrelated books.
        for (const match of String(entry.content ?? '').matchAll(/世界书《([^》]+)》/g)) {
            const name = match[1].trim();
            if (world_names.includes(name)) books.add(name);
        }
    }
    return [...books];
}

async function scanGeneratedContent(phase, onProgress) {
    const chatId = state.chatId.replace(/ imported/g, '');
    if (!chatId || chatId.startsWith('unknown_chat')) throw Error('无法确认当前聊天 ID，已停止扫描以保护其他聊天数据。');
    const primary = getPrimaryWorldbook();
    if (!primary) throw Error('当前角色卡没有主世界书，无法安全定位本聊天的生成记录。');
    const primaryData = await readWorldbookFromServer(primary);
    const configured = extension_settings?.cwb_system_api;
    const configuredTarget = configured?.worldbookTarget === 'custom' ? configured.customWorldbook : null;
    const books = [...new Set([
        primary,
        ...(configuredTarget && world_names.includes(configuredTarget) ? [configuredTarget] : []),
        ...referencedProfileBooks(primaryData, chatId),
    ])];
    const snapshots = [{ bookName: primary, data: primaryData }];
    onProgress?.({ phase, current: 1, total: books.length, bookName: primary });
    let completed = 1;
    const remaining = await mapWithConcurrency(books.slice(1), 4, async bookName => {
        const data = await readWorldbookFromServer(bookName);
        onProgress?.({ phase, current: ++completed, total: books.length, bookName });
        return { bookName, data };
    });
    snapshots.push(...remaining);
    for (const snapshot of snapshots) {
        snapshot.entries = [];
        for (const entry of Object.values(snapshot.data.entries)) {
            const keys = getKeys(entry);
            // Older plugin versions and reordered keys may place either value elsewhere.
            const type = GENERATED_ENTRY_TYPES.find(([marker]) => keys.includes(marker) && keys.includes(chatId));
            if (!type) continue;
            snapshot.entries.push({
                bookName: snapshot.bookName, uid: Number(entry.uid), marker: type[0], label: type[1],
                comment: String(entry.comment ?? ''), content: String(entry.content ?? ''), keys: [...keys],
            });
        }
    }
    return {
        chatId,
        entries: snapshots.flatMap(snapshot => snapshot.entries),
        snapshots: new Map(snapshots.map(snapshot => [snapshot.bookName, snapshot.data])),
        bookCount: books.length,
    };
}
export async function getGeneratedContentPreview(onProgress) {
    const { chatId, entries } = await scanGeneratedContent('scan', onProgress);
    return { chatId, entries };
}

export async function deleteGeneratedContent(preview, onProgress) {
    const chatId = state.chatId.replace(/ imported/g, '');
    if (!preview || preview.chatId !== chatId || !chatId || chatId.startsWith('unknown_chat')) {
        throw Error('当前聊天已变化或无法确认，未删除任何内容。');
    }
    const current = await scanGeneratedContent('verify', onProgress);
    const signature = item => JSON.stringify([item.bookName, item.uid, item.marker, item.label, item.comment, item.content, item.keys]);
    const expected = preview.entries.map(signature).sort();
    const actual = current.entries.map(signature).sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        throw Error('预览后生成条目发生变化，未删除任何内容。请重新扫描并确认。');
    }
    if (!current.entries.length) return { deleted: 0, byType: {} };

    const grouped = new Map();
    for (const item of current.entries) {
        if (!grouped.has(item.bookName)) grouped.set(item.bookName, []);
        grouped.get(item.bookName).push(item);
    }
    let deleted = 0;
    const byType = {};
    let bookIndex = 0;
    for (const [bookName, targets] of grouped) {
        bookIndex++;
        const data = current.snapshots.get(bookName);
        if (!data?.entries) throw Error(`世界书《${bookName}》扫描快照缺失，已停止删除。`);
        const uidSet = new Set(targets.map(item => item.uid));
        const toDelete = Object.values(data.entries).filter(entry => {
            const keys = getKeys(entry);
            const target = targets.find(item => item.uid === Number(entry.uid));
            return uidSet.has(Number(entry.uid)) && Boolean(target && keys.includes(target.marker) && keys.includes(chatId));
        });
        if (toDelete.length !== targets.length) throw Error(`世界书《${bookName}》条目核对失败，未继续删除该世界书内容。`);
        for (const entry of toDelete) {
            const key = Object.keys(data.entries).find(k => data.entries[k] === entry);
            if (key !== undefined) delete data.entries[key];
            const type = targets.find(item => item.uid === Number(entry.uid))?.label;
            if (type) byType[type] = (byType[type] ?? 0) + 1;
        }
        onProgress?.({ phase: 'delete', current: bookIndex, total: grouped.size, bookName });
        await saveWorldInfo(bookName, data, true);
        onProgress?.({ phase: 'readback', current: bookIndex, total: grouped.size, bookName });
        const persisted = await readWorldbookFromServer(bookName);
        const remaining = Object.values(persisted.entries).some(entry => {
            const target = targets.find(item => item.uid === Number(entry.uid));
            const keys = getKeys(entry);
            return Boolean(target && keys.includes(target.marker) && keys.includes(chatId));
        });
        if (remaining) throw Error(`世界书《${bookName}》删除后回读仍发现目标条目；请刷新后检查。`);
        deleted += toDelete.length;
    }
    state.routeCache = null;
    return { deleted, byType };
}

export async function saveCharacterDescription(settings, characterName, content, startFloor, endFloor) {
    const bookName = await routeWorldbook(settings, characterName);
    if (!bookName) return null;
    const chatId = state.chatId.replace(/ imported/g, '');
    const safeName = sanitizeName(characterName);
    const floorRange = `${startFloor + 1}-${endFloor + 1}`;
    const entries = await getEntries(bookName);
    const existing = entries.find(entry => isEnabled(entry)
        && getKeys(entry).includes('CWB:自动档案')
        && getKeys(entry).includes(chatId)
        && getKeys(entry).includes(safeName)
        && !getKeys(entry).includes('Amily2角色总集'));
    const entryData = {
        comment: `动态-${safeName}`,
        content,
        keys: ['CWB:自动档案', chatId, safeName, floorRange],
        enabled: true,
        type: 'selective',
        scanDepth: Number(settings.scanDepth) || 6,
        order: 100,
        position: 4,
        role: 0,
    };
    if (existing) await patchEntries(bookName, [{ uid: existing.uid, ...entryData }]);
    else {
        const depths = entries.filter(entry => getKeys(entry).includes(chatId)).map(entry => Number(entry.depth)).filter(Number.isFinite);
        await createEntries(bookName, [{ ...entryData, depth: Math.max(7000, ...depths) + 1 }]);
    }
    return safeName;
}

export async function saveUserDescription(settings, userName, content, startFloor, endFloor) {
    const bookName = getPrimaryWorldbook();
    if (!bookName) throw new Error('当前角色卡未绑定主世界书，无法保存主角档案。');
    const chatId = state.chatId.replace(/ imported/g, '');
    const safeName = sanitizeName(userName || '主角');
    const floorRange = `${startFloor + 1}-${endFloor + 1}`;
    const entries = await getEntries(bookName);
    const existing = entries.find(entry => getKeys(entry).includes('CWB:主角档案') && getKeys(entry).includes(chatId));
    const entryData = {
        comment: `动态-${safeName}`,
        content,
        keys: ['CWB:主角档案', chatId, safeName, floorRange],
        enabled: true,
        type: 'constant',
        position: 0,
        order: 10001,
        preventRecursion: true,
    };
    if (existing) await patchEntries(bookName, [{ uid: existing.uid, ...entryData }]);
    else await createEntries(bookName, [entryData]);
    return safeName;
}

function timelineKeys(entry) {
    return getKeys(entry).filter(key => /^CWB:时间线楼层:\d+-\d+$/.test(String(key)) || /^\d+-\d+$/.test(String(key)))
        .map(key => String(key).replace(/^CWB:时间线楼层:/, ''));
}

function mergeTimelineContent(contents) {
    return formatTimelineRecords(parseTimelineRecords(contents));
}

// Merge and remove legacy per-range entries in the same worldbook save.
async function writeTimeline(content, startFloor, endFloor) {
    const bookName = getPrimaryWorldbook();
    if (!bookName) throw new Error('当前角色卡未绑定主世界书，无法保存故事时间线。');
    const chatId = state.chatId.replace(/ imported/g, '');
    const data = structuredClone(await loadWorldInfo(bookName));
    if (!data?.entries) throw new Error(`无法读取世界书《${bookName}》。`);
    const existing = Object.values(data.entries).filter(entry => getKeys(entry).includes('CWB:故事时间线') && getKeys(entry).includes(chatId));
    if (!existing.length && content === undefined) return [];
    if (existing.length === 1 && content === undefined) {
        if (!isEnabled(existing[0]) || existing[0].constant !== true || existing[0].selective === true) {
            applyEntryPatch(existing[0], { enabled: true, type: 'constant' });
            await saveWorldInfo(bookName, data, true);
        }
        return existing.map(entry => ({ ...entry, keys: getKeys(entry), enabled: isEnabled(entry) }));
    }
    const ranges = existing.flatMap(timelineKeys).map(range => range.split('-').map(Number));
    if (content !== undefined) ranges.push([startFloor + 1, endFloor + 1]);
    const target = existing[0] || createWorldInfoEntry(bookName, data);
    if (!target) throw new Error('创建世界书条目 UID 失败。');
    applyEntryPatch(target, {
        comment: `CWB故事时间线-${chatId}`,
        content: mergeTimelineContent([...existing.map(entry => entry.content), content]),
        keys: ['CWB:故事时间线', chatId, '故事时间线', ...mergeRanges(ranges).map(([start, end]) => `CWB:时间线楼层:${start}-${end}`)],
        enabled: true, type: 'constant', position: 0, order: 10000, preventRecursion: true,
    });
    const removed = new Set(existing.slice(1));
    for (const key of Object.keys(data.entries)) if (removed.has(data.entries[key])) delete data.entries[key];
    await saveWorldInfo(bookName, data, true);
    // loadWorldInfo reads a client cache. Verify the actual server copy instead.
    const response = await fetch('/api/worldinfo/get', {
        method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name: bookName }), cache: 'no-cache',
    });
    if (!response.ok) throw new Error(`时间线保存后回读失败（HTTP ${response.status}），请重试。`);
    const persisted = await response.json();
    const stored = Object.values(persisted?.entries ?? {}).find(entry => Number(entry.uid) === Number(target.uid));
    if (!stored || stored.content !== target.content) throw new Error('时间线服务端回读与本次写入不一致，不能确认已保存，请重试。');
    return [{ ...target, keys: getKeys(target), enabled: isEnabled(target) }];
}

export async function saveTimeline(settings, content, startFloor, endFloor) {
    return writeTimeline(content, startFloor, endFloor);
}

export async function getTimelineEntries() {
    return writeTimeline();
}

export async function getChatUpdateTracking(totalMessages = 0) {
    const bookName = getPrimaryWorldbook();
    if (!bookName) return null;
    const chatId = state.chatId.replace(/ imported/g, '');
    const data = await readWorldbookFromServer(bookName);
    const { entry, state: saved } = findSavedUpdateState(data, chatId);
    const legacy = saved ? [] : findLegacyUpdateRecords(data, chatId);
    const legacyTracking = trackingFromLegacy(legacy, totalMessages);
    const completedRanges = mergeRanges(saved?.tracking?.completed ?? legacyTracking.completed);
    const duplicateRanges = mergeRanges(saved?.tracking?.duplicates ?? legacyTracking.duplicates);
    const trackingStartIndex = Number.isInteger(saved?.tracking?.startIndex)
        ? saved.tracking.startIndex
        : legacyTracking.startIndex;
    return {
        bookName,
        entry: entry ?? legacy[0] ?? null,
        completedRanges,
        duplicateRanges,
        trackingStartIndex,
        missingRanges: missingRanges(totalMessages, [...completedRanges, ...(trackingStartIndex > 0 ? [[0, trackingStartIndex - 1]] : [])], trackingStartIndex),
    };
}

export async function recordChatUpdateRange(startIndex, endIndex, totalMessages, latest, initialTrackingStart = totalMessages) {
    const bookName = getPrimaryWorldbook();
    if (!bookName) throw new Error('当前角色卡未绑定主世界书，无法保存全聊天更新记录。');
    const chatId = state.chatId.replace(/ imported/g, '');
    const data = await readWorldbookFromServer(bookName);
    const { state: saved } = findSavedUpdateState(data, chatId);
    const oldTrackers = findLegacyUpdateRecords(data, chatId);
    const oldTracking = trackingFromLegacy(oldTrackers, initialTrackingStart);
    const oldCompleted = mergeRanges(saved?.tracking?.completed ?? oldTracking.completed);
    const oldDuplicates = mergeRanges(saved?.tracking?.duplicates ?? oldTracking.duplicates);
    const trackingStartIndex = Number.isInteger(saved?.tracking?.startIndex)
        ? saved.tracking.startIndex
        : oldTracking.startIndex;
    const overlaps = overlappingRanges(startIndex, endIndex, oldCompleted);
    const nextState = {
        ...(saved ?? {}),
        version: 2,
        modules: saved?.modules ?? moduleProgressFromLegacy(data, chatId),
        tracking: {
            startIndex: trackingStartIndex,
            totalMessages: Math.max(0, Number(totalMessages) || 0),
            completed: mergeRanges([...oldCompleted, [startIndex, endIndex]]),
            duplicates: mergeRanges([...oldDuplicates, ...overlaps]),
            latest: `${new Date().toLocaleString()}｜${startIndex}-${endIndex}楼｜${latest}`,
        },
        updatedAt: new Date().toISOString(),
    };
    await persistUpdateState(bookName, chatId, data, nextState);
    return { overlaps, completedRanges: nextState.tracking.completed, duplicateRanges: nextState.tracking.duplicates, trackingStartIndex };
}

export async function updateRoster(settings, processedNames, startFloor, endFloor) {
    const grouped = new Map();
    for (const name of processedNames) {
        const book = await routeWorldbook(settings, name);
        if (book) (grouped.get(book) || grouped.set(book, []).get(book)).push(name);
    }
    if (!grouped.size) throw new Error('无法确定写入世界书。');
    for (const [bookName, namesForBook] of grouped) await updateRosterForBook(bookName, namesForBook, startFloor, endFloor);
    if (settings.multiWorldbookRouting) await updateMasterDirectory(settings);
}

/** Create one compact index in the current character's primary worldbook. */
export async function updateMasterDirectory(settings) {
    const masterBook = getPrimaryWorldbook();
    if (!masterBook) return;
    const chatId = state.chatId.replace(/ imported/g, '');
    const books = settings.multiWorldbookRouting ? listWorldbooks() : [getTargetWorldbook(settings)];
    const grouped = new Map();
    for (const bookName of books.filter(Boolean)) {
        const entries = await getEntries(bookName);
        for (const entry of entries) {
            const keys = getKeys(entry);
            if (!keys.includes('CWB:自动档案') || !keys.includes(chatId)) continue;
            const name = keys.find(key => key !== 'CWB:自动档案' && key !== chatId && !/^\d+-\d+$/.test(String(key)));
            if (name) (grouped.get(bookName) || grouped.set(bookName, new Set()).get(bookName)).add(String(name));
        }
    }
    const lines = [];
    const masterEntries = await getEntries(masterBook);
    const userEntry = masterEntries.find(entry => getKeys(entry).includes('CWB:主角档案') && getKeys(entry).includes(chatId));
    if (userEntry) {
        const userName = getKeys(userEntry).find(key => !['CWB:主角档案', chatId].includes(key) && !/^\d+-\d+$/.test(String(key))) || '主角';
        lines.push(`【主角档案】\n[${userName}] → 主世界书《${masterBook}》中的「动态-${userName}」\n`);
    }
    for (const [bookName, names] of grouped) {
        lines.push(`【故事线世界书：${bookName}】`);
        [...names].sort().forEach(name => lines.push(`[${name}] → 世界书《${bookName}》中的「动态-${name}」`));
    }
    const comment = `CWB角色世界书档案目录-${chatId}`;
    const entries = await getEntries(masterBook);
    const existing = entries.find(entry => entry.comment === comment
        || (getKeys(entry).includes('CWB:角色档案目录') && getKeys(entry).includes(chatId)));
    const content = `【当前聊天角色世界书档案目录】\n\n${lines.join('\n') || '当前尚未生成角色档案。'}\n\n{{// 本条由角色世界书插件自动维护，请勿手动删除。}}`;
    const data = {
        comment,
        content,
        keys: ['CWB:角色档案目录', chatId, '角色档案目录'],
        enabled: false,
        type: 'selective',
        position: 0,
        order: 10000,
        preventRecursion: true,
    };
    if (existing) await patchEntries(masterBook, [{ uid: existing.uid, ...data }]);
    else await createEntries(masterBook, [data]);
}

async function updateRosterForBook(bookName, processedNames, startFloor, endFloor) {
    const context = getContext();
    const chatId = state.chatId.replace(/ imported/g, '');
    const comment = `Amily2角色总集-${chatId}-角色总览`;
    const entries = await getEntries(bookName);
    const existing = entries.find(entry => entry.comment === comment
        || (getKeys(entry).includes('Amily2角色总集') && getKeys(entry).includes(chatId)));
    const names = new Set();
    let oldStart = 1;
    let oldEnd = 0;
    if (existing) {
        for (const line of String(existing.content ?? '').split('\n')) {
            const match = line.match(/^\[([^:]+):/);
            if (match) names.add(match[1].trim());
        }
        const completed = String(existing.content ?? '').match(/【前(\d+)楼角色世界书已更新完成】/);
        if (completed) oldEnd = Number(completed[1]);
        const range = getKeys(existing).find(key => /^\d+-\d+$/.test(key));
        if (range) oldStart = Number(range.split('-')[0]);
    }
    processedNames.forEach(name => names.add(String(name).trim()));
    const newStart = Math.min(oldStart, startFloor + 1);
    const newEnd = Math.max(oldEnd, endFloor + 1);
    const characterName = context?.characters?.[context.characterId]?.name ?? context?.name2 ?? '未识别角色卡';
    const content = `此为当前角色卡【${characterName}】中登场的角色，AI需要根据剧情让以下角色在合适的时机登场：\n\n`
        + [...names].sort().map(name => `[${name}: (详细查看绿灯角色条目)]`).join('\n')
        + `\n\n{{// 本条勿动，【前${newEnd}楼角色世界书已更新完成】否则后续更新无法完成。}}`;
    const data = {
        comment,
        content,
        keys: ['Amily2角色总集', chatId, '角色总览', `${newStart}-${newEnd}`],
        enabled: true,
        type: 'constant',
        position: 0,
        order: 9999,
        preventRecursion: true,
    };
    if (existing) await patchEntries(bookName, [{ uid: existing.uid, ...data }]);
    else await createEntries(bookName, [data]);
}

export async function getTriggeredOldProfiles(settings, messages) {
    if (!settings.incremental) return [];
    const chatId = state.chatId.replace(/ imported/g, '');
    const haystack = messages.map(message => `${message.name ?? ''}\n${message.message ?? ''}`).join('\n').toLowerCase();
    const books = settings.multiWorldbookRouting ? listWorldbooks() : [getTargetWorldbook(settings)];
    const profiles = [];
    const masterBook = getPrimaryWorldbook();
    if (masterBook) {
        const masterEntries = await getEntries(masterBook);
        const userProfile = masterEntries.find(entry => entry.enabled && getKeys(entry).includes('CWB:主角档案') && getKeys(entry).includes(chatId));
        if (userProfile) profiles.push(userProfile.content);
    }
    for (const bookName of books.filter(Boolean)) {
        const entries = await getEntries(bookName);
        profiles.push(...entries.filter(entry => entry.enabled
            && getKeys(entry).includes(chatId)
            && !getKeys(entry).includes('Amily2角色总集')
            && !getKeys(entry).includes('CWB:故事时间线')
            && !getKeys(entry).includes('CWB:主角档案')
            && getKeys(entry).filter(key => !['CWB:自动档案', chatId].includes(key)).some(key => haystack.includes(String(key).toLowerCase())))
            .map(entry => entry.content));
    }
    return profiles;
}

export async function getLastUpdatedFloor(settings) {
    const chatId = state.chatId.replace(/ imported/g, '');
    const books = settings.multiWorldbookRouting ? listWorldbooks() : [getTargetWorldbook(settings)];
    let latest = 0;
    for (const bookName of books.filter(Boolean)) {
        const entries = await getEntries(bookName);
        const roster = entries.find(entry => getKeys(entry).includes('Amily2角色总集') && getKeys(entry).includes(chatId));
        const match = String(roster?.content ?? '').match(/【前(\d+)楼角色世界书已更新完成】/);
        if (match) latest = Math.max(latest, Number(match[1]));
        else {
            const range = getKeys(roster).find(key => /^\d+-\d+$/.test(key));
            if (range) latest = Math.max(latest, Number(range.split('-')[1]));
        }
    }
    return latest;
}

export async function manageChatEntries(settings) {
    const customTarget = settings.worldbookTarget === 'custom';
    const books = customTarget ? [getPrimaryWorldbook()] : settings.multiWorldbookRouting ? listWorldbooks() : [getTargetWorldbook(settings)];
    if (state.chatId.startsWith('unknown_chat')) return;
    const chatId = state.chatId.replace(/ imported/g, '');
    for (const bookName of books.filter(Boolean)) {
        const entries = await getEntries(bookName);
        const patches = [];
        for (const entry of entries) {
            const keys = getKeys(entry);
            if (isPluginReferenceEntry(entry)) {
                if (isAlwaysOnReferenceEntry(entry)) {
                    if (keys.includes(chatId)) {
                        if (!entry.enabled || entry.constant !== true || entry.selective === true) patches.push({ uid: entry.uid, enabled: true, type: 'constant' });
                    } else if (entry.enabled || entry.constant === true) {
                        patches.push({ uid: entry.uid, enabled: false, type: 'selective' });
                    }
                } else if (entry.enabled || entry.constant === true) {
                    patches.push({ uid: entry.uid, enabled: false, type: 'selective' });
                }
                continue;
            }
            if (keys.includes('CWB:更新记录') || keys.includes('CWB:模块进度')) {
                if (entry.enabled) patches.push({ uid: entry.uid, enabled: false });
                continue;
            }
            if (customTarget || settings.enabled === false) continue;
            if (!keys.includes('Amily2角色总集') && !keys.includes(chatId) && !keys.includes(state.chatId)) continue;
            const shouldEnable = keys.includes(chatId) || keys.includes(state.chatId);
            if (entry.enabled !== shouldEnable) patches.push({ uid: entry.uid, enabled: shouldEnable });
        }
        if (patches.length) await patchEntries(bookName, patches);
    }
}

export async function convertLegacyEntries(settings) {
    const bookName = getTargetWorldbook(settings);
    if (!bookName) throw new Error('未找到目标世界书。');
    const entries = await getEntries(bookName);
    const patches = [];
    for (const entry of entries) {
        if (!String(entry.content ?? '').includes('[--Amily2::CHAR_START--]')) continue;
        const parsed = parseCustomFormat(entry.content);
        const rename = (object, oldKey, newKey) => {
            if (object && oldKey in object) { object[newKey] = object[oldKey]; delete object[oldKey]; return true; }
            return false;
        };
        let changed = false;
        [['core_identity','CI'],['physical_imprint','PI'],['psyche_profile','PP'],['social_matrix','SM'],['narrative_essence','NE']]
            .forEach(([oldKey, newKey]) => { if (rename(parsed, oldKey, newKey)) changed = true; });
        const maps = {
            CI: { archetype: 'arch', gender: 'gen', current_status: 'status' },
            PI: { first_impression: 'first', key_features: 'feat', mannerisms: 'manner' },
            PP: { description: 'desc', motivation: 'mot', values: 'val', inner_conflict: 'conf' },
            SM: { interaction_style: 'style', skills: 'skill', reputation: 'rep' },
        };
        Object.entries(maps).forEach(([section, map]) => Object.entries(map).forEach(([oldKey, newKey]) => {
            if (rename(parsed[section], oldKey, newKey)) changed = true;
        }));
        if (changed) {
            const { buildCustomFormat } = await import('./utils.js');
            patches.push({ uid: entry.uid, content: buildCustomFormat(parsed) });
        }
    }
    if (patches.length) await patchEntries(bookName, patches);
    notify(patches.length ? 'success' : 'info', patches.length ? `已转换 ${patches.length} 个旧版档案。` : '没有发现需要转换的旧版档案。');
    return patches.length;
}

export async function getRelationshipSummary() {
    const bookName = getPrimaryWorldbook();
    if (!bookName) throw new Error('当前角色卡未绑定主世界书，无法读取角色关系。');
    const chatId = state.chatId.replace(/ imported/g, '');
    const entries = await getEntries(bookName);
    return entries.filter(entry => getKeys(entry).includes('CWB:角色关系汇总') && getKeys(entry).includes(chatId)).map(entry => entry.content).join('\n');
}

export async function getRelationshipRanges() {
    const bookName = getPrimaryWorldbook();
    if (!bookName) throw new Error('当前角色卡未绑定主世界书。');
    const chatId = state.chatId.replace(/ imported/g, '');
    const entries = await getEntries(bookName);
    return mergeRanges(entries.filter(entry => getKeys(entry).includes('CWB:角色关系汇总') && getKeys(entry).includes(chatId))
        .flatMap(entry => parseTaggedRanges(getKeys(entry), 'CWB:关系楼层:')));
}

export async function saveRelationshipSummary(content, startIndex, endIndex) {
    const bookName = getPrimaryWorldbook();
    if (!bookName) throw new Error('当前角色卡未绑定主世界书，无法保存角色关系。');
    const chatId = state.chatId.replace(/ imported/g, '');
    const data = structuredClone(await loadWorldInfo(bookName));
    if (!data?.entries) throw new Error('无法读取主世界书。');
    const existing = Object.values(data.entries).filter(entry => getKeys(entry).includes('CWB:角色关系汇总') && getKeys(entry).includes(chatId));
    const target = existing[0] || createWorldInfoEntry(bookName, data);
    if (!target) throw new Error('创建角色关系条目失败。');
    const ranges = mergeRanges([...existing.flatMap(entry => parseTaggedRanges(getKeys(entry), 'CWB:关系楼层:')), [startIndex, endIndex]]);
    applyEntryPatch(target, { comment: `CWB角色关系汇总-${chatId}`, content, keys: ['CWB:角色关系汇总', chatId, '角色关系', ...ranges.map(([start, end]) => `CWB:关系楼层:${start}-${end}`)], enabled: true, type: 'constant', position: 0, order: 9998, preventRecursion: true });
    const duplicates = new Set(existing.slice(1));
    for (const key of Object.keys(data.entries)) if (duplicates.has(data.entries[key])) delete data.entries[key];
    await saveWorldInfo(bookName, data, true);
    const response = await fetch('/api/worldinfo/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name: bookName }), cache: 'no-cache' });
    if (!response.ok) throw new Error('角色关系保存后回读失败。');
    const stored = await response.json();
    if (stored?.entries?.[target.uid]?.content !== content) throw new Error('角色关系服务端回读不一致，无法确认保存成功。');
    return target;
}

export async function getModuleProgress() {
    const bookName = getPrimaryWorldbook();
    if (!bookName) throw Error('当前角色卡未绑定主世界书，无法读取模块进度。');
    const chatId = state.chatId.replace(/ imported/g, '');
    const data = await readWorldbookFromServer(bookName);
    const { entry, state: saved } = findSavedUpdateState(data, chatId);
    const legacy = moduleProgressFromLegacy(data, chatId);
    const identityKey = getStableChatIdentityKey();
    if (saved && entry && identityKey && !getKeys(entry).includes(identityKey)) {
        // One-time migration binds the old chat-ID record to stable chat metadata.
        await persistUpdateState(bookName, chatId, data, saved);
    }
    if (saved) return mergeModuleProgress(saved.modules ?? {}, legacy);
    return legacy;
}

export async function recordModuleResult(module, start, end, error = null) {
    const bookName = getPrimaryWorldbook();
    if (!bookName) throw Error('当前角色卡未绑定主世界书，无法保存模块进度。');
    const chatId = state.chatId.replace(/ imported/g, '');
    const data = await readWorldbookFromServer(bookName);
    const { state: saved } = findSavedUpdateState(data, chatId);
    const previous = mergeModuleProgress(saved?.modules ?? legacyModuleProgress(data, chatId), moduleProgressFromLegacy(data, chatId));
    const modules = applyModuleResult(previous, module, start, end, error);
    const nextState = {
        ...(saved ?? {}),
        version: 2,
        modules,
        tracking: saved?.tracking ?? trackingFromLegacy(findLegacyUpdateRecords(data, chatId)),
        updatedAt: new Date().toISOString(),
    };
    await persistUpdateState(bookName, chatId, data, nextState);
    return modules;
}

export async function verifyProfileContent(settings, name, content, isUser = false) {
    const bookName = isUser ? getPrimaryWorldbook() : await routeWorldbook(settings, name);
    if (!bookName) throw Error(`角色 ${name} 未找到目录归属，未标记档案完成。`);
    const response = await fetch('/api/worldinfo/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name: bookName }), cache: 'no-cache' });
    if (!response.ok) throw Error(`角色 ${name} 保存后回读失败。`);
    const data = await response.json();
    const chatId = state.chatId.replace(/ imported/g, '');
    if (!Object.values(data?.entries ?? {}).some(entry => getKeys(entry).includes(chatId) && getKeys(entry).includes(isUser ? 'CWB:主角档案' : 'CWB:自动档案') && entry.content === content)) throw Error(`角色 ${name} 服务端未确认保存。`);
}


function legacyModuleProgress(data, chatId) {
    const entries = Object.values(data?.entries ?? {}).filter(entry => getKeys(entry).includes(chatId));
    const trackers = entries.filter(entry => getKeys(entry).includes('CWB:更新记录'));
    // v0.9.8 wrote this explicit confirmation only after all three sections saved.
    if (!trackers.some(entry => String(entry.content ?? '').includes('三个模块均成功，AI调用1次'))) return {};
    const global = mergeRanges(trackers.flatMap(entry => parseTaggedRanges(getKeys(entry), 'CWB:总结楼层:')));
    const timeline = entries.filter(entry => getKeys(entry).includes('CWB:故事时间线')).flatMap(entry => parseTaggedRanges(getKeys(entry), 'CWB:时间线楼层:').map(([a, b]) => [a - 1, b - 1]));
    const relationships = entries.filter(entry => getKeys(entry).includes('CWB:角色关系汇总')).flatMap(entry => parseTaggedRanges(getKeys(entry), 'CWB:关系楼层:'));
    const confirmed = intersectRanges(intersectRanges(global, timeline), relationships);
    return Object.fromEntries(['profiles', 'timeline', 'relationships'].map(module => [module, { completed: confirmed, failed: [], source: 'v0.9.8三项成功记录与时间线/关系覆盖交叉核对' }]));
}

function parseTrackingStart(keys, fallback = 0) {
    const tag = (keys ?? []).map(key => String(key).match(/^CWB:追踪起点:(\d+)$/)).find(Boolean);
    return tag ? Number(tag[1]) : Math.max(0, Number(fallback) || 0);
}

function findSavedUpdateState(data, chatId) {
    const identityKey = getStableChatIdentityKey();
    const matches = Object.values(data?.entries ?? {}).filter(entry => {
        const keys = getKeys(entry);
        return keys.includes('CWB:更新状态') && (keys.includes(chatId) || (identityKey && keys.includes(identityKey)));
    });
    if (!matches.length) return { entry: null, state: null, duplicates: [] };
    const states = matches.map(entry => {
        let saved;
        try { saved = JSON.parse(entry.content); }
        catch { throw Error('更新状态存档损坏，无法确认进度；原始存档已保留，请先导出备份。'); }
        if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw Error('更新状态存档格式无效，原始存档已保留。');
        return saved;
    });
    const state = states.slice(1).reduce((merged, saved) => ({
        ...merged,
        ...saved,
        modules: mergeModuleProgress(merged.modules ?? {}, saved.modules ?? {}),
        tracking: {
            ...(merged.tracking ?? {}), ...(saved.tracking ?? {}),
            completed: mergeRanges([...(merged.tracking?.completed ?? []), ...(saved.tracking?.completed ?? [])]),
            duplicates: mergeRanges([...(merged.tracking?.duplicates ?? []), ...(saved.tracking?.duplicates ?? [])]),
            startIndex: Math.min(merged.tracking?.startIndex ?? 0, saved.tracking?.startIndex ?? 0),
            totalMessages: Math.max(merged.tracking?.totalMessages ?? 0, saved.tracking?.totalMessages ?? 0),
        },
    }), states[0]);
    return { entry: matches[0], state, duplicates: matches.slice(1) };
}

function getStableChatIdentityKey() {
    const metadata = getContext()?.chatMetadata;
    const integrity = String(metadata?.integrity ?? '').trim();
    // Branches can inherit their parent's integrity ID; keep them file-scoped.
    if (!integrity || metadata?.main_chat) return null;
    return `CWB:聊天身份:${integrity}`;
}

function findLegacyUpdateRecords(data, chatId) {
    return Object.values(data?.entries ?? {}).filter(entry => getKeys(entry).includes('CWB:更新记录') && getKeys(entry).includes(chatId));
}

function trackingFromLegacy(entries = [], fallbackStart = 0) {
    const keys = entries.flatMap(getKeys);
    const latestEntry = [...entries].reverse().find(entry => /最近一次：/.test(String(entry.content ?? '')));
    const latest = String(latestEntry?.content ?? '').match(/最近一次：(.+)/)?.[1] ?? '';
    return {
        startIndex: parseTrackingStart(keys, fallbackStart),
        totalMessages: 0,
        completed: mergeRanges(parseTaggedRanges(keys, 'CWB:总结楼层:')),
        duplicates: mergeRanges(parseTaggedRanges(keys, 'CWB:重复总结楼层:')),
        latest,
    };
}

function moduleProgressFromLegacy(data, chatId) {
    const current = legacyModuleProgress(data, chatId);
    const oldEntries = Object.values(data?.entries ?? {}).filter(entry => getKeys(entry).includes('CWB:模块进度') && getKeys(entry).includes(chatId));
    if (!oldEntries.length) return current;
    try {
        const parsed = oldEntries.map(entry => JSON.parse(entry.content).modules ?? {});
        const saved = Object.fromEntries(Object.keys(MODULE_LABELS).map(module => {
            const rows = parsed.map(item => item[module] ?? {});
            return [module, {
                completed: mergeRanges(rows.flatMap(row => row.completed ?? [])),
                failed: mergeRanges(rows.flatMap(row => row.failed ?? [])),
                latest: rows.map(row => row.latest).filter(Boolean).at(-1),
            }];
        }));
        return mergeModuleProgress(saved, current);
    }
    catch { throw Error('旧版模块进度存档损坏，无法迁移；原始存档已保留。'); }
}

async function readWorldbookFromServer(bookName) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), 30000) : null;
    let response, data;
    try {
        response = await fetch('/api/worldinfo/get', {
            method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name: bookName }), cache: 'no-cache', ...(controller ? { signal: controller.signal } : {}),
        });
        if (!response.ok) throw Error(`无法从服务端读取世界书《${bookName}》。`);
        data = await response.json();
    } catch (error) {
        if (controller?.signal.aborted) throw Error(`读取世界书《${bookName}》超过30秒，已停止并保留未确认条目。`);
        throw error;
    } finally {
        if (timeout !== null) clearTimeout(timeout);
    }
    if (!data?.entries) throw Error(`世界书《${bookName}》返回的数据格式无效。`);
    return data;
}

async function persistUpdateState(bookName, chatId, data, nextState) {
    const identityKey = getStableChatIdentityKey();
    const matches = Object.values(data.entries).filter(entry => {
        const keys = getKeys(entry);
        const belongsToChat = keys.includes(chatId) || (identityKey && keys.includes(identityKey));
        return belongsToChat && (keys.includes('CWB:更新状态') || keys.includes('CWB:更新记录') || keys.includes('CWB:模块进度'));
    });
    const target = matches.find(entry => getKeys(entry).includes('CWB:更新状态')) || matches[0] || createWorldInfoEntry(bookName, data);
    if (!target) throw Error('无法创建统一更新状态条目。');
    const canonical = {
        comment: `CWB插件更新状态-${chatId}`,
        content: JSON.stringify({ version: 2, numbering: 'zero-based inclusive', ...nextState }),
        keys: ['CWB:更新状态', chatId, ...(identityKey ? [identityKey] : [])],
        enabled: false,
        type: 'selective',
        preventRecursion: true,
    };
    applyEntryPatch(target, canonical);
    for (const duplicate of matches) {
        if (duplicate === target) continue;
        const key = Object.keys(data.entries).find(key => data.entries[key] === duplicate);
        if (key !== undefined) delete data.entries[key];
    }
    await saveWorldInfo(bookName, data, true);
    const persisted = await readWorldbookFromServer(bookName);
    const stored = Object.values(persisted.entries).find(entry => Number(entry.uid) === Number(target.uid));
    if (!stored || stored.content !== canonical.content || !getKeys(stored).includes('CWB:更新状态')) {
        throw Error('统一更新状态保存后回读不一致；进度未确认，请刷新后检查。');
    }
    return stored;
}


export async function cleanupProfileFields(settings) {
    const chatId = state.chatId.replace(/ imported/g, '');
    const books = settings.multiWorldbookRouting ? listWorldbooks() : [getTargetWorldbook(settings)];
    const primary = getPrimaryWorldbook();
    const targets = [...new Set([...books, primary].filter(Boolean))];
    let changed = 0, skipped = 0;
    for (const bookName of targets) {
        const entries = await getEntries(bookName);
        const patches = [];
        for (const entry of entries) {
            const keys = getKeys(entry);
            if (!keys.includes(chatId) || (!keys.includes('CWB:自动档案') && !keys.includes('CWB:主角档案'))) continue;
            const content = sanitizeProfileContent(entry.content);
            if (content === null) { skipped++; continue; }
            if (content !== entry.content) patches.push({ uid: entry.uid, content });
        }
        if (patches.length) {
            await patchEntries(bookName, patches);
            const response = await fetch('/api/worldinfo/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name: bookName }), cache: 'no-cache' });
            if (!response.ok) throw Error('精简档案保存后回读失败。');
            const stored = await response.json();
            for (const patch of patches) if (stored?.entries?.[patch.uid]?.content !== patch.content) throw Error('精简档案回读不一致，无法确认清理成功。');
            changed += patches.length;
        }
    }
    return { changed, skipped };
}
