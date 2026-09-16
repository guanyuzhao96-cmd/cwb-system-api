const FORMAT_RULES = `
<输出协议>
只输出角色档案数据，不要解释、标题、道歉或 Markdown 代码块。
每个角色使用一个完整区块：
[--Amily2::CHAR_START--]
[数据路径]:数据值
[--Amily2::CHAR_END--]
每个键值独占一行；键必须放在方括号中；未知值保留键并留空；区块内部不得出现空行。
</输出协议>`;

const FIELD_SCHEMA = `
<字段定义>
[name]:角色姓名
[CI.arch]:核心身份或人物原型
[CI.gen]:性别
[CI.age]:年龄
[CI.race]:种族或民族
[CI.status]:当前处境、状态或情绪
[PI.first]:第一印象与整体气质
[PI.feat]:显著外貌特征
[PI.attire]:服装与风格
[PI.manner]:标志动作、姿态或口头习惯
[PI.voice]:音色、语速和语气
[PP.tags]:3—5个性格标签，以“/”分隔
[PP.desc]:性格及其剧情表现
[PP.mot]:当前核心动机
[PP.val]:价值观或行为原则
[PP.conf]:内在矛盾、恐惧或弱点
[SM.style]:社交和互动方式
[SM.skill]:关键技能或能力
[SM.rep]:社会评价或声望
[NE.trait.0.name]:核心特质名称；可继续使用 trait.1、trait.2
[NE.trait.0.def]:特质定义
[NE.trait.0.evid.0]:体现该特质的言行证据；可继续编号
[NE.verb.style]:语言风格
[NE.verb.quote.0]:代表性原话；可继续编号
[NE.rel.0.name]:重要关系对象；可继续使用 rel.1、rel.2
[NE.rel.0.sum]:关系性质、重要性和互动模式
</字段定义>`;

export const cwbCompleteDefaultSettings = {
    cwb_break_armor_prompt: `你是角色档案整理助手。请忠实提取虚构聊天中的人物信息，不自行续写剧情，不把用户本人建立为非玩家角色。`,
    cwb_char_card_prompt: `
你负责从给定聊天记录中识别所有非用户角色，并为每名角色生成结构化档案。以明确文本为主；只有在上下文足够时才做保守推断。不同角色必须分开输出，不要遗漏有姓名或具备稳定身份的次要角色。
${FORMAT_RULES}
${FIELD_SCHEMA}
确保每个角色至少包含 [name]，并尽量输出字段定义中的完整结构。现在根据随后提供的聊天内容生成档案。`,
    cwb_incremental_char_card_prompt: `
你负责融合旧角色档案与新对话，输出更新后的结构化档案。
${FORMAT_RULES}
${FIELD_SCHEMA}
<增量规则>
1. [name] 是角色标识，必须保留旧档案中的姓名，不得随意改名。
2. 保留仍然有效的旧信息，将新对话中的状态、关系、动机、特质和证据合并进去。
3. 只有新对话明确推翻旧信息时才修正；随剧情变化的状态以新对话为准。
4. 用新证据补全空缺。关系、特质和引文可以按数字索引扩展。
5. 对每个需要更新的角色输出一个完整档案区块；不要只输出差异字段。
6. 没有旧档案的角色按字段定义新建完整档案。
</增量规则>
随后会依次提供【旧档案】和【新对话】，请直接输出合并后的角色档案。`,
};
