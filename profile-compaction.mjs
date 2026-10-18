export const profileSelectionKey = (bookName, uid) => JSON.stringify([bookName, String(uid)]);

export async function countProfileTokens(content) {
    const { getTokenCountAsync } = await import('/scripts/tokenizers.js');
    const count = await getTokenCountAsync(String(content ?? ''));
    if (!Number.isFinite(count) || count < 0) throw Error('无法获取档案 token 数，请重试。');
    return count;
}

export function tokenReduction(before, after) {
    if (!before) return after ? `增加 ${after} tokens` : '减少 0.0%';
    const percent = (before - after) / before * 100;
    return percent >= 0 ? `减少 ${percent.toFixed(1)}%` : `增加 ${(-percent).toFixed(1)}%`;
}
