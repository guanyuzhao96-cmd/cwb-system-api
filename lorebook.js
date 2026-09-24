import { getContext } from '/scripts/extensions.js';
import {
    createWorldInfoEntry,
    loadWorldInfo,
    saveWorldInfo,
    world_names,
} from '/scripts/world-info.js';
import { state } from './state.js';
import { notify, parseCustomFormat, sanitizeName } from './utils.js';
import { callSystemApi } from './api.js';

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

function namesFromContent(content) {
    const text = String(content ?? '')
        .replace(/<\s*br\s*\/?\s*>/gi, '\n')
        .replace(/<\s*\/\s*(?:div|p|li|tr|section|article|h[1-6])\s*>/gi, '\n')
        .replace(/<\s*(?:div|p|li|tr|section|article|h[1-6])\b[^>]*>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;|&#160;/gi, ' ')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&amp;/gi, '&')
        .replace(/\r/g, '');
    const found = [];
    for (const match of text.matchAll(/(?:^|\n)\s*(?:[•·▪●◦◆◇\-–—]\s*)*(?:\[\s*)?(?:name|姓名)(?:\s*\])?\s*[:：]\s*["'“‘]?\s*([^"'“”‘’\n]+?)\s*["'“”‘’]?\s*(?:\n|$)/gim)) {
        const name = match[1].trim().replace(/^[•·▪●◦◆◇\-–—\s]+|[\s。；;，,]+$/g, '');
        if (name && !found.includes(name)) found.push(name);
    }
    return found;
}

function routeNames(entries) {
    const directories = entries.filter(entry => getKeys(entry).includes('CWB:世界书目录'));
    const names = new Set();
    for (const entry of directories) namesFromContent(entry.content).forEach(name => names.add(name));
    return [...names];
}

function currentChatText() {
    const context = getContext();
    const messages = Array.isArray(context?.chat) ? context.chat : [];
    return messages.map(message => {
        const speaker = message.is_user ? (context?.name1 || '用户') : (message.name || context?.name2 || '角色');
        const content = String(message.mes ?? message.message ?? '').trim();
        return content ? `【${speaker}】\n${content}` : '';
    }).filter(Boolean).join('\n\n');
}

function parseNamesFromApi(result) {
    const cleaned = String(result).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch {
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (!match) throw new Error(`目录 API 返回格式无法解析：${cleaned.slice(0, 300)}`);
        try { parsed = JSON.parse(match[0]); }
        catch { throw new Error(`目录 API 返回的 JSON 无效：${cleaned.slice(0, 300)}`); }
    }
    const list = Array.isArray(parsed) ? parsed : parsed?.角色名单 ?? parsed?.names;
    if (!Array.isArray(list)) throw new Error('目录 API 结果缺少“角色名单”数组。');
    return [...new Set(list.map(item => String(typeof item === 'string' ? item : item?.姓名 ?? item?.name ?? '').trim()).filter(name => /^[\u3400-\u9fff·A-Za-z0-9_-]{2,24}$/.test(name)))];
}

async function generateDirectoryNames(bookName, chatText, onProgress = () => {}) {
    if (!chatText.trim()) throw new Error('当前聊天没有可读取的消息内容，未生成目录。');
    const chunks = chatText.match(/[\s\S]{1,12000}/g) || [];
    const names = new Set();
    for (let index = 0; index < chunks.length; index++) {
        onProgress(`正在调用酒馆系统 API：${bookName}（第 ${index + 1}/${chunks.length} 段）`);
        console.info(`[CWB] 正在调用系统 API 生成目录：${bookName}（${index + 1}/${chunks.length}）`);
        let response;
        try {
            response = await callSystemApi([
                { role: 'system', content: '你是聊天角色目录生成器。根据当前聊天记录识别实际参与剧情、具有独立身份的角色。优先读取状态栏中“姓名/名字/Name”等字段，也要从正文和对话中识别明确的角色姓名；状态栏可能含HTML、br、项目符号、全角标点。不要把用户、AI助手、旁白、地点、组织、物品或偶然提及的人名当成角色，不要补造姓名。保留完整姓名并去重。只输出合法JSON：{"角色名单":["姓名"]}；没有可确认角色时输出空数组。' },
                { role: 'user', content: `以下是当前聊天记录（分段 ${index + 1}/${chunks.length}），用于生成世界书“${bookName}”的角色目录。请只提取本段中明确出现且属于剧情角色的姓名。\n\n${chunks[index]}` },
            ], 2048);
        } catch (error) {
            throw new Error(`《${bookName}》调用酒馆系统 API 失败：${error.message}`);
        }
        parseNamesFromApi(response).forEach(name => names.add(name));
    }
    const result = [...names].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    if (!result.length) throw new Error(`API 未能从当前聊天识别出《${bookName}》目录角色；没有写入空目录。`);
    return result;
}

function directoryContent(names) {
    return `【小故事线目录】\n${names.length ? names.map(name => `姓名: "${name}"`).join('\n') : '（暂无可自动识别的角色）'}`;
}

function duplicateLines(duplicates) {
    return [...duplicates.entries()]
        .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))
        .map(([name, books]) => `${name}：${[...books].sort((a, b) => a.localeCompare(b, 'zh-CN')).join('、')}`);
}

export async function generateWorldbookDirectories(keyword, onProgress = () => {}) {
    const normalizedKeyword = String(keyword ?? '').trim();
    if (!normalizedKeyword) throw new Error('请输入用于筛选小故事线世界书的关键词。');
    const targetBooks = listWorldbooks().filter(name => String(name).includes(normalizedKeyword));
    if (!targetBooks.length) throw new Error(`没有找到名称包含“${normalizedKeyword}”的世界书。`);

    const chatText = currentChatText();
    if (!chatText.trim()) throw new Error('当前聊天没有可读取的消息内容，请先打开有聊天记录的对话。');
    const plans = [];
    const owners = new Map();
    for (const bookName of targetBooks) {
        onProgress(`正在读取当前聊天，并为《${bookName}》生成角色目录…`);
        const entries = await getEntries(bookName);
        const names = await generateDirectoryNames(bookName, chatText, onProgress);
        plans.push({ bookName, entries, names });
        names.forEach(name => (owners.get(name) ?? owners.set(name, new Set()).get(name)).add(bookName));
    }

    for (const bookName of listWorldbooks()) {
        const entries = await getEntries(bookName);
        routeNames(entries).forEach(name => (owners.get(name) ?? owners.set(name, new Set()).get(name)).add(bookName));
    }
    const duplicates = new Map([...owners].filter(([, books]) => books.size > 1));
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
        keyword: normalizedKeyword,
        generated,
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
    const candidates = Object.entries(routes).filter(([, route]) => route.names.some(name => name.toLowerCase() === characterName.toLowerCase()));
    if (!candidates.length) return null;
    const primary = candidates.find(([, route]) => route.primary);
    return (primary || candidates[0])[0];
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
