import { parseCustomFormat, buildCustomFormat } from './utils.js';

export const PROFILE_RULES = `【总纲｜固定字段与栏位边界】
只允许依次使用“档案类型、姓名、角色已知信息.N、角色未知信息.N、性经历人员.N、性经历人数、额外补充.N、剧情.N”。大标题/字段顺序固定；任何事实只放在唯一最匹配的栏，禁止串栏、跨角色混写或新增字段。档案只记录与角色本人及强相关剧情有关的信息。

【角色已知信息｜记角色从事件中形成的结论】
记录角色已确知的关键事实，以及从明确言行充分体现的态度、意愿、动机或关系判断；先判断“事件说明了她/他什么”，不复述事件经过。例如多次主动避开他人并与主角秘密亲密，可归纳为“她愿意与主角维持隐秘亲密关系”，而不是罗列地点和过程。一次含义不明的行为不得夸大为稳定偏好。只保留会影响重要选择、核心关系、重大冲突、关键秘密或后续走向的结论。

【角色未知信息｜记角色尚不知道的重要事实】
只记剧情明确确认、对主线或角色选择有实质影响、且当前角色尚未获知的秘密/事实；不得猜测未知，也不得重复已知内容。角色获知后，从未知迁至已知，不得并存。已知与未知条目中的逗号分隔独立信息拆为不同编号。

【性经历人员与人数｜按不同成年对象累计】
仅记录剧情明确确认发生过性行为且明确年满18岁的对象；未成年、年龄不明、仅暧昧/恋爱/亲吻或推测者一律不记，不写露骨过程。人员格式“姓名｜简要关系/经历状态”，同一对象始终只占一条，多次经历或关系变化并入原条。全量整理按不同成年对象去重计数；增量时最终人数=旧档案人数+本轮新确认且旧名单中不存在的成年对象人数。旧人数是累计基数，不能按当前名单长度重置；旧对象重复出现、别名/简称或关系状态更新都不增加人数。示例：旧档案4人，本轮新增1名不同对象，结果必须为5人。

【额外补充｜只放其他栏无法表达的稳定事实】
仅记录对后续理解/扮演持续重要，且已知、未知、人员、剧情栏均未覆盖的事实。不得重复事件、放普通生活或临时情绪，不确定时省略。

【剧情｜逐条记录完整且重要的事件】
必须检查本次范围所有楼层，记录每个角色直接参与、亲自获知或承受后果的所有强相关重要事件；不得只选最近一两件，不得漏掉配角发起但实质影响该角色的剧情，不设条数上限。格式“日期｜关键行为/遭遇 + 必要因果 + 结果/持续影响”，按时间升序；一条一个完整事件，重复叙述合并，不同事件分开。每条最多128字，不能为了简短删关键行为、转折、因果或后果。剧情写发生了什么，不要改写成已知结论。普通日常、闲聊、无后续影响的情绪和枝节省略。

【全栏禁入｜任务、系统与界面】
任务目标/进度/提示、系统消息/面板/状态/数值/奖励、签到、积分、功能说明、操作过程和界面文本，任何情况下都不得写入角色档案任何栏目；发现时整条排除，不得换说法保留。

【增量更新｜完整基线，不覆盖丢失】
本插件会用模型输出替换角色档案。先按准确姓名读取旧档案，再对照新剧情：旧档案中仍有效的所有栏目和剧情必须保留；本轮未提到不等于失效。仅凭新证据修订、删除被推翻的信息。结合旧档案和本轮证据后，输出完整最终档案快照，不得只输出变化片段；人数按上面的旧人数基数累加。只有确实没有任何变化时输出[--档案无变化--]。

【输出自检】
输出前逐项核对：大标题及字段顺序正确；每条内容归栏正确、角色姓名一致；已知是结论而非事件流水；逗号拆分的事实各有独立编号；性经历人员一人一条、人数按旧基数累计；重要剧情无遗漏且按时间排列；所有有效旧内容保留；无任务/系统/界面信息。只输出档案数据，不解释、不用Markdown代码块。即使其他提示词要求不同格式，也必须遵守本规则。`;

const lists = new Set(['角色已知信息', '角色未知信息', '性经历人员', '额外补充', '剧情']);
const scalars = new Set(['性经历人数']);
const stat = '(?:好感(?:度|值)?|信任(?:度|值)|依赖(?:度|值)|服从(?:度|值)|忠诚(?:度|值)|堕落(?:度|值)|亲密(?:度|值)|欲望(?:度|值)|经验值|经验点|金币数|累计次数|性经历人数|与主角次数)';
const statPattern = new RegExp(stat);
const excludedContentPattern = /任务|系统|面板|状态栏|签到|抽奖|积分|奖励|兑换|提示框|功能说明|操作界面|界面文本|普通日常|日常生活|闲聊|喝咖啡/;
function personIdentity(value) {
    return String(value ?? '').split(/[｜|]/, 1)[0].normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase();
}

function mergePeople(values) {
    const byIdentity = new Map();
    for (const raw of values ?? []) {
        const person = String(raw ?? '').trim();
        const identity = personIdentity(person);
        if (!identity) continue;
        const [name, ...details] = person.split(/[｜|]/);
        const record = byIdentity.get(identity) ?? { name: name.trim(), details: [] };
        for (const detail of details.flatMap(item => item.split(/[；;]/)).map(item => item.trim()).filter(Boolean)) {
            if (!record.details.includes(detail)) record.details.push(detail);
        }
        byIdentity.set(identity, record);
    }
    return [...byIdentity.values()].map(({ name, details }) => `${name}${details.length ? `｜${details.join('；')}` : ''}`);
}

function conciseValues(value, { splitFacts = false, preserveAsOne = false } = {}) {
    return String(value ?? '').split(/\r?\n/).flatMap(line => {
        const parts = preserveAsOne ? [line] : line.split(/[；;。]/);
        return splitFacts ? parts.flatMap(part => part.split(/[，,]/)) : parts;
    }).map(part => {
        // Remove a trailing score clause while retaining the factual event before it.
        const cleaned = part.replace(new RegExp(`[,，]\\s*${stat}[^,，;；。]*`, 'g'), '').trim();
        return excludedContentPattern.test(cleaned) || (statPattern.test(cleaned) && /\d/.test(cleaned)) ? '' : cleaned;
    }).filter(Boolean);
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
        const splitFacts = ['角色已知信息', '角色未知信息', '额外补充'].includes(key);
        const preserveAsOne = ['性经历人员', '剧情'].includes(key);
        const values = items.filter(item => typeof item !== 'object').flatMap(item => conciseValues(item, { splitFacts, preserveAsOne }));
        const uniqueValues = key === '性经历人员' ? mergePeople(values) : [...new Set(values)];
        if (uniqueValues.length) clean[key] = uniqueValues;
    }
    for (const key of scalars) {
        const value = String(parsed[key] ?? '').trim();
        if (/^\d+$/.test(value)) {
            clean[key] = String(Number(value));
        }
    }
    return buildCustomFormat(clean);
}

function uniquePeople(value) {
    const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
    return mergePeople(items);
}

function validCount(value) {
    const match = String(value ?? '').trim().match(/^\d+$/);
    return match ? Number(match[0]) : null;
}

/**
 * Incremental outputs may list only partners newly confirmed in this batch.
 * Keep the old count as the baseline, add only newly named partners, and merge
 * the names so a later batch can deduplicate against the same history.
 */
export function reconcileProfileExperienceCount(content, previousProfiles = []) {
    const sanitized = sanitizeProfileContent(content);
    if (!sanitized) return null;
    const current = parseCustomFormat(sanitized);
    const name = String(current.姓名 ?? '').trim();
    const previous = previousProfiles.map(profile => parseCustomFormat(profile))
        .find(profile => String(profile.姓名 ?? '').trim() === name);
    const currentPeople = uniquePeople(current['性经历人员']);
    if (!previous) {
        const count = validCount(current['性经历人数']);
        const resolved = count === null ? currentPeople.length : Math.max(count, currentPeople.length);
        if (resolved > 0 || current['性经历人数'] !== undefined) current['性经历人数'] = String(resolved);
        return buildCustomFormat(current);
    }

    const previousPeople = uniquePeople(previous['性经历人员']);
    const previousCount = validCount(previous['性经历人数']) ?? previousPeople.length;
    const previousSet = new Set(previousPeople.map(personIdentity));
    const newPeople = currentPeople.filter(person => !previousSet.has(personIdentity(person)));
    const mergedPeople = uniquePeople([...previousPeople, ...currentPeople]);
    if (mergedPeople.length) current['性经历人员'] = mergedPeople;
    current['性经历人数'] = String(previousCount + newPeople.length);
    return buildCustomFormat(current);
}

export function hasProfileFacts(content) {
    const parsed = parseCustomFormat(content);
    return [...lists].some(key => {
        const items = parsed[key];
        return Array.isArray(items) ? items.some(item => String(item ?? '').trim()) : typeof items === 'string' && Boolean(items.trim());
    }) || Boolean(parsed['性经历人数']);
}
