import { mergeRanges, missingRanges } from './update-tracker.mjs';
export const MODULE_LABELS = { profiles: '角色与主角档案', timeline: '主线时间线', relationships: '角色关系' };
export function removeRange(ranges, start, end) {
    return mergeRanges((ranges ?? []).flatMap(([a, b]) => b < start || a > end ? [[a, b]] : [[a, start - 1], [end + 1, b]].filter(([x, y]) => x <= y)));
}
export function applyModuleResult(progress, module, start, end, error = null) {
    if (!MODULE_LABELS[module]) throw Error('未知更新模块');
    const next = structuredClone(progress ?? {});
    const old = next[module] ?? { completed: [], failed: [] };
    next[module] = {
        completed: error ? removeRange(old.completed, start, end) : mergeRanges([...(old.completed ?? []), [start, end]]),
        failed: error ? mergeRanges([...(old.failed ?? []), [start, end]]) : removeRange(old.failed, start, end),
        latest: { start, end, error: error ? String(error) : null, time: new Date().toISOString() },
    };
    return next;
}
export function mergeModuleProgress(saved, legacy) {
    const merged = structuredClone(saved ?? {});
    for (const module of Object.keys(MODULE_LABELS)) {
        const current = merged[module] ?? {};
        const fallback = legacy?.[module] ?? {};
        const failed = mergeRanges(current.failed ?? []);
        const completed = mergeRanges([...(fallback.completed ?? []), ...(current.completed ?? [])]);
        // An explicit failure in the newer record must override older success for that range.
        merged[module] = {
            ...fallback,
            ...current,
            completed: failed.reduce((ranges, [start, end]) => removeRange(ranges, start, end), completed),
            failed,
            latest: current.latest ?? fallback.latest,
        };
    }
    return merged;
}
export function moduleStatus(progress, module, total) {
    const item = progress?.[module] ?? {};
    const completed = mergeRanges(item.completed);
    const missing = missingRanges(total, completed);
    const through = completed[0]?.[0] === 0 ? completed[0][1] + 1 : 0;
    return { completed, missing, through, failed: mergeRanges(item.failed), latest: item.latest };
}
export function displayRanges(ranges) { return ranges.map(([a, b]) => `${a + 1}-${b + 1}`).join('、') || '无'; }

export function intersectRanges(a, b) {
    return mergeRanges((a ?? []).flatMap(([x, y]) => (b ?? []).map(([u, v]) => [Math.max(x, u), Math.min(y, v)]).filter(([start, end]) => start <= end)));
}

// Group adjacent unprocessed floors with identical missing modules, then split by threshold.
export function pendingBatches(progress, total, size = 20) {
    const modules = Object.keys(MODULE_LABELS);
    const completed = Object.fromEntries(modules.map(module => [module, mergeRanges(progress?.[module]?.completed)]));
    const plan = [];
    for (let floor = 0; floor < total; floor++) {
        const targets = modules.filter(module => !completed[module].some(([a, b]) => a <= floor && floor <= b));
        if (!targets.length) continue;
        const last = plan.at(-1);
        if (last && last.end + 1 === floor && last.end - last.start + 1 < Math.max(1, size) && last.modules.join() === targets.join()) last.end = floor;
        else plan.push({ start: floor, end: floor, modules: targets });
    }
    return plan;
}
