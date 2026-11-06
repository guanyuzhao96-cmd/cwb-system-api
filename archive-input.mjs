// Only non-narrative machine blocks are removed. Story, dialogue, dates, chat
// messages, plot summaries and unknown tags remain; original messages/receipts
// are never changed. Process each floor independently so broken markup cannot
// consume a following floor.
const nonNarrative = /<(image|text_to_image|image_think|UpdateVariable|JSONPatch|part_thinking|Analysis)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

export function archiveText(value) {
    return String(value ?? '').replace(nonNarrative, '').replace(/\n[\t ]*\n(?:[\t ]*\n)+/g, '\n\n').trim();
}

export function archiveMessages(messages) {
    return messages.map(message => ({ ...message, message: archiveText(message.message ?? message.mes) }));
}

export const ARCHIVE_BATCH_CHARACTERS = 18000;
// Threshold remains a trigger/floor limit; large floors require smaller requests.
// Never truncate a floor or skip it. A single oversized floor remains explicit.
export function archiveBatches(messages, start, end, budget = ARCHIVE_BATCH_CHARACTERS) {
    const batches = [];
    for (let floor = start; floor <= end; floor++) {
        const size = archiveText(messages[floor]?.message ?? messages[floor]?.mes).length + 80;
        const previous = batches.at(-1);
        if (previous && previous.characters + size <= budget) { previous.end = floor; previous.characters += size; }
        else batches.push({ start: floor, end: floor, characters: size });
    }
    return batches;
}
