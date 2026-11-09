import { parseCustomFormat, buildCustomFormat } from './utils.js';

export const PROFILE_RULES = `角色与主角档案只允许“档案类型”“姓名”“角色已知信息.N”“角色未知信息.N”“性经历人员.N”“性经历人数”“额外补充.N”和“剧情.N”字段，其他字段一律删除，不记录状态、目标、物品、能力、关系、好感或无关数值。
“角色已知信息”与“角色未知信息”记录的是会影响角色后续判断的信息差，都必须与主线或该角色的个人剧情线强相关。每条写成可以单独理解的事实，不按时间复述它是怎么发生的。
已知信息：角色确实掌握、以后仍会用到的事实，例如约定、重要证据或他人明确告知的情况。仅仅到场或与人交谈，不等于知道对方的隐情。只听到未经证实的说法时，如有必要，记录“听到某人声称……”，不把传言写成事实。
未知信息：剧情已经确认、但材料明确表明该角色尚未获知，且会影响其下一步选择的事实。只记录与此人有关的信息差，不能因为没有写他在场就推定他不知道。角色获知后，把同一事实从未知移到已知；没有证据就留空。
三栏按内容分工：已知／未知写“掌握或尚未掌握的事实”，剧情写“角色做出的关键决定、实际经历的转折及后果”。单纯听说或得知一件事放在信息栏；若它进一步引发独立的决定或后果，剧情只记这一步变化。不要把同一个事实换种说法重复写入多个字段。普通日常、一般对话、临时情绪、无后续影响的细节、单纯被提及的信息，即使真实也不记录。
“性经历人员”只记录剧情明确确认已发生性行为的成年对象姓名；仅在对象明确为18岁以上时记录，未成年或年龄不明一律省略。不得依据暧昧、恋爱、亲吻或推测补全经历，不写露骨过程。“性经历人数”按已确认成年对象去重计数，必须与名单一致；不明时省略，只有明确确认没有经历时才写0，不把次数当人数。
“额外补充”只记录会影响后续理解或角色塑造、且其他字段未覆盖的重要事实；必须与剧情强相关，不得记录普通生活细节或重复已知、未知、剧情内容。
个人关键剧情只保留该角色亲自做出、经历或直接承受的关键转折，且强力推动或改变主线，或实质改变该角色个人剧情的走向。优先留存重大决定、冲突结果、兑现或打破的重要承诺，以及持续影响下一步的后果。只被提名、在场却没有独立贡献或后果、只是知悉一项事实，都不记为个人剧情。判断标准是删掉这条后，是否会影响对角色后来为何改变做法或处境的理解。
角色档案严禁记录任何任务或系统相关内容，包括任务目标/进度/提示、系统消息/提示/面板/状态/数值/奖励、签到、积分、功能说明、操作过程及界面文本；即使角色亲自经历、内容会影响数值或在剧情中出现，也不得写入任何字段。发现这类内容时整条删除，不要改写后保留。
日常互动、普通对话、行动步骤、情绪变化、重复背景、枝节、未执行的计划和一般生活细节全部省略；不要把同一事件拆成多条，也不要复制全局时间线。剧情条目格式为“日期｜关键行为、必要因果及结果”，每条不超过64个汉字。将同一转折的起因、决定和结果合为一条，保留影响后续的必要因果。仅有一场对话不要求产出一条剧情，也不因多人出场而逐人抄录经过。
增量更新时只为本轮有新增或实质变化的角色输出档案块。每个输出块都是该角色合并后的完整档案，保留旧档案仍有效的内容，按证据更正变化的事实，合并重复项。逐场逐人核对完毕，且所有角色都没有可归档的新增或实质变化时，才在档案部分使用一次[--档案无变化--]；不得用它跳过未检查的人物。

多人场景的归档核对步骤（仅用于整理，不输出检查过程）：
1. 按场景和事件通读本轮材料，逐一找出行动者、对话发起者、回应者、知情者和直接受影响的人。重点检查半途加入、只说一句话、未发言但承担后果，以及配角之间的互动。仅被提及的人可以列入核对，但不据此建档。
2. 对每个可确认身份的人单独分类：新增掌握的事实、仍未掌握的确证事实、本人经历的关键转折。短句可以是关键信息，但只有引发独立行动或实质后果才进入剧情。仅在材料明确支持时归并全名与称谓；身份不明则不猜测。
3. 对照该人物旧档案，检查信息是否已记录、是否需要从未知移到已知、剧情是否已覆盖同一转折。把同一转折的连续步骤合并，独立转折才分条。共同事件只有对某人产生独立关键变化，才进入该人的剧情。
4. 输出前逐人反查：有符合条件的新事实或关键转折的人均已覆盖，各字段没有复述。某人只新增一项已知或未知事实，就只在相应信息栏加入这项事实，保留其余仍有效的内容；某人只是旁听且无可归档的信息或后果，就省略其档案块。没有内容的字段留空。
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
