import { replaceProfilePlot } from './profile-utils.mjs';

export const PROFILE_COMPACTION_BATCH_SIZE = 5;
export const PROFILE_COMPACTION_BATCH_PROTOCOL = `本次按角色分别精简，每批最多5个角色。每个角色独立执行前述事件合并和细节删减规则，不得跨角色混写、复制或合并剧情。
本次输出格式统一为：{"角色档案":[{"id":"输入的原始id","姓名":"输入的原始姓名","剧情":["日期｜事件"]}]}。
对每个输入角色准确返回一次，id和姓名必须原样对应；不得省略角色、重复id或添加其他角色。无重要剧情的角色也返回其id、姓名和空剧情数组。只输出合法JSON，不要沿用单角色的顶层剧情数组。`;

export function parseProfileCompactionBatch(response, candidates) {
    const json = String(response ?? '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '');
    let parsed;
    try { parsed = JSON.parse(json); } catch { throw Error('本批精简结果不是合法 JSON，本批档案未写入。'); }
    if (!Array.isArray(parsed?.角色档案) || parsed.角色档案.length !== candidates.length) throw Error('本批精简结果缺少或多出角色，本批档案未写入。');
    const expected = new Map(candidates.map(item => [item.id, item]));
    const contents = new Map();
    for (const result of parsed.角色档案) {
        const candidate = expected.get(result?.id);
        if (!candidate || contents.has(result.id) || result.姓名 !== candidate.name) throw Error('本批角色标识或姓名不匹配，本批档案未写入。');
        // Validate every role before returning any writeable results.
        contents.set(result.id, replaceProfilePlot(candidate.content, result.剧情));
    }
    return candidates.map(item => contents.get(item.id));
}

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
