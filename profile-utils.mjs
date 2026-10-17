import { parseCustomFormat, buildCustomFormat } from './utils.js';

export const PROFILE_RULES = `角色与主角档案只允许“档案类型”“姓名”“角色已知信息.N”“角色未知信息.N”“性经历人员.N”“性经历人数”“额外补充.N”和“剧情.N”字段，其他字段一律删除，不记录状态、目标、物品、能力、关系、好感或无关数值。
“角色已知信息”只记录该角色亲自经历、亲自获知或已被明确告知的重要事实；不得把叙述者知道、但角色未接触的信息混入。“角色未知信息”只记录剧情明确确认且对后续扮演重要、但该角色尚未获知的事实或秘密；不得凭空推断角色不知道什么。角色获知后，应从未知移到已知，避免两边重复。
“性经历人员”只记录剧情明确确认已发生性行为的成年对象姓名；仅在对象明确为18岁以上时记录，未成年或年龄不明一律省略。不得依据暧昧、恋爱、亲吻或推测补全经历，不写露骨过程。“性经历人数”按已确认成年对象去重计数，必须与名单一致；不明时省略，只有明确确认没有经历时才写0，不把次数当人数。
“额外补充”只记录会影响后续理解或角色塑造、且其他字段未覆盖的重要事实；不得重复已知、未知或剧情内容。
个人关键剧情必须同时满足：角色亲自参与、亲自获知或直接承受后果；并且事件强力推动或改变主线、重大冲突、关键秘密、角色核心目标或后续走向。只保留重大决定及其结果、关键冲突转折、重要秘密揭露、目标达成/失败及其持续影响等事件。仅被提及、与主线联系弱、无后续影响的事件不得记录。
日常互动、普通对话、行动步骤、情绪变化、重复背景、枝节、未执行的计划和一般生活细节全部省略；不要把同一事件拆成多条，也不要复制全局时间线。剧情条目格式为“日期｜关键行为、必要因果及结果”，每条不超过64个汉字。相较旧版可保留约两倍篇幅，优先写清角色做了什么、为何重要及造成什么结果；不要删掉关键因果，也不要为凑字数扩写。
增量更新时只输出本轮有新增或实质变化的字段；旧档案中符合新规则的有效信息继续保留，事实变化时改正，重复信息合并。角色没有任何新增或实质变化时用[--档案无变化--]。即使其他提示词要求保留更多字段，也必须遵守本规则。`;

const lists = new Set(['角色已知信息', '角色未知信息', '性经历人员', '额外补充', '剧情']);
const scalars = new Set(['性经历人数']);
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
    for (const key of scalars) {
        const value = String(parsed[key] ?? '').trim();
        if (key === '性经历人数' && clean['性经历人员']?.length) {
            clean[key] = String(clean['性经历人员'].length);
        } else if (/^\d+$/.test(value)) {
            clean[key] = String(Number(value));
        }
    }
    return buildCustomFormat(clean);
}

export function hasProfileFacts(content) {
    const parsed = parseCustomFormat(content);
    return [...lists].some(key => {
        const items = parsed[key];
        return Array.isArray(items) ? items.some(item => String(item ?? '').trim()) : typeof items === 'string' && Boolean(items.trim());
    }) || Boolean(parsed['性经历人数']);
}
