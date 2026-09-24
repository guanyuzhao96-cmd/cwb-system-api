import test from 'node:test';
import assert from 'node:assert/strict';
import {
    formatRanges,
    mergeRanges,
    missingRanges,
    overlappingRanges,
    parseTaggedRanges,
    updateTrackerContent,
} from './update-tracker.mjs';

test('records zero-based ranges and finds gaps across the whole chat', () => {
    const keys = ['CWB:总结楼层:0-20', 'CWB:总结楼层:26-40'];
    const ranges = mergeRanges(parseTaggedRanges(keys, 'CWB:总结楼层:'));
    assert.deepEqual(ranges, [[0, 20], [26, 40]]);
    assert.deepEqual(missingRanges(41, ranges), [[21, 25]]);
    assert.equal(formatRanges(ranges), '0-20、26-40');
});

test('finds overlaps and remembers repeated floors, including partial overlap', () => {
    const known = [[0, 20]];
    assert.deepEqual(overlappingRanges(15, 25, known), [[15, 20]]);
    assert.deepEqual(mergeRanges([...known, [15, 25]]), [[0, 25]]);
    assert.deepEqual(mergeRanges([[15, 20], [18, 22]]), [[15, 22]]);
});

test('update record content shows completed, repeated and missing ranges', () => {
    const content = updateTrackerContent({
        completedRanges: [[0, 20], [26, 40]],
        duplicateRanges: [[15, 20]],
        totalMessages: 41,
        latest: '0-20楼｜角色档案写入3名',
    });
    assert.match(content, /已总结：0-20、26-40/);
    assert.match(content, /重复总结：15-20/);
    assert.match(content, /未总结：21-25/);
    assert.match(content, /最近一次：0-20楼/);
});

test('new tracking baseline does not mislabel older chat history as missing', () => {
    const content = updateTrackerContent({
        completedRanges: [[20, 30]],
        duplicateRanges: [],
        totalMessages: 35,
        trackingStartIndex: 20,
        latest: '20-30楼',
    });
    assert.match(content, /追踪前未核实：0-19/);
    assert.match(content, /追踪后未总结：31-34/);
});
