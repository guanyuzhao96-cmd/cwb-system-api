export function notify(type, message) {
    const toast = window.toastr;
    if (toast?.[type]) toast[type](message, '角色世界书');
    else console[type === 'error' ? 'error' : 'log'](`[CWB] ${message}`);
}

export function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

export function parseCustomFormat(text) {
    const output = {};
    const lines = String(text ?? '')
        .replace('[--Amily2::CHAR_START--]', '')
        .replace('[--Amily2::CHAR_END--]', '')
        .split(/\r?\n/);

    for (const line of lines) {
        const match = line.match(/^\[([^\]]+)]\s*:\s*(.*)$/);
        if (!match) continue;
        const path = match[1].split('.');
        let cursor = output;
        for (let index = 0; index < path.length - 1; index++) {
            const part = path[index];
            const nextIsArray = /^\d+$/.test(path[index + 1]);
            if (/^\d+$/.test(part)) {
                const arrayIndex = Number(part);
                if (!Array.isArray(cursor)) break;
                cursor[arrayIndex] ??= nextIsArray ? [] : {};
                cursor = cursor[arrayIndex];
            } else {
                cursor[part] ??= nextIsArray ? [] : {};
                cursor = cursor[part];
            }
        }
        const leaf = path.at(-1);
        if (/^\d+$/.test(leaf) && Array.isArray(cursor)) cursor[Number(leaf)] = match[2];
        else cursor[leaf] = match[2];
    }
    return output;
}

function flatten(value, prefix, lines) {
    if (Array.isArray(value)) {
        value.forEach((item, index) => flatten(item, `${prefix}.${index}`, lines));
        return;
    }
    if (value && typeof value === 'object') {
        Object.entries(value).forEach(([key, item]) => flatten(item, prefix ? `${prefix}.${key}` : key, lines));
        return;
    }
    if (prefix) lines.push(`[${prefix}]:${value ?? ''}`);
}

export function buildCustomFormat(data) {
    const lines = [];
    flatten(data, '', lines);
    return `[--Amily2::CHAR_START--]\n${lines.join('\n')}\n[--Amily2::CHAR_END--]`;
}

export function extractCharacterBlocks(text) {
    return [...String(text ?? '').matchAll(/\[--Amily2::CHAR_START--][\s\S]*?\[--Amily2::CHAR_END--]/g)]
        .map(match => match[0].trim());
}

export function sanitizeName(name) {
    return String(name ?? '').trim().replace(/[^a-zA-Z0-9\u3400-\u9fff·“”"_-]/g, ',');
}
