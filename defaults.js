const OUTPUT_PROTOCOL = `
<输出协议>
只输出档案数据，不要解释、标题、道歉或 Markdown 代码块。
每个非用户角色输出一个独立区块：
[--Amily2::CHAR_START--]
[record_type]:CHARACTER
[name]:角色姓名
[数据路径]:数据值
[--Amily2::CHAR_END--]
用户主角另外输出一个独立区块，并使用 [record_type]:USER；[name] 必须等于随后提供的当前用户姓名。
每个键值独占一行，键放在方括号内，区块内部不留空行。
</输出协议>`;

const DYNAMIC_SCHEMA = `
<唯一允许的字段>
[record_type]:CHARACTER 或 USER
[name]:姓名
[DY.affinity]:非用户角色对{{user}}的当前好感度，0—100整数；USER区块不使用时留空
[DY.trust]:非用户角色对{{user}}的当前信任度，0—100整数；USER区块不使用时留空
[DY.dependence]:非用户角色对{{user}}的当前依赖或在意程度，0—100整数；USER区块不使用时留空
[DY.relationship_stage]:与{{user}}的当前关系阶段
[DY.attitude]:当前对{{user}}的态度、期待和顾虑
[DY.change.0.metric]:发生变化的数值或关系项目；可继续 change.1、change.2
[DY.change.0.before]:变化前的值或状态
[DY.change.0.after]:变化后的值或状态
[DY.change.0.delta]:数值变化量，例如 +5、-3；非数值变化填写“状态变化”
[DY.change.0.reason]:变化原因
[DY.change.0.evidence]:对应的新对话事实
[SEX.summary]:仅在明确为成年时，非露骨总结当前已经确认的性经历；未成年、年龄不明或没有可靠记录时填写“不适用/未记录”
[SEX.total_count]:已经确认的性行为总次数；无法确认时填写“未知”，不得猜测
[SEX.partner.0.name]:经历对象；可继续 partner.1、partner.2
[SEX.partner.0.relation]:发生时及当前的关系
[SEX.partner.0.count]:与该对象已经确认的次数；无法确认时填写“未知”
[SEX.partner.0.status]:当前是否仍保持亲密关系及边界变化
[SEX.change]:本次新对话造成的性经历或亲密边界变化；没有变化填写“无变化”
[REL.0.name]:仅用于 USER 区块，相关角色姓名；可继续 REL.1、REL.2
[REL.0.affinity]:该角色对主角的当前好感度，0—100整数
[REL.0.trust]:该角色对主角的当前信任度，0—100整数
[REL.0.stage]:该角色与主角的当前关系阶段
[REL.0.change]:本次关系或数值变化及原因
[PL.0.title]:当前剧情条目标题；可继续 PL.1、PL.2
[PL.0.status]:进行中/已完成/搁置/失败
[PL.0.summary]:该条目截至目前的剧情摘要
[PL.0.key_events]:已经发生的关键事件，按时间顺序简明列出
[PL.0.conflict]:当前冲突、阻碍或未解决问题
[PL.0.trigger]:后续继续推进或触发该剧情的条件
[PL.0.next]:基于已发生内容可以预期的下一步，不得擅自续写
[PL.0.characters]:该剧情条目涉及的角色
</唯一允许的字段>`;

const COMMON_RULES = `
<整理规则>
1. 只整理性经历、对{{user}}的动态数值与变化、当前剧情条目；禁止输出外貌、服装、性格、背景、语言风格、身体细节、静态人物介绍或其他字段。
2. 数值必须是 0—100 整数。旧档案存在时以旧值为起点，只根据新对话中明确发生的事件调整；没有充分依据就保持不变。
3. 每次数值或关系变化都必须写入 DY.change，并同时给出变化前、变化后、变化量、原因和对话证据；不得仅凭模型主观判断大幅跳变。
4. 性经历只做非露骨事实统计，不描述行为过程或身体细节，不把暧昧、亲吻、梦境、幻想或未完成行为误计为性行为。年龄不明或非成年人一律填写“不适用/未记录”。
5. 剧情使用 PL.0、PL.1……按独立事件线、任务线或关系线组织，不按楼层或章节流水账。相同剧情沿用原条目并更新，不重复创建。
6. 已完成剧情保留关键结果；进行中剧情保留冲突、未解决事项和触发条件。不得把计划、猜测或未来可能发生的事写成已发生事实。
7. CHARACTER 区块记录该角色自己的 SEX、DY 和其参与的 PL；USER 区块记录主角自己的 SEX、REL 和主角参与的 PL。
</整理规则>`;

export const cwbCompleteDefaultSettings = {
    cwb_break_armor_prompt: `你是动态角色记录整理器。只根据聊天和旧档案维护事实，不续写剧情，不补全未发生事件。`,
    cwb_char_card_prompt: `
你负责从聊天记录中识别用户主角和所有发生了动态变化的非用户角色，为每个人生成精简档案。
${OUTPUT_PROTOCOL}
${DYNAMIC_SCHEMA}
${COMMON_RULES}
这是一次全量整理：综合给定聊天范围，建立截至当前的性经历统计、对用户动态数值和剧情条目。即使某项没有变化，也保留当前值或填写“无变化”。`,
    cwb_incremental_char_card_prompt: `
你负责把旧动态档案与新对话合并，输出更新后的完整档案。必须同时输出用户主角的 USER 区块和本轮涉及角色的 CHARACTER 区块。
${OUTPUT_PROTOCOL}
${DYNAMIC_SCHEMA}
${COMMON_RULES}
<增量规则>
1. 保留旧档案中仍然有效的 SEX、DY、REL 和 PL 信息，只根据新对话新增、修正或更新。
2. DY 数值没有明确变化依据时沿用旧值；有变化时必须记录本轮 before、after、delta、reason 和 evidence。
3. SEX.total_count 只在新对话明确确认发生了新的性行为时增加，并同步更新对应 partner 条目；无法确定次数时保持旧值。
4. 相同剧情条目沿用原 PL 编号和标题，更新摘要、状态、关键事件、冲突与触发条件；只有真正独立的新剧情才新增编号。
5. 输出每个涉及对象更新后的完整区块，不只输出差异字段。
</增量规则>`,
};
