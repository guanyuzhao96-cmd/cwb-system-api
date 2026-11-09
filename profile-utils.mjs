import { parseCustomFormat, buildCustomFormat } from './utils.js';

export const PROFILE_RULES = `角色与主角档案只允许“档案类型”“姓名”“角色已知信息.N”“角色未知信息.N”“性经历人员.N”“性经历人数”“额外补充.N”和“剧情.N”字段，其他字段一律删除，不记录状态、目标、物品、能力、关系、好感或无关数值。
“角色已知信息”与“角色未知信息”都必须与主线或该角色的个人剧情线强相关，并会实质影响角色的重要选择、核心关系、重大冲突、关键秘密或后续走向。已知信息只记录该角色亲自经历、亲自获知或已被明确告知的重要事实；不得把叙述者知道、但角色未接触的信息混入。未知信息只记录剧情明确确认且对后续扮演和主线发展重要、但该角色尚未获知的事实或秘密；不得凭空推断角色不知道什么。角色获知后，应从未知移到已知，避免两边重复。普通日常、一般对话、临时情绪、无后续影响的细节、单纯被提及的信息，即使真实也不记录。
“性经历人员”只记录剧情明确确认已发生性行为的成年对象姓名；仅在对象明确为18岁以上时记录，未成年或年龄不明一律省略。不得依据暧昧、恋爱、亲吻或推测补全经历，不写露骨过程。“性经历人数”按已确认成年对象去重计数，必须与名单一致；不明时省略，只有明确确认没有经历时才写0，不把次数当人数。
“额外补充”只记录会影响后续理解或角色塑造、且其他字段未覆盖的重要事实；必须与剧情强相关，不得记录普通生活细节或重复已知、未知、剧情内容。
个人关键剧情必须同时满足：角色亲自参与、亲自获知或直接承受后果；并且事件强力推动或改变主线、重大冲突、关键秘密、角色核心目标或后续走向，或对该角色自己的剧情线产生明确后果。共同事件中，分别保留每个人的独立贡献、新获知的事实和实际承受的后果。只被提名、在场却没有独立贡献或后果、与任何剧情线无关的细节不记为个人剧情。
角色档案严禁记录任何任务或系统相关内容，包括任务目标/进度/提示、系统消息/提示/面板/状态/数值/奖励、签到、积分、功能说明、操作过程及界面文本；即使角色亲自经历、内容会影响数值或在剧情中出现，也不得写入任何字段。发现这类内容时整条删除，不要改写后保留。
日常互动、普通对话、行动步骤、情绪变化、重复背景、枝节、未执行的计划和一般生活细节全部省略；不要把同一事件拆成多条，也不要复制全局时间线。剧情条目格式为“日期｜关键行为、必要因果及结果”，每条不超过64个汉字。相较旧版可保留约两倍篇幅，优先写清角色做了什么、为何重要及造成什么结果；不要删掉关键因果，也不要为凑字数扩写。
增量更新时只输出本轮有新增或实质变化的字段；旧档案中符合新规则的有效信息继续保留，事实变化时改正，重复信息合并。逐场逐人核对完毕，且所有角色都没有可归档的新增或实质变化时，才在档案部分使用一次[--档案无变化--]；不得用它跳过未检查的人物。

多人场景的归档核对步骤（仅用于整理，不输出检查过程）：
1. 按场景和事件通读本轮材料，逐一找出行动者、对话发起者、回应者、知情者和直接受影响的人。重点检查半途加入、只说一句话、未发言但承担后果，以及配角之间的互动。仅被提及的人可以列入核对，但不据此建档。
2. 对每个可确认身份的人单独核对：做了什么、知道了什么、有什么具体后果。短句若促成决定或揭示重要信息，仍属于该角色的独立贡献。仅在材料明确支持时归并全名与称谓；身份不明则不猜测。
3. 与该人物旧档案逐条比较。多个事件即使发生在同一场，也要保留各自的关键变化。同一事件可进入多份档案，每份只写该人的行为、获知或后果；不得把所有人写成主角的附属信息，也不得照抄整段时间线。
4. 输出前逐人反查：每名有符合规则的新事实的角色都有独立档案块，每个符合规则的事件都已归到对应的人。角色的出场先后、篇幅和主次地位不决定是否收录。若甲作出决定、乙提供改变决定的证据、丙因结果改变安排，应分别保留甲的决定、乙提供证据的贡献和丙承担的后果。
即使其他提示词要求保留更多字段，也必须遵守本规则。`;

const lists = new Set(['角色已知信息', '角色未知信息', '性经历人员', '额外补充', '剧情']);
const scalars = new Set(['性经历人数']);
const stat = '(?:好感(?:度|值)?|信任(?:度|值)|依赖(?:度|值)|服从(?:度|值)|忠诚(?:度|值)|堕落(?:度|值)|亲密(?:度|值)|欲望(?:度|值)|经验值|经验点|金币数|累计次数|性经历人数|与主角次数)';
const statPattern = new RegExp(stat);
const excludedContentPattern = /任务|系统|面板|状态栏|签到|抽奖|积分|奖励|兑换|提示框|功能说明|操作界面|界面文本|普通日常|日常生活|闲聊|喝咖啡/;
function conciseValue(value) {
    return String(value ?? '').split(/\r?\n/).flatMap(line => line.split(/[；;。]/)).map(part => {
        // Remove a trailing score clause while retaining the factual event before it.
        const cleaned = part.replace(new RegExp(`[,，]\\s*${stat}[^,，;；。]*`, 'g'), '').trim();
        return excludedContentPattern.test(cleaned) || (statPattern.test(cleaned) && /\d/.test(cleaned)) ? '' : cleaned;
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
