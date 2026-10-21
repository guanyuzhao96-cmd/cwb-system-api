const DATE_PATTERN = /^(\d{4}(?:[-./]\d{1,2}[-./]\d{1,2}|年\d{1,2}月\d{1,2}日))(?:[ T].*)?$/;

function recordKey(record) { return `${record.date}｜${record.event}`; }

function normalizeDate(date) {
    const match = String(date).match(/^(\d{4})(?:[-./]|年)(\d{1,2})(?:[-./]|月)(\d{1,2})日?$/);
    return match ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}` : date;
}

export function parseTimelineRecords(contents) {
    const lines = (Array.isArray(contents) ? contents : [contents])
        .flatMap(content => String(content ?? '').split(/\r?\n/));
    const records = [];
    let currentDate = null;
    const add = (date, event, splitLegacy = true) => {
        const parts = splitLegacy ? event.split(/[；;]/) : [event];
        for (const value of parts.map(item => item.trim()).filter(Boolean)) records.push({ date, event: value });
    };

    for (const raw of lines) {
        let line = String(raw).replace(/^\s*\[时间线(?:\.\d+)?\]\s*[:：]\s*/, '').trim().replace(/\s*[|]\s*/g, '｜');
        if (!line || /^【(?:时间线(?:增量|楼层)?|故事时间线|主线时间线)(?:】|[:：])/.test(line)
            || /^===\s*(?:时间线增量|时间线增量结束)\s*===$/.test(line)
            || line === '（本范围已检查，无新增重要事件）' || line === '（暂无重要事件）') continue;

        const grouped = line.match(/^「(\d{4}\.\d{1,2}\.\d{1,2}|日期未知)」\s*(?:\d+[.、]\s*)?(.*)$/);
        if (grouped) {
            currentDate = normalizeDate(grouped[1]);
            if (grouped[2] && !/^【(?:时间线增量|时间线|主线时间线)】$/.test(grouped[2])) add(currentDate, grouped[2], false);
            continue;
        }
        const continuation = line.match(/^(?:↳|└|├|[-*•]|\d+[.、])\s*(.+)$/);
        if (continuation && currentDate) {
            add(currentDate, continuation[1], false);
            continue;
        }

        const fields = line.split('｜').map(field => field.trim());
        const dateMatch = fields[0]?.match(DATE_PATTERN);
        const date = dateMatch ? normalizeDate(dateMatch[1]) : (fields[0] === '日期未知' ? '日期未知' : null);
        if (!date || fields.length < 2) {
            if (line) add('日期未知', line, false);
            currentDate = date;
            continue;
        }
        currentDate = date;
        // Legacy rows used date｜people｜event. The standalone people column is discarded.
        const event = (fields.length >= 3 ? fields.slice(2) : fields.slice(1)).join('｜').trim();
        if (event) add(date, event);
    }

    const seen = new Set();
    return records.filter(record => {
        const key = recordKey(record);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export function formatTimelineRecords(records, { header = '【主线时间线】', empty = '（暂无重要事件）' } = {}) {
    const groups = new Map();
    for (const record of records ?? []) {
        const date = normalizeDate(String(record?.date ?? '日期未知').trim() || '日期未知');
        const event = String(record?.event ?? '').trim();
        if (!event) continue;
        const events = groups.get(date) ?? [];
        if (!events.includes(event)) events.push(event);
        groups.set(date, events);
    }
    const sorted = [...groups].sort(([a], [b]) => a === '日期未知' ? 1 : b === '日期未知' ? -1 : a.localeCompare(b, 'zh-CN'));
    const lines = [];
    for (const [date, events] of sorted) {
        const label = `「${date === '日期未知' ? date : date.split('-').map(Number).join('.')}」`;
        events.forEach((event, eventIndex) => {
            lines.push(`${eventIndex === 0 ? label + ' ' : ' '.repeat(label.length + 1)}${eventIndex + 1}.${event}`);
        });
    }
    return `${header}\n${lines.length ? lines.join('\n') : empty}`;
}

export function compactTimelineContext(contents, { maxChars = 3200, firstCount = 4, recentCount = 24 } = {}) {
    const records = parseTimelineRecords(contents);
    if (!records.length) return '无';
    const selected = records.length <= firstCount + recentCount
        ? records
        : [...records.slice(0, firstCount), ...records.slice(-recentCount)];
    const unique = [];
    const seen = new Set();
    for (const record of selected) {
        const key = recordKey(record);
        if (!seen.has(key)) { seen.add(key); unique.push(record); }
    }
    const omitted = Math.max(0, records.length - unique.length);
    const note = omitted ? `【时间线节选；另有 ${omitted} 条旧事件保存在插件中，未在本次重复发送】\n` : '';
    let formatted = formatTimelineRecords(unique, { header: '', empty: '' }).trim();
    const budget = Math.max(500, maxChars - note.length);
    if (formatted.length > budget) {
        const lines = formatted.split('\n');
        const kept = [];
        for (let index = lines.length - 1; index >= 0; index--) {
            const candidate = [lines[index], ...kept].join('\n');
            if (candidate.length > budget && kept.length) break;
            if (candidate.length > budget) { kept.unshift(lines[index].slice(-budget)); break; }
            kept.unshift(lines[index]);
        }
        formatted = kept.join('\n');
    }
    return `${note}${formatted}`;
}
