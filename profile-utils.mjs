import { parseCustomFormat, buildCustomFormat } from './utils.js';

export const PROFILE_RULES = `角色与主角档案只允许“档案类型”“姓名”和“剧情.N”字段，其他字段一律删除，不记录状态、已知/未知、目标、物品、能力、关系、好感、数值或次数。
个人关键剧情必须同时满足：角色亲自参与、亲自获知或直接承受后果；并且事件强力推动或改变主线、重大冲突、关键秘密、角色核心目标或后续走向。只保留重大决定及其结果、关键冲突转折、重要秘密揭露、目标达成/失败及其持续影响等事件。仅被提及、与主线联系弱、无后续影响的事件不得记录。
日常互动、普通对话、行动步骤、情绪变化、重复背景、枝节、未执行的计划、数值变化和一般生活细节全部省略；不要把同一事件拆成多条，也不要复制全局时间线。只输出本轮确有新增或实质变化的个人关键剧情，格式为“日期｜关键事件及结果”，每条尽量不超过32个汉字，合并重复。
旧档案只保留符合以上强相关标准的个人关键剧情；不能确认相关性时宁可省略。角色没有符合标准的新剧情时用[--档案无变化--]。即使其他提示词要求保留更多字段，也必须遵守本规则。`;

const lists = new Set(['剧情']);
const stat = '(?:好感(?:度|值)?|信任(?:度|值)|依赖(?:度|值)|服从(?:度|值)|忠诚(?:度|值)|堕落(?:度|值)|亲密(?:度|值)|欲望(?:度|值)|经验值|经验点|金币数|累计次数|性经历人数|与主角次数)';
const statPattern = new RegExp(stat);
function conciseValue(value) {
    return String(value ?? '').split(/\r?\n/).flatMap(line => line.split(/[；;。]/)).map(part => {
        // Remove a trailing score clause while retaining the factual event before it.
        const cleaned = part.replace(new RegExp(`[,，]\\s*${stat}[^,，;；。]*`, 'g'), '').trim();
        return statPattern.test(cleaned) && /\d/.test(cleaned) ? '' : cleaned;
    }).filter(Boolean).join('；');
}

// Return null for unrecognisable legacy prose so cleanup cannot silently erase it.
export function sanitizeProfileContent(content) {
    const parsed = parseCustomFormat(content);
    const name = parsed.姓名 || parsed.name || parsed.CI?.name || parsed.core_identity?.name;
    if (!name) return null;
    const type = parsed.档案类型 || parsed.record_type || '角色';
    const clean = { 档案类型: type, 姓名: name };
    for (const key of lists) {
        const original = parsed[key];
        const items = Array.isArray(original) ? original : original && typeof original === 'object' ? Object.values(original) : original === undefined ? [] : [original];
        const values = [...new Set(items.filter(item => typeof item !== 'object').map(conciseValue).filter(Boolean))];
        if (values.length) clean[key] = values;
    }
    return buildCustomFormat(clean);
}

export function hasProfileFacts(content) {
    const parsed = parseCustomFormat(content);
    const items = parsed.剧情;
    return Array.isArray(items) ? items.some(item => String(item ?? '').trim()) : typeof items === 'string' && Boolean(items.trim());
}
