import { getContext } from '/scripts/extensions.js';
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
import { mergeRanges, missingRanges, overlappingRanges, parseTaggedRanges, updateTrackerContent } from './update-tracker.mjs';

const getKeys = entry => Array.isArray(entry?.key) ? entry.key : (Array.isArray(entry?.keys) ? entry.keys : []);
const isEnabled = entry => entry?.enabled !== false && entry?.disable !== true;

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

export async function saveTimeline(settings, content, startFloor, endFloor) {
    const bookName = getPrimaryWorldbook();
    if (!bookName) throw new Error('当前角色卡未绑定主世界书，无法保存故事时间线。');
    const chatId = state.chatId.replace(/ imported/g, '');
    const floorRange = `${startFloor + 1}-${endFloor + 1}`;
    const entries = await getEntries(bookName);
    const floorTag = `CWB:时间线楼层:${floorRange}`;
    const existing = entries.find(entry => getKeys(entry).includes('CWB:故事时间线')
        && getKeys(entry).includes(chatId)
        && (getKeys(entry).includes(floorTag) || getKeys(entry).includes(floorRange)));
    const entryData = {
        comment: `CWB故事时间线-${chatId}-楼层${floorRange}`,
        content,
        keys: ['CWB:故事时间线', chatId, '故事时间线', floorTag],
        enabled: true,
        type: 'constant',
        position: 0,
        order: 10000,
        preventRecursion: true,
    };
    if (existing) await patchEntries(bookName, [{ uid: existing.uid, ...entryData }]);
    else await createEntries(bookName, [entryData]);
}

export async function getTimelineEntries() {
    const bookName = getPrimaryWorldbook();
    if (!bookName) throw new Error('当前角色卡未绑定主世界书，无法读取故事时间线。');
    const chatId = state.chatId.replace(/ imported/g, '');
    const entries = await getEntries(bookName);
    return entries.filter(entry => getKeys(entry).includes('CWB:故事时间线') && getKeys(entry).includes(chatId));
}

export async function getChatUpdateTracking(totalMessages = 0) {
    const bookName = getPrimaryWorldbook();
    if (!bookName) return null;
    const chatId = state.chatId.replace(/ imported/g, '');
    const entries = await getEntries(bookName);
    const entry = entries.find(item => getKeys(item).includes('CWB:更新记录') && getKeys(item).includes(chatId));
    const keys = entry ? getKeys(entry) : [];
    const completedRanges = mergeRanges(parseTaggedRanges(keys, 'CWB:总结楼层:'));
    const duplicateRanges = mergeRanges(parseTaggedRanges(keys, 'CWB:重复总结楼层:'));
    const trackingStartTag = keys.map(key => String(key).match(/^CWB:追踪起点:(\d+)$/)).find(Boolean);
    const trackingStartIndex = trackingStartTag ? Number(trackingStartTag[1]) : Math.max(0, Number(totalMessages) || 0);
    return {
        bookName,
        entry,
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
    const entries = await getEntries(bookName);
    const existing = entries.find(item => getKeys(item).includes('CWB:更新记录') && getKeys(item).includes(chatId));
    const oldKeys = existing ? getKeys(existing) : [];
    const oldCompleted = parseTaggedRanges(oldKeys, 'CWB:总结楼层:');
    const oldDuplicates = parseTaggedRanges(oldKeys, 'CWB:重复总结楼层:');
    const oldStart = oldKeys.map(key => String(key).match(/^CWB:追踪起点:(\d+)$/)).find(Boolean);
    const trackingStartIndex = oldStart ? Number(oldStart[1]) : Math.max(0, Number(initialTrackingStart) || 0);
    const overlaps = overlappingRanges(startIndex, endIndex, oldCompleted);
    const completedRanges = mergeRanges([...oldCompleted, [startIndex, endIndex]]);
    const duplicateRanges = mergeRanges([...oldDuplicates, ...overlaps]);
    const keys = [
        'CWB:更新记录', chatId, '全聊天总结记录',
        `CWB:追踪起点:${trackingStartIndex}`,
        ...completedRanges.map(([start, end]) => `CWB:总结楼层:${start}-${end}`),
        ...duplicateRanges.map(([start, end]) => `CWB:重复总结楼层:${start}-${end}`),
    ];
    const content = updateTrackerContent({
        completedRanges,
        duplicateRanges,
        totalMessages,
        trackingStartIndex,
        latest: `${new Date().toLocaleString()}｜${startIndex}-${endIndex}楼｜${latest}`,
    });
    const data = {
        comment: `CWB全聊天更新记录-${chatId}`,
        content,
        keys,
        enabled: false,
        type: 'selective',
        preventRecursion: true,
    };
    if (existing) await patchEntries(bookName, [{ uid: existing.uid, ...data }]);
    else await createEntries(bookName, [data]);
    return { overlaps, completedRanges, duplicateRanges, trackingStartIndex };
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
        enabled: true,
        type: 'constant',
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
    if (settings.worldbookTarget === 'custom') return;
    const books = settings.multiWorldbookRouting ? listWorldbooks() : [getTargetWorldbook(settings)];
    if (state.chatId.startsWith('unknown_chat')) return;
    const chatId = state.chatId.replace(/ imported/g, '');
    for (const bookName of books.filter(Boolean)) {
        const entries = await getEntries(bookName);
        const patches = [];
        for (const entry of entries) {
            const keys = getKeys(entry);
            if (keys.includes('CWB:更新记录')) {
                if (entry.enabled) patches.push({ uid: entry.uid, enabled: false });
                continue;
            }
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
