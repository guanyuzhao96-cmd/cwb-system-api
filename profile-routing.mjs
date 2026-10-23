const normalized = value => String(value ?? '').trim().toLocaleLowerCase();

export function directoryTarget(routes, name, centralBook = null) {
    const matches = Object.entries(routes).filter(([book, route]) => book !== centralBook
        && (route.names ?? []).some(candidate => normalized(candidate) === normalized(name)));
    if (!matches.length) throw Error(`角色 ${name} 未匹配到世界书目录，未写入主世界书；请扫描目录或一键整理。`);
    if (matches.length > 1) throw Error(`角色 ${name} 同时出现在多个世界书目录（${matches.map(([book]) => book).join('、')}），原档案保留，请先消除同名目录冲突。`);
    return matches[0][0];
}

// Ignore UID and object key order, but preserve all other host/extension fields.
export function profilePayload(entry) {
    const canonical = value => Array.isArray(value) ? value.map(canonical)
        : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => [key, canonical(value[key])])) : value;
    const { uid, ...payload } = entry;
    return JSON.stringify(canonical(payload));
}
