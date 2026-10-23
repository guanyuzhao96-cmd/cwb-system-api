// Storage ownership is a character avatar, never a chat filename or message floor.
export const CARD_PREFIX = 'CWB:角色卡:';
export const ARCHIVE_MARKERS = ['CWB:自动档案', 'CWB:主角档案', 'CWB:故事时间线', 'CWB:角色关系汇总', 'CWB:角色档案目录', 'CWB:更新状态', 'CWB:更新记录', 'CWB:模块进度', 'Amily2角色总集'];
const keysOf = entry => entry.key ?? entry.keys ?? [];

export function archiveCharacter(context) {
    const characters = context?.characters ?? [];
    const selected = context?.characterId;
    const character = selected !== null && selected !== undefined && selected !== '' ? characters[selected] : null;
    // A group flag does not invalidate an explicitly selected character file.
    if (typeof character?.avatar === 'string' && character.avatar.trim()) return character;
    const group = (context?.groups ?? []).find(item => String(item.id) === String(context?.groupId));
    const members = [...new Set(group?.members ?? [])];
    if (members.length === 1) {
        const member = characters.find(item => item?.avatar === members[0]);
        if (typeof member?.avatar === 'string' && member.avatar.trim()) return member;
    }
    if (group && members.length > 1) throw Error('当前群聊未指定存档角色卡，无法确定已有资料的归属；请先选中要使用的角色卡。');
    throw Error('酒馆尚未提供当前角色卡文件（characterId / avatar），请打开角色聊天后刷新进度；未读取或改写其他卡资料。');
}

export function cardKey(context) {
    return CARD_PREFIX + encodeURIComponent(archiveCharacter(context).avatar);
}

export function owns(entry, owner) {
    const owners = keysOf(entry).filter(key => String(key).startsWith(CARD_PREFIX));
    return owners.length === 1 && owners[0] === owner;
}

export function migrateOwnership(data, { owner, exclusivePrimary, legacyOwners = [] }) {
    const patches = [];
    for (const entry of Object.values(data.entries ?? {})) {
        const keys = keysOf(entry);
        const marker = ARCHIVE_MARKERS.find(key => keys.includes(key));
        if (!marker) continue;
        const owners = keys.filter(key => String(key).startsWith(CARD_PREFIX));
        if (owners.length && !owns(entry, owner)) continue;
        // An explicit card owner is already authoritative. Reordering its keys
        // on read would mutate verified profiles during a cross-book move.
        if (owns(entry, owner)) continue;
        if (!owners.length && !exclusivePrimary && !keys.some(key => legacyOwners.includes(key))) continue;
        const name = ['CWB:自动档案', 'CWB:主角档案'].includes(marker)
            ? String(entry.content ?? '').match(/\[(?:姓名|name)\]\s*[:：]\s*([^\n]+)/)?.[1]?.trim() : null;
        const next = [...new Set([marker, owner, ...keys.filter(key => String(key).startsWith('CWB:')
            && !String(key).startsWith(CARD_PREFIX) && !String(key).startsWith('CWB:聊天身份:')),
        ...keys.filter(key => /^\d+-\d+$/.test(String(key)) || ['故事时间线', '角色关系', '角色档案目录', '角色总览'].includes(key)), ...(name ? [name] : [])])];
        if (JSON.stringify(keys) === JSON.stringify(next)) continue;
        entry.cwbLegacyOwnerKeys ??= [...keys]; // provenance only, never used as the new owner
        entry.key = next;
        if ('keys' in entry) entry.keys = [...next];
        patches.push({ uid: entry.uid, keys: next, content: entry.content });
    }
    return patches;
}

// Prefix hashes identify source content. Renames/copies retain progress; a changed
// floor invalidates its suffix. Different new chats cannot inherit floor numbers.
export async function sourceHashes(messages, digest) {
    let prefix = '';
    const hashes = [];
    for (const message of messages) {
        prefix = await digest(JSON.stringify([prefix, !!message.is_user, !!message.is_system, message.name ?? '', message.mes ?? message.message ?? '']));
        hashes.push(prefix);
    }
    return hashes;
}

export function receiptProgress(receipts, hashes) {
    const result = {};
    for (const module of ['profiles', 'timeline', 'relationships']) {
        const completed = [], failed = [];
        let latest;
        hashes.forEach((hash, index) => {
            const record = receipts?.[hash]?.[module];
            if (!record) return;
            (record.error ? failed : completed).push([index, index]);
            if (!latest || latest.time < record.time) latest = { ...record, start: index, end: index };
        });
        result[module] = { completed, failed, latest };
    }
    return result;
}
