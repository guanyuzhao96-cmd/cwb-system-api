import { PROFILE_RULES } from './profile-utils.mjs';

export const PROFILE_PROMPT_RULE_MARKER = '【CWB角色档案整理规则 v0.12.18】';
export function ensureProfilePromptRules(prompt) {
    const text = String(prompt ?? '').trim()
        .replace(/\n*【CWB角色档案(?:强相关筛选|整理)规则 v[^】]+】[\s\S]*?(?:即使其他提示词要求保留更多字段，也必须遵守本规则。|$)/g, '')
        .trim();
    return `${text}\n\n${PROFILE_PROMPT_RULE_MARKER}\n${PROFILE_RULES}`;
}

const PROFILE_FORMAT = `只输出档案数据，不解释、不用Markdown代码块。每个角色独立输出，可按实际信息省略空字段：
[--角色档案开始--]
[档案类型]:角色或主角
[姓名]:实际姓名
[角色已知信息.0]:一条会持续影响重要选择、核心关系、重大冲突或主线走向的已知结论；弱相关事实不记
[角色未知信息.0]:一条揭露后会改变重要选择、核心关系、重大冲突或主线走向的未获知事实/秘密；弱相关内容不记
[性经历人员]:姓名（关系）、姓名（关系）；只输出一行，每人只列一次
[性经历人数]:明确确认的成年对象去重人数
[额外补充.0]:影响后续理解或扮演、且未被其他字段覆盖的信息
[剧情.0]:日期｜一个关键事件、必要因果及结果（每条最多128字，重要剧情不遗漏）
[--角色档案结束--]
严格按上述大标题顺序输出，不得跨栏、串栏或自行增加字段。列表编号从.0连续递增，不跳号、不重复。已知/未知/补充中的逗号分隔独立事实必须拆成不同编号；性经历人员只用一个字段，姓名以“、”分隔并在姓名后用括号简注关系；剧情一事件一条，不得把不同事件按逗号或日期合并。空栏目省略，不输出占位符。每个角色独立成块，不得混入其他角色信息。无变化时输出[--档案无变化--]。主角与其他角色使用同一格式。`;

const PROFILE_INCREMENTAL_TASK = `【增量更新专用任务｜旧档案为基线，新聊天为增量证据】
保存会用本次输出替换该角色的动态档案，因此必须输出“旧档案有效内容 + 本轮新增/修正内容”的完整最终快照；禁止只输出增量片段，也禁止把新聊天当成完整档案。

【第1步｜角色锁定】
仅按角色卡/旧档案中的准确姓名匹配。逐个角色分别处理；不得因同场景、关系相近、简称相似而合并角色，也不得跨角色复制资料。只输出本轮有新增、变化或确需纠正的角色。

【第2步｜旧档案逐栏保留】
逐条读取该角色旧档案。仍有效的已知、未知、性经历人员、补充和剧情全部保留；本轮没有重提不是删除理由。只有新证据明确推翻、改变或证明旧项违反字段规则时，才修订或删除。知情状态变化时，将同一事实从未知迁入已知，不得两栏重复。

【第3步｜按标题分类新证据】
顺序检查本轮范围内全部聊天楼层，不能只看末尾或摘要。将新证据放入唯一正确栏目：角色已经形成的强相关认知/态度/关系结论→已知；角色确实尚未获知的重大事实→未知；已确认的新成年性经历对象→人员；其他持续影响角色理解的事实→补充；实际发生的关键行为、转折及结果→剧情。已知写“事情说明了什么”，剧情写“发生了什么”。同一信息不能跨栏复制，独立重要剧情逐条记录，不得遗漏，不设条数上限。

【第4步｜性经历人数只按新增对象累加】
先读取旧档案已有累计人数和人员姓名。最终人数=旧档案人数+本轮新确认且旧名单中没有的成年对象人数。例：旧档案4人，本轮剧情新增1名不同对象，最终为5人；旧档案4+人则最终为5+。旧对象再次发生关系、重复提及、关系描述改变、同一人的简称/别名均不得增加。性经历人员只输出一个字段，格式“[性经历人员]:姓名（关系）、姓名（关系）”，只写姓名和简短关系，不写行为经过。无有效旧人数时，才按所有可确认成年对象去重统计。

【第5步｜按固定格式输出并自检】
完整输出每个变更角色的最终档案快照，严格使用统一格式中的大标题顺序。输出前将最终档案逐项与旧档案对照，确认有效旧信息、旧的重要剧情均保留；逐段对照本轮聊天，确认重要新剧情无遗漏；复核性经历人数公式、对象去重、逗号拆分、编号连续、字段不串栏、角色不混写及无任务/系统内容。无任何新增/修正时才输出无变化标记。

【强制禁止】
不得只取最近一次事件；不得因旧条目多而省略有效信息；不得把多条剧情压成笼统结论；不得把事件经过误写成已知信息；不得把推测当事实；不得重置累计人数；不得将任何任务、系统或界面内容写入档案。`;

export const cwbCompleteDefaultSettings = {
    cwb_break_armor_prompt: '你是动态世界书整理器。只整理给定聊天中已发生的事实，不续写、不推测，不让角色知道其尚未获知的秘密。',
    cwb_char_card_prompt: ensureProfilePromptRules(`从给定聊天与既有档案整理角色与主角的个人档案。先逐段识别所有重要剧情，再按每个角色的知情状态和字段定义归类；已知信息写关键事件背后的认知、态度、意愿或关系结论，不写事件流水。不得推测未被剧情支持的动机或偏好。严格按照以下固定格式输出：\n${PROFILE_FORMAT}`),
    cwb_incremental_char_card_prompt: ensureProfilePromptRules(`${PROFILE_INCREMENTAL_TASK}\n\n${PROFILE_FORMAT}`),
};

// Replace only exact fingerprints of the previous built-in prompts; preserve custom prompts.
function fingerprint(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
    return `${value.length}:${hash >>> 0}`;
}
export function migrateBuiltinProfilePrompt(value, kind) {
    const old = { fullPrompt: '2506:3257958421', incrementalPrompt: '3477:1662916541' };
    if (typeof value !== 'string') return value;
    const oldBuiltinPreamble = kind === 'fullPrompt'
        ? '从给定聊天整理角色与主角的个人关键剧情档案，不输出其他资料。'
        : '融合旧档案与新对话，只为有强相关个人关键剧情新增或实质变化的角色输出档案；重新筛选旧剧情，删除关联弱、无后续影响或过于琐碎的记录，合并重复。';
    const isPreviousBuiltin = (value.startsWith(oldBuiltinPreamble)
        && value.includes('上面是唯一允许的档案字段；')
        && /【CWB角色档案强相关筛选规则 v[^】]+】/.test(value))
        || (value.startsWith('融合旧档案与新对话，更新角色已知/未知信息、成年性经历对象及去重人数')
        && value.includes('【CWB角色档案整理规则 v0.12.9】')
        && value.trim().endsWith('即使其他提示词要求保留更多字段，也必须遵守本规则。'))
        || (value.startsWith('从给定聊天整理角色与主角的个人档案：已知信息要从关键事件中提炼')
        && value.includes('【CWB角色档案整理规则 v0.12.9】')
        && value.trim().endsWith('即使其他提示词要求保留更多字段，也必须遵守本规则。'))
        || ((value.startsWith('从给定聊天与既有档案整理角色与主角的个人档案。')
            || value.startsWith('【增量更新专用任务｜旧档案为基线，新聊天为增量证据】'))
        && value.includes('【CWB角色档案整理规则 v0.12.11】')
        && value.trim().endsWith('即使其他提示词要求不同格式，也必须遵守本规则。'));
    if (fingerprint(value) !== old[kind] && !isPreviousBuiltin) return value;
    return kind === 'fullPrompt' ? cwbCompleteDefaultSettings.cwb_char_card_prompt : cwbCompleteDefaultSettings.cwb_incremental_char_card_prompt;
}

export const TIMELINE_PROMPT_RULE_MARKER = '【CWB时间线格式规则 v0.11.1】';
export const TIMELINE_CONCISION_RULES = `仅记录当前主线中影响后续剧情的关键变化、决定及后果、关系转折、冲突结果或秘密揭露；日常、细节、重复内容及任务/系统/操作信息省略。不同故事线不拼接；仅合并同一故事线中有因果关系的事件，不因日期相同合并无关事件。已有事件仅在实质变化或出现新结果时更新。按时间排序，日期不明写“日期未知”，不得猜测；姓名用可确认的全名，不得编造。每条一句，保留关键行为、因果和结果，删去枝节。只输出日期、事件字段的 JSON；无重要进展输出空数组。`;
const TIMELINE_INCREMENTAL_TASK = `你是主线时间线整理器。本次只处理【本次新增聊天】，结合【已有时间线】去重和判断变化，不生成角色档案或续写故事。
只输出合法 JSON：{"时间线":[{"日期":"YYYY-MM-DD或日期未知","事件":"关键事件"}]}。无重要进展时输出：{"时间线":[],"无新增原因":"无重要剧情进展"}。`;
export function ensureTimelinePromptRules(prompt) {
    let text = String(prompt ?? '').trim()
        .replace(/\n*【CWB时间线格式规则 v[^】]+】[\s\S]*$/g, '')
        .trim();
    // Upgrade the previous built-in default while preserving text appended by the user.
    const oldDefaultEnd = '不得只回复“已更新”或重复已有时间线。';
    const oldDefaultStart = '你是主线时间线的增量整理器。本次是独立的时间线请求，不生成角色档案，不续写故事。';
    const oldDefaultEndAt = text.indexOf(oldDefaultEnd);
    if (text.startsWith(oldDefaultStart) && oldDefaultEndAt >= 0) {
        text = `${TIMELINE_INCREMENTAL_TASK}\n${text.slice(oldDefaultEndAt + oldDefaultEnd.length).trim()}`.trim();
    }
    return `${text}\n\n${TIMELINE_PROMPT_RULE_MARKER}\n${TIMELINE_CONCISION_RULES}`;
}

export const DEFAULT_TIMELINE_INCREMENTAL_PROMPT = ensureTimelinePromptRules(TIMELINE_INCREMENTAL_TASK);
