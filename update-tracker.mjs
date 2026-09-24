export function parseTaggedRanges(keys, tagPrefix) {
    const escaped = tagPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${escaped}(\\d+)-(\\d+)$`);
    return (keys ?? []).flatMap(key => {
        const match = String(key).match(pattern);
        return match ? [[Number(match[1]), Number(match[2])]] : [];
    });
}

export function mergeRanges(ranges) {
    const sorted = (ranges ?? [])
        .map(([start, end]) => [Math.min(Number(start), Number(end)), Math.max(Number(start), Number(end))])
        .filter(([start, end]) => Number.isInteger(start) && Number.isInteger(end) && start >= 0)
        .sort(([a], [b]) => a - b);
    const merged = [];
    for (const range of sorted) {
        const last = merged.at(-1);
        if (!last || range[0] > last[1] + 1) merged.push([...range]);
        else last[1] = Math.max(last[1], range[1]);
    }
    return merged;
}

export function overlappingRanges(start, end, knownRanges) {
    const low = Math.min(Number(start), Number(end));
    const high = Math.max(Number(start), Number(end));
    return mergeRanges((knownRanges ?? []).flatMap(([a, b]) => {
        const overlapStart = Math.max(low, a);
        const overlapEnd = Math.min(high, b);
        return overlapStart <= overlapEnd ? [[overlapStart, overlapEnd]] : [];
    }));
}

export function missingRanges(totalMessages, knownRanges, startIndex = 0) {
    const lastIndex = Math.max(-1, Number(totalMessages) - 1);
    if (lastIndex < 0) return [];
    const missing = [];
    let next = Math.max(0, Number(startIndex) || 0);
    if (next > lastIndex) return [];
    for (const [start, end] of mergeRanges(knownRanges)) {
        if (end < next) continue;
        if (start > lastIndex) break;
        if (start > next) missing.push([next, Math.min(lastIndex, start - 1)]);
        next = Math.max(next, end + 1);
        if (next > lastIndex) break;
    }
    if (next <= lastIndex) missing.push([next, lastIndex]);
    return missing;
}

export function formatRanges(ranges) {
    return mergeRanges(ranges).map(([start, end]) => `${start}-${end}`).join('、') || '无';
}

export function updateTrackerContent({ completedRanges, duplicateRanges, totalMessages, trackingStartIndex = 0, latest }) {
    const preTrackingCover = trackingStartIndex > 0 ? [[0, trackingStartIndex - 1]] : [];
    return [
        '【全聊天总结记录】',
        '楼层编号：聊天消息索引，从0开始；区间两端均包含。',
        `已总结：${formatRanges(completedRanges)}`,
        `重复总结：${formatRanges(duplicateRanges)}`,
        `追踪前未核实：${formatRanges(preTrackingCover)}`,
        `追踪后未总结：${formatRanges(missingRanges(totalMessages, [...completedRanges, ...preTrackingCover], trackingStartIndex))}`,
        `最近一次：${latest || '暂无'}`,
    ].join('\n');
}
