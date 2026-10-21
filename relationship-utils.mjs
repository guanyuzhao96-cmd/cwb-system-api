import { LEGACY_RELATIONSHIP_NOTES } from './archive-upgrade.mjs';

export const RELATIONSHIP_PROMPT = `你是角色关系增量整理器，只根据已有关系与新增聊天中已确认的事实更新，不续写，不推测。输出涉及角色之间的关系，包含同学、亲属、朋友、情侣、敌对、单向暗恋、信任或隐瞒等关键关系，每条尽量15字内。双向用↔，单向用→。相同人物的关系变化应替换原关系；例如“同班同学、情侣”变为“同班同学、已分手”。不要记录日常动作或数值。只输出本次变化，未变化关系不重复输出，插件会保留旧关系。
严格输出JSON：{"关系更新":[{"人物A":"A","方向":"↔或→","人物B":"B","关系":"同班同学、情侣"}],"删除关系":[]}。删除关系仅用于明确作废的旧关系，每项使用同样的人物A、方向、人物B字段；关系变化优先更新，不删除历史关系依据。无变化时两个数组均为空。`;

export function relationKey(item) {
    const a = String(item?.人物A ?? '').trim();
    const b = String(item?.人物B ?? '').trim();
    const direction = item?.方向 === '→' ? '→' : '↔';
    if (!a || !b || a === b) throw new Error('关系记录的人物姓名不合法。');
    return JSON.stringify(direction === '↔' ? [direction, ...[a, b].sort()] : [direction, a, b]);
}

function normalizeRelationship(item, deleting = false) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw Error('关系记录必须是含双方姓名的对象');
    const pick = keys => {
        const values = keys.filter(key => Object.hasOwn(item, key)).map(key => item[key]);
        if (values.some(value => JSON.stringify(value) !== JSON.stringify(values[0]))) throw Error('关系记录的同义字段冲突，未保存');
        return values[0];
    };
    const person = value => typeof value === 'string' ? value.trim()
        : value && typeof value === 'object' && !Array.isArray(value) && typeof (value.姓名 ?? value.name) === 'string' ? String(value.姓名 ?? value.name).trim() : '';
    const a = person(pick(['人物A', '人物a', '角色A', '角色a', 'personA', 'source', 'from']));
    const b = person(pick(['人物B', '人物b', '角色B', '角色b', 'personB', 'target', 'to']));
    if (!a || !b || a === b) throw Error(`关系记录的人物姓名不合法（${!a ? '缺人物A' : !b ? '缺人物B' : '双方为同一人'}）`);
    const direction = pick(['方向', 'direction']) ?? '↔';
    const mappedDirection = new Map([['↔', '↔'], ['<->', '↔'], ['双向', '↔'], ['→', '→'], ['->', '→'], ['单向', '→']]).get(direction);
    if (!mappedDirection) throw Error('关系方向无法识别，未保存');
    const relation = pick(['关系', 'relationship', 'relation']);
    if (!deleting && (typeof relation !== 'string' || !relation.trim())) throw Error('关系描述为空或类型无效，未保存');
    return { 人物A: a, 人物B: b, 方向: mappedDirection, 关系: relation ?? '' };
}

export function parseRelationshipSummary(content) {
    return String(content ?? '').split(LEGACY_RELATIONSHIP_NOTES)[0].split(/\r?\n/).flatMap(line => {
        const match = line.match(/^(.+?)\s*(↔|→)\s*(.+?)\s*[:：]\s*(.+)$/);
        return match ? [{ 人物A: match[1].trim(), 方向: match[2], 人物B: match[3].trim(), 关系: match[4].trim() }] : [];
    });
}

export function mergeRelationships(previous, response) {
    const clean = String(response).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let parsed;
    try { parsed = JSON.parse(clean); } catch { throw new Error('关系 API 未返回合法 JSON，原关系保持不变。'); }
    if (!Array.isArray(parsed?.关系更新) || (parsed.删除关系 !== undefined && !Array.isArray(parsed.删除关系))) throw new Error('关系 API 缺少“关系更新”数组，原关系保持不变。');
    const records = new Map(parseRelationshipSummary(previous).map(item => [relationKey(item), item]));
    for (const item of (parsed.删除关系 ?? []).map(item => normalizeRelationship(item, true))) records.delete(relationKey(item));
    for (const item of parsed.关系更新.map(item => normalizeRelationship(item))) {
        const key = relationKey(item);
        const relation = String(item.关系 ?? '').trim().replace(/\s*\n\s*/g, '；');
        if (!relation) throw new Error('关系描述为空，原关系保持不变。');
        records.set(key, { 人物A: String(item.人物A).trim(), 方向: item.方向 === '→' ? '→' : '↔', 人物B: String(item.人物B).trim(), 关系: relation });
    }
    const notesIndex = String(previous ?? '').indexOf(LEGACY_RELATIONSHIP_NOTES);
    const notes = notesIndex >= 0 ? `\n\n${String(previous).slice(notesIndex).trim()}` : '';
    return '【角色关系汇总】\n' + ([...records.values()].map(item => `${item.人物A} ${item.方向} ${item.人物B}：${item.关系}`).join('\n') || '（暂无已确认关系）') + notes;
}
