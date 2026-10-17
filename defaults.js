import { PROFILE_RULES } from './profile-utils.mjs';

export const PROFILE_PROMPT_RULE_MARKER = '【CWB角色档案强相关筛选规则 v0.10.4】';
export function ensureProfilePromptRules(prompt) {
    const text = String(prompt ?? '').trim();
    return text.includes(PROFILE_PROMPT_RULE_MARKER) ? text : `${text}\n\n${PROFILE_PROMPT_RULE_MARKER}\n${PROFILE_RULES}`;
}

const PROFILE_FORMAT = `只输出档案数据，不解释、不用Markdown代码块。每个角色独立输出：
[--角色档案开始--]
[档案类型]:角色或主角
[姓名]:实际姓名
[剧情.0]:日期｜关键事件及结果（角色亲历、获知或直接承受后果；强力影响主线或后续走向）
[--角色档案结束--]
上面是唯一允许的档案字段；无符合强相关标准的新剧情则输出[--档案无变化--]。主角与其他角色使用相同格式。`;

export const cwbCompleteDefaultSettings = {
    cwb_break_armor_prompt: '你是动态世界书整理器。只整理给定聊天中已发生的事实，不续写、不推测，不让角色知道其尚未获知的秘密。',
    cwb_char_card_prompt: ensureProfilePromptRules(`从给定聊天整理角色与主角的个人关键剧情档案，不输出其他资料。\n${PROFILE_FORMAT}`),
    cwb_incremental_char_card_prompt: ensureProfilePromptRules(`融合旧档案与新对话，只为有强相关个人关键剧情新增或实质变化的角色输出档案；重新筛选旧剧情，删除关联弱、无后续影响或过于琐碎的记录，合并重复。\n${PROFILE_FORMAT}`),
};

// Replace only exact fingerprints of the previous built-in prompts; preserve custom prompts.
function fingerprint(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
    return `${value.length}:${hash >>> 0}`;
}
export function migrateBuiltinProfilePrompt(value, kind) {
    const old = { fullPrompt: '2506:3257958421', incrementalPrompt: '3477:1662916541' };
    if (typeof value !== 'string' || fingerprint(value) !== old[kind]) return value;
    return kind === 'fullPrompt' ? cwbCompleteDefaultSettings.cwb_char_card_prompt : cwbCompleteDefaultSettings.cwb_incremental_char_card_prompt;
}

export const TIMELINE_PROMPT_RULE_MARKER = '【CWB时间线格式规则 v0.10.8】';
export const TIMELINE_CONCISION_RULES = `时间线内容硬性要求：只记录当前主线及其因果链直接相关的关键变化、重要决定及后果、冲突结果、秘密揭露或重要关系转折。先判断剧情归属；不同且无因果关联的故事线不要揉在一起，也不要写入当前主线，无法确认强相关时省略。同一天仅将属于同一故事线的关键进展合并为一条，不得仅因日期相同就合并无关事件。每条事件正文尽量写到40—56个汉字，保留必要因果、关键行为和结果，不要为追求简短删掉剧情关键信息。日常、对话过程、情绪、步骤、重复背景及枝节仍省略。任务及任务进度、任务提示/面板，以及任何系统消息、系统提示、系统状态/数值、系统奖励、功能或操作信息一律不得进入时间线；即使这些内容出现在聊天中或推动任务进度，也忽略。输出字段仅为“日期”和“事件”，不得单独列出出场角色，必要人名可写在事件正文中。同一天的日期只出现一次，格式为“日期｜事件”；无符合条件的剧情进展时输出空数组。`;
export function ensureTimelinePromptRules(prompt) {
    const text = String(prompt ?? '').trim()
        .replace(/\n*【CWB时间线格式规则 v[^】]+】[\s\S]*$/g, '')
        .trim();
    return `${text}\n\n${TIMELINE_PROMPT_RULE_MARKER}\n${TIMELINE_CONCISION_RULES}`;
}

export const DEFAULT_TIMELINE_INCREMENTAL_PROMPT = ensureTimelinePromptRules(`你是主线时间线的增量整理器。本次是独立的时间线请求，不生成角色档案，不续写故事。
输入分为【已有时间线】与【本次新增聊天】。只记录当前主线及其因果链直接相关、会影响后续剧情的关键信息和大事件，例如重大决定及后果、关系阶段改变、冲突结果、秘密揭露、重要目标变化或重要物品/能力得失。先判断事件所属故事线；彼此无因果关联的独立故事线不得揉在一起，也不得写入当前主线，无法确认强相关时省略。同一天只合并同一故事线中的关键进展，不得仅因日期相同而合并无关事件。任务内容、任务进度、任务提示/面板，以及任何系统消息、系统提示、系统状态/数值、系统奖励、功能或操作信息一律不记录；即使这些内容出现在聊天中或推动任务进度，也必须忽略。普通日常、对话过程、情绪描写、行动步骤、重复背景及枝节一律省略；没有实质剧情进展就不记录。
已有时间线只用于去重和判断进展。只在旧事件出现实质变化或后续结果时新增，不因换场景、换说法或再次提及而重复记录。每个事件只写一句，先写关键变化、必要因果和结果，删去无关细节与修饰语；事件正文尽量写到40—56个汉字，保留理解剧情所需的信息，不得为精简而删掉关键行为、因果或后果。按剧情日期排序；日期不明确写“日期未知”，不得编造。旧记录由插件保留并自动合并。同一天只有属于同一故事线的关键进展才合并成一条；日期只标注一次，不同故事线绝不拼接。
只输出合法 JSON：{"时间线":[{"日期":"YYYY-MM-DD或日期未知","事件":"本日关键事件合并摘要"}]}，不得输出“人物”或“出场角色”字段。
如果新增聊天没有符合以上标准且属于当前主线的重大进展，输出 {"时间线":[],"无新增原因":"无关键信息或大事件"}。不得只回复“已更新”或重复已有时间线。`);
