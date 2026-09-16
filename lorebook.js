import { getContext } from '/scripts/extensions.js';
import {
    createWorldInfoEntry,
    loadWorldInfo,
    saveWorldInfo,
    world_names,
} from '/scripts/world-info.js';
import { state } from './state.js';
import { notify, parseCustomFormat, sanitizeName } from './utils.js';

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
    const bookName = getTargetWorldbook(settings);
    if (!bookName) throw new Error('当前角色没有主世界书，且未选择指定世界书。');
    const chatId = state.chatId.replace(/ imported/g, '');
    const safeName = sanitizeName(characterName);
    const floorRange = `${startFloor + 1}-${endFloor + 1}`;
    const entries = await getEntries(bookName);
    const existing = entries.find(entry => isEnabled(entry)
        && getKeys(entry).includes(chatId)
        && getKeys(entry).includes(safeName)
        && !getKeys(entry).includes('Amily2角色总集'));
    const entryData = {
        comment: `${safeName}-${chatId}`,
        content,
        keys: [chatId, safeName, floorRange],
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

export async function updateRoster(settings, processedNames, startFloor, endFloor) {
    const bookName = getTargetWorldbook(settings);
    if (!bookName) throw new Error('无法确定写入世界书。');
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
    const bookName = getTargetWorldbook(settings);
    if (!bookName) return [];
    const chatId = state.chatId.replace(/ imported/g, '');
    const haystack = messages.map(message => `${message.name ?? ''}\n${message.message ?? ''}`).join('\n').toLowerCase();
    const entries = await getEntries(bookName);
    return entries.filter(entry => entry.enabled
        && getKeys(entry).includes(chatId)
        && !getKeys(entry).includes('Amily2角色总集')
        && getKeys(entry).filter(key => key !== chatId).some(key => haystack.includes(String(key).toLowerCase())))
        .map(entry => entry.content);
}

export async function getLastUpdatedFloor(settings) {
    const bookName = getTargetWorldbook(settings);
    if (!bookName) return 0;
    const chatId = state.chatId.replace(/ imported/g, '');
    const entries = await getEntries(bookName);
    const roster = entries.find(entry => getKeys(entry).includes('Amily2角色总集') && getKeys(entry).includes(chatId));
    const match = String(roster?.content ?? '').match(/【前(\d+)楼角色世界书已更新完成】/);
    if (match) return Number(match[1]);
    const range = getKeys(roster).find(key => /^\d+-\d+$/.test(key));
    return range ? Number(range.split('-')[1]) : 0;
}

export async function manageChatEntries(settings) {
    if (settings.worldbookTarget === 'custom') return;
    const bookName = getTargetWorldbook(settings);
    if (!bookName || state.chatId.startsWith('unknown_chat')) return;
    const chatId = state.chatId.replace(/ imported/g, '');
    const entries = await getEntries(bookName);
    const patches = [];
    for (const entry of entries) {
        const keys = getKeys(entry);
        if (!keys.includes('Amily2角色总集') && !keys.includes(chatId) && !keys.includes(state.chatId)) continue;
        const shouldEnable = keys.includes(chatId) || keys.includes(state.chatId);
        if (entry.enabled !== shouldEnable) patches.push({ uid: entry.uid, enabled: shouldEnable });
    }
    if (patches.length) await patchEntries(bookName, patches);
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
