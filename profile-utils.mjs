import { parseCustomFormat, buildCustomFormat } from './utils.js';

export const PROFILE_RULES = `角色与主角档案必须精简，只允许：档案类型、姓名、当前状态、角色已知信息、角色不知信息、长期目标、短期目标、重要物品.N、已解锁能力.N、剧情.N。
删除好感度、态度/情绪评分、信任度等数值，删除性经历人数/对象/次数及其他计数统计，不记录任何数值增减过程。人物之间的同学、亲属、情侣、敌对、暗恋、后宫成员等关系统一写独立关系增量，角色档案不得再列人际关系或关系表。
当前状态只写仍影响后续剧情的处境，一句即可；已知/不知只写重要事实与秘密边界，不罗列琐碎信息。目标、物品、能力只保留仍有效的关键内容；能力只写名称与已证实效果，不写等级/数值变化日志。
个人剧情只记录该角色亲历、得知或直接承受后果的关键事件，每条“日期｜关键行动与结果”，尽量40字内；合并重复、略去闲聊、普通动作、情绪起伏和数值变化，不复制整份全局时间线。已确认的关键历史与秘密边界不能为缩短字数而丢弃。
只输出本轮确有这些事实变化的角色；仅被提到、仅数值变化或仅关系标签变化的角色不输出档案。主角无关键变化也不强制输出。角色没有变化时用[--档案无变化--]，不得为凑字段编写内容。旧档案中的已删除字段不继承，即使其他提示词要求保留也以此规则为准。`;

const scalar = new Set(['当前状态', '角色已知信息', '角色不知信息', '长期目标', '短期目标']);
const lists = new Set(['重要物品', '已解锁能力', '剧情']);
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
    for (const key of scalar) {
        if (parsed[key] !== undefined && typeof parsed[key] !== 'object') {
            const value = conciseValue(parsed[key]);
            if (value) clean[key] = value;
        }
    }
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
    return [...scalar, ...lists].some(key => parsed[key] !== undefined);
}
