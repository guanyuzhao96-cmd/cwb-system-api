// Prepare model context only. Original messages and source receipt hashes stay intact.
const machineBlocks = /<(UpdateVariable|JSONPatch|Analysis|part_thinking|image|image_think|text_to_image)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const summaries = /<plot_summary\b[^>]*>([\s\S]*?)<\/plot_summary\s*>/gi;

export function archiveSource(value) {
    const raw = String(value ?? '');
    // Ignore examples or summary-like tags embedded in machine output.
    const clean = raw.replace(machineBlocks, '');
    const bodies = [...clean.matchAll(/<dream_body\b[^>]*>([\s\S]*?)<\/dream_body\s*>/gi)].map(match => match[1].replace(summaries, '').trim()).filter(Boolean);
    if (bodies.length) return { kind: 'body', text: bodies.join('\n\n') };
    const parts = [...clean.matchAll(summaries)].map(match => match[1].trim()).filter(Boolean);
    if (parts.length) return { kind: 'summary', text: [...new Set(parts)].join('\n\n') };
    const text = clean.replace(/<details\b[^>]*>[\s\S]*?<\/details\s*>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?[A-Za-z][^>]*>/g, '').trim();
    return { kind: text ? 'body' : 'missing', text };
}

export function prepareArchiveMessages(messages) {
    return messages.map(message => {
        const source = archiveSource(message.message ?? message.mes);
        return { ...message, message: source.text, archiveSourceKind: source.kind };
    });
}

export const SUMMARY_SOURCE_GUIDANCE = `输入可能是正文已删除后保留的逐楼剧情总结。标注“保留的剧情总结”的内容是本楼的剧情来源，与正文一样可用于提取已确认事实；不要因原正文缺失就输出档案无变化。只依据总结明确记载的角色行为、因果和结果整理，不补写被删除的细节，不把叙述者信息当成角色已知信息。用户消息中的要求或计划不能自动当作已完成事件，除非后续剧情来源明确确认。标注“本楼无可用剧情来源”的楼层没有恢复出的正文或总结，不得从变量补丁、状态数值或旧swipe臆造剧情；若整个范围均无可用事实，应说明来源不足，不得假称已生成档案。`;
