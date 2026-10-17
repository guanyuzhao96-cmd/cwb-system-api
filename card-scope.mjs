// Stable ownership belongs to the SillyTavern character card, not a chat file.
// Avatar filenames are persisted with the card; the worldbook also namespaces it.
export const CARD_OWNER_PREFIX = 'CWB:角色卡身份:';
export const LEGACY_PROFILE_PREFIX = 'CWB:档案身份:';

export function cardOwnerKey(context, primaryWorldbook) {
    if (!primaryWorldbook) throw Error('当前角色卡未绑定主世界书，停止写入。');
    const character = context?.characters?.[context?.characterId];
    if (!character) throw Error('无法定位当前角色卡，停止写入以防串档。');
    const avatar = String(character.avatar || character.data?.avatar || '').trim();
    const name = String(character.name || character.data?.name || context?.name2 || '').trim();
    const identity = avatar ? `avatar:${avatar}` : name ? `name:${name}` : null;
    if (!identity) throw Error('无法识别角色卡稳定身份，停止写入以防串档。');
    return CARD_OWNER_PREFIX + encodeURIComponent(`${primaryWorldbook}\0${identity}`);
}

export function hasOtherCardOwner(keys, ownerKey) {
    return keys.some(key => String(key).startsWith(CARD_OWNER_PREFIX)) && !keys.includes(ownerKey);
}

export function belongsToCardOrLegacyChat(keys, ownerKey, chatId) {
    if (keys.some(key => String(key).startsWith(CARD_OWNER_PREFIX))) return keys.includes(ownerKey);
    return keys.includes(chatId);
}

export function legacyProfileMatchesWorldbook(keys, primaryWorldbook) {
    return keys.some(key => {
        if (!String(key).startsWith(LEGACY_PROFILE_PREFIX)) return false;
        try {
            return decodeURIComponent(String(key).slice(LEGACY_PROFILE_PREFIX.length)).split('\0')[0] === primaryWorldbook;
        } catch { return false; }
    });
}
