import { PROFILE_RULES } from './profile-utils.mjs';

const PROFILE_FORMAT = `只输出档案数据，不解释、不用Markdown代码块。每个角色独立输出：
[--角色档案开始--]
[档案类型]:角色或主角
[姓名]:实际姓名
[当前状态]:一句关键处境
[角色已知信息]:已确认的关键事实，多条用分号
[角色不知信息]:会影响剧情的秘密或误会，多条用分号
[长期目标]:核心目标
[短期目标]:当前目标
[重要物品.0]:物品｜当前持有与用途
[已解锁能力.0]:名称｜已证实效果
[剧情.0]:YYYY-MM-DD或日期未知｜关键行动与结果
[--角色档案结束--]
上面是允许字段示例，无依据或无内容就省略，不输出占位内容。主角与其他角色使用相同精简字段。`;

export const cwbCompleteDefaultSettings = {
    cwb_break_armor_prompt: '你是动态世界书整理器。只整理给定聊天中已发生的事实，不续写、不推测，不让角色知道其尚未获知的秘密。',
    cwb_char_card_prompt: `从给定聊天整理角色与主角的精简动态档案。\n${PROFILE_FORMAT}\n${PROFILE_RULES}`,
    cwb_incremental_char_card_prompt: `融合旧档案与新对话，为确有关键事实变化的角色输出更新后的完整精简档案；保留关键历史和信息边界，合并重复，删除失效状态。\n${PROFILE_FORMAT}\n${PROFILE_RULES}`,
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

export const DEFAULT_TIMELINE_INCREMENTAL_PROMPT = `你是主线时间线的增量整理器。本次是独立的时间线请求，不生成角色档案，不续写故事。
输入分为【已有时间线】与【本次新增聊天】。只从新增聊天提取已发生、值得后续记住的剧情进展：关键行动与结果、关系阶段变化、冲突进展、秘密揭露、目标达成或改变、重要物品或能力变化。无需达到重大转折才记录，但省略闲聊、重复动作和细碎过程。
已有时间线仅供去重。相同人物、相同地点、相同话题的后续发展仍是新事件，不能因为旧时间线已经提到这些人物就全部忽略。旧事件不重复输出，旧记录由插件保留并自动合并。每个独立事件用一句话概括，尽量不超过40字，按剧情日期排序；日期不明确写“日期未知”，不得编造。
只输出合法 JSON：{"时间线":[{"日期":"YYYY-MM-DD或日期未知","人物":"直接参与者","事件":"新发生的行动、变化及结果"}]}。
如果新增聊天确实没有可记录进展，输出 {"时间线":[],"无新增原因":"用一句话说明"}。不得只回复“已更新”或重复已有时间线。`;
