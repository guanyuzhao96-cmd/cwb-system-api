import { buildCustomFormat } from './utils.js';
import { assertProfilePlotHistory } from './profile-utils.mjs';
import { parseTimelineRecords, formatTimelineRecords } from './timeline-utils.mjs';

export const ARCHIVE_FORMAT_VERSION = 1;
export const ARCHIVE_UPGRADE_TYPES = [
    ['CWB:自动档案', '角色档案'], ['CWB:主角档案', '主角档案'],
    ['CWB:故事时间线', '时间线'], ['CWB:角色关系汇总', '角色关系'],
    ['CWB:角色档案目录', '档案目录'], ['Amily2角色总集', '角色总览'],
    ['CWB:更新状态', '更新进度'], ['CWB:更新记录', '旧版更新记录'],
    ['CWB:模块进度', '旧版模块进度'], ['CWB:世界书目录', '世界书目录'],
];

const cleanEnvelope = text => String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
const tryJson = text => {
    const value = cleanEnvelope(text);
    if (!/^[\[{]/.test(value) || /^\[(?:--|[^\]]+\]\s*[:：])/.test(value)) return null;
    try { return JSON.parse(value); } catch { return null; }
};

function profileFields(content) {
    const root = tryJson(content);
    if (root && !Array.isArray(root) && typeof root === 'object') {
        const fields = [];
        const flatten = (value, path) => {
            if (value && typeof value === 'object') {
                const pairs = Object.entries(value);
                if (!pairs.length) fields.push({ key: path, value: JSON.stringify(value) });
                else for (const [key, item] of pairs) flatten(item, path ? `${path}.${key}` : key);
            } else fields.push({ key: path, value: typeof value === 'string' ? value : JSON.stringify(value) });
        };
        flatten(root, '');
        return fields;
    }
    const fields = [];
    let current = null;
    for (const line of cleanEnvelope(content).split(/\r?\n/)) {
        if (/^\s*\[--(?:角色档案(?:开始|结束)|Amily2::CHAR_(?:START|END))--\]\s*$/.test(line)) continue;
        const match = line.match(/^\s*\[([^\]]+)\]\s*[:：]\s?(.*)$/);
        if (match) { current = { key: match[1], value: match[2] }; fields.push(current); }
        else if (current) current.value += `\n${line}`;
        else if (line.trim()) fields.push({ key: '', value: line });
    }
    return fields.map(field => ({ ...field, value: String(field.value ?? '').trim() }));
}

const PROFILE_ALIASES = {
    已知信息: '角色已知信息', known_info: '角色已知信息', known_information: '角色已知信息',
    未知信息: '角色未知信息', unknown_info: '角色未知信息', unknown_information: '角色未知信息',
    补充: '额外补充', notes: '额外补充',
    历史剧情: '剧情', plot: '剧情', history: '剧情',
};

function upgradeProfile(entry, marker) {
    const fields = profileFields(entry.content);
    const nameKeys = ['姓名', 'name', 'CI.name', 'core_identity.name'];
    const name = fields.find(field => nameKeys.includes(field.key) && field.value)?.value
        || String(entry.comment ?? '').match(/^动态[-—_：:]\s*(.+)$/)?.[1]?.trim();
    if (!name || /\r|\n/.test(name)) throw Error('无法确认角色姓名，请先核对条目姓名或“动态-姓名”标题');
    const output = { 档案类型: marker === 'CWB:主角档案' ? '主角' : '角色', 姓名: name };
    const lists = new Map(['角色已知信息', '角色未知信息', '性经历人员', '额外补充', '剧情'].map(key => [key, []]));
    let count = null;
    for (const field of fields) {
        if (nameKeys.includes(field.key) && field.value === name || ['档案类型', 'record_type'].includes(field.key)) continue;
        const base = field.key.replace(/\.\d+$/, '');
        const key = PROFILE_ALIASES[base] ?? base;
        if (!field.value) continue;
        if (lists.has(key)) lists.get(key).push(field.value);
        else if (key === '性经历人数' && count === null) count = field.value;
        else lists.get('额外补充').push(field.key ? `原字段 [${field.key}]：${field.value}` : `旧版原文：${field.value}`);
    }
    for (const key of ['角色已知信息', '角色未知信息']) if (lists.get(key).length) output[key] = lists.get(key);
    if (lists.get('性经历人员').length) output.性经历人员 = lists.get('性经历人员').join('、');
    if (count !== null) output.性经历人数 = count;
    for (const key of ['额外补充', '剧情']) if (lists.get(key).length) output[key] = lists.get(key);
    const content = buildCustomFormat(output);
    assertProfilePlotHistory(content, [entry.content]);
    return content;
}

function upgradeTimeline(content) {
    const root = tryJson(content);
    let source = content;
    if (root) {
        const rows = Array.isArray(root) ? root : root.时间线 ?? root.timeline;
        if (!Array.isArray(rows)) throw Error('时间线 JSON 缺少可识别的时间线数组');
        source = rows.map(row => {
            if (typeof row === 'string') return row;
            const event = row?.事件 ?? row?.event;
            if (typeof event !== 'string') throw Error('时间线中有无法识别的事件，原条目保留');
            const extras = Object.entries(row).filter(([key]) => !['日期', 'date', '事件', 'event', '人物', 'people', 'participants'].includes(key));
            const note = extras.length ? `；旧字段 ${JSON.stringify(Object.fromEntries(extras))}` : '';
            return `${row.日期 ?? row.date ?? '日期未知'}｜${event}${note}`;
        });
    }
    const records = parseTimelineRecords(source);
    const formatted = formatTimelineRecords(records);
    const after = new Set(parseTimelineRecords(formatted).map(row => `${row.date}｜${row.event}`));
    if (records.some(row => !after.has(`${row.date}｜${row.event}`))) throw Error('时间线转换后事件核对失败，原条目保留');
    return formatted;
}

export const LEGACY_RELATIONSHIP_NOTES = '【旧版关系补充】';

function upgradeRelationships(content) {
    const root = tryJson(content);
    const lines = [], notes = [];
    const add = value => {
        const normalized = String(value).trim().replace(/<->|⇄|⟷/g, '↔').replace(/->|⇒|⟶/g, '→');
        const match = normalized.match(/^(.+?)\s*(↔|→)\s*(.+?)\s*[:：]\s*(.+)$/);
        if (match && match[1].trim() !== match[3].trim()) lines.push(`${match[1].trim()} ${match[2]} ${match[3].trim()}：${match[4].trim()}`);
        else if (String(value).trim()) notes.push(String(value).trim());
    };
    if (root) {
        const rows = Array.isArray(root) ? root : root.关系更新 ?? root.角色关系 ?? root.relationships;
        if (!Array.isArray(rows)) throw Error('关系 JSON 缺少可识别的关系数组');
        for (const row of rows) {
            if (typeof row === 'string') { add(row); continue; }
            const a = row?.人物A ?? row?.from, b = row?.人物B ?? row?.to;
            const direction = row?.方向 ?? row?.direction, relation = row?.关系 ?? row?.relation;
            if (a && b && ['↔', '→', '->', '<->'].includes(direction) && relation) {
                add(`${a} ${direction} ${b}：${relation}`);
                const extras = Object.fromEntries(Object.entries(row).filter(([key]) => !['人物A', 'from', '人物B', 'to', '方向', 'direction', '关系', 'relation'].includes(key)));
                if (Object.keys(extras).length) notes.push(`原关系字段：${JSON.stringify(extras)}`);
            } else notes.push(JSON.stringify(row));
        }
        if (!Array.isArray(root)) {
            const extras = Object.fromEntries(Object.entries(root).filter(([key]) => !['关系更新', '角色关系', 'relationships'].includes(key)));
            if (Object.keys(extras).length) notes.push(`原关系扩展：${JSON.stringify(extras)}`);
        }
    } else {
        let inNotes = false;
        for (const line of String(content ?? '').split(/\r?\n/)) {
            if (line.trim() === LEGACY_RELATIONSHIP_NOTES) { inNotes = true; continue; }
            if (inNotes) { if (line.trim()) notes.push(line.trim()); continue; }
            if (/^\s*【(?:角色关系汇总|角色关系|人物关系)】\s*$/.test(line) || line.trim() === '（暂无已确认关系）') continue;
            add(line);
        }
    }
    return `【角色关系汇总】\n${lines.join('\n') || '（暂无已确认关系）'}${notes.length ? `\n\n${LEGACY_RELATIONSHIP_NOTES}\n${notes.join('\n')}` : ''}`;
}

function withHeader(content, header, oldHeaders) {
    let body = String(content ?? '').trim();
    const first = body.split(/\r?\n/, 1)[0];
    if ([header, ...oldHeaders].includes(first)) body = body.slice(first.length).trimStart();
    return `${header}${body ? `\n${body}` : ''}`;
}

export function upgradeArchiveContent(entry, marker, { formatProgress } = {}) {
    if (['CWB:自动档案', 'CWB:主角档案'].includes(marker)) return upgradeProfile(entry, marker);
    if (marker === 'CWB:故事时间线') return upgradeTimeline(entry.content);
    if (marker === 'CWB:角色关系汇总') return upgradeRelationships(entry.content);
    if (['CWB:更新状态', 'CWB:更新记录', 'CWB:模块进度'].includes(marker)) {
        if (!formatProgress) throw Error('缺少更新进度转换器');
        return formatProgress(entry, marker);
    }
    if (marker === 'CWB:角色档案目录') return withHeader(entry.content, '【当前角色卡档案目录】', ['【角色档案目录】']);
    if (marker === 'CWB:世界书目录') {
        const content = withHeader(entry.content, '【小故事线目录】', ['【世界书目录】', '【角色目录】']);
        return content.replace(/^(\s*)(?:姓名|name)\s*[:：]\s*["'“‘]?([^"'“”‘’\n]+?)["'“”‘’]?\s*$/gim,
            (_, space, name) => `${space}姓名: "${name.trim()}"`);
    }
    if (marker === 'Amily2角色总集') return withHeader(entry.content, '【角色总览】', ['【登场角色】']);
    throw Error('未知资料类型，原条目保留');
}
