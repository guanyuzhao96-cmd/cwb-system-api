export function namesFromDirectory(content) {
    const text = String(content ?? '')
        .replace(/<\s*br\s*\/?>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&amp;/gi, '&');
    const names = new Set();
    for (const match of text.matchAll(/(?:^|\n)\s*(?:姓名|name)\s*[:：]\s*["'“‘]?\s*([^"'“”‘’\n]+?)\s*["'“”‘’]?\s*(?:\n|$)/gim)) {
        const name = match[1].trim();
        if (name) names.add(name);
    }
    return [...names];
}

export function likelyPersonName(value) {
    const name = String(value ?? '').trim()
        .replace(/^["'“‘【\[]+|["'”’】\]]+$/g, '')
        .replace(/^(?:动态|角色档案|人物档案|角色)[-—_｜:： ]+/u, '')
        .trim();
    const lower = name.toLocaleLowerCase();
    const ignored = new Set([
        '姓名', '名字', '角色名', '人物姓名', '角色', '人物', '角色档案', '人物档案', '好感度', '好感', '性经历人数',
        '角色关系', '人物关系', '关系', '剧情', '时间线', '故事时间线', '世界书目录', '主角档案', '主角关系',
        '目标', '长期目标', '短期目标', '动态', '档案', '设定', '简介', '背景', '状态', '信息', '关键词', '目录',
        'name', 'names', 'character', 'characters', 'role', 'roles', 'rule', 'rules', 'prompt', 'template', 'format',
        'instruction', 'instructions', 'system', 'worldbook', 'timeline', 'profile', 'setting', 'lore', 'story',
        'plot', 'chapter', 'index', 'summary', 'guide', 'guideline', 'output', 'relation', 'relationship',
        'goal', 'status', 'age', 'gender', 'profession', 'date', 'event', 'item', 'ability', 'skill', 'keyword',
        'directory', 'entry', 'main', 'side', 'background', 'attribute', 'value',
    ]);
    const ruleTerms = /规则|条例|说明|指令|提示词?|模板|格式|协议|世界书|检索|索引|档案|剧情|时间线|前情|主线|支线|设定|背景|人物|角色|职业|性格|关系|目标|能力|技能|属性|数值|好感|状态|更新|生成|总结|章节|楼层|关键词|触发|禁止|必须|不要|应该|规范|要求|输出|系统|用户|助手|旁白|场景|地点|组织|势力|事件|目录|清单|列表|机制|功能|模块|说明书|校园|学校|学院|大学|专业|班级|年级|学生会|学生|社团|寝室|教室|家族|公司|部门|城市|地区|地图|任务|奖励|物品|道具|装备|分类|类型|模式|流程|步骤|要点|原则|须知|条款|学姐|学长|学妹|学弟|老师|教授|同学|班长|室友|助理|秘书|女友|男友|妻子|丈夫|母亲|父亲|姐姐|妹妹|哥哥|弟弟|小姐|先生|太太|老板|经理|医生|护士|警察|记者|校花|校草|前台|店员|管理员/iu;
    const genericLatinWord = lower.split(/[ '-]/).some(word => ignored.has(word));
    if (!name || name.length > 24 || ignored.has(name) || ignored.has(lower) || ruleTerms.test(name)
        || genericLatinWord || /^CWB:/i.test(name) || /^\d+-\d+$/.test(name)) return null;

    const chineseName = /^[\p{Script=Han}·]{2,5}$/u.test(name);
    const latinName = /^[A-Z][a-z]{1,19}(?:[ '-][A-Z][a-z]{1,19}){0,2}$/.test(name);
    return chineseName || latinName ? name : null;
}

const keysOf = entry => Array.isArray(entry?.key) ? entry.key : (Array.isArray(entry?.keys) ? entry.keys : []);
const enabled = entry => entry?.enabled !== false && entry?.disable !== true;
const supportKeys = new Set([
    'CWB:世界书目录', 'CWB:主角档案', 'CWB:故事时间线', 'CWB:角色档案目录', 'CWB:主角关系', 'Amily2角色总集',
]);

export function namesFromRoleEntries(entries) {
    const occurrences = new Map();
    for (const entry of entries) {
        if (!enabled(entry) || keysOf(entry).some(key => supportKeys.has(String(key)))) continue;
        const entryNames = new Set();
        const title = entry.comment ?? entry.title ?? entry.name;
        const titleName = likelyPersonName(title);
        if (titleName) entryNames.add(titleName);
        for (const key of keysOf(entry)) {
            const name = likelyPersonName(key);
            if (name) entryNames.add(name);
        }
        for (const name of entryNames) {
            if (!occurrences.has(name)) occurrences.set(name, []);
            occurrences.get(name).push({ comment: String(entry.comment ?? entry.title ?? '（无标题）') });
        }
    }
    return occurrences;
}

export function directoryContent(names) {
    return `【小故事线目录】\n${names.length ? names.map(name => `姓名: "${name}"`).join('\n') : '（暂无可自动识别的角色）'}`;
}

export function duplicateLines(duplicates) {
    return [...duplicates.entries()]
        .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))
        .map(([name, entries]) => {
            const byBook = new Map();
            for (const item of entries) {
                if (!byBook.has(item.bookName)) byBook.set(item.bookName, []);
                byBook.get(item.bookName).push(item.comment);
            }
            const details = [...byBook.entries()].sort(([a], [b]) => a.localeCompare(b, 'zh-CN'))
                .map(([book, titles]) => {
                    const uniqueTitles = [...new Set(titles.filter(Boolean))];
                    return `${book}${titles.length > 1 ? `（${titles.length}个条目${uniqueTitles.length ? `：${uniqueTitles.join('、')}` : ''}）` : ''}`;
                });
            return `${name}：${details.join('、')}`;
        });
}

export function findRoutedBook(routes, characterName) {
    const normalizedName = String(characterName ?? '').trim().toLocaleLowerCase();
    if (!normalizedName) return null;
    const candidates = Object.entries(routes ?? {}).filter(([, route]) =>
        (route.names ?? []).some(name => String(name).trim().toLocaleLowerCase() === normalizedName));
    if (!candidates.length) return null;
    return (candidates.find(([, route]) => route.primary) || candidates[0])[0];
}
