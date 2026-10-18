import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profileSelectionKey, tokenReduction } from './profile-compaction.mjs';

test('token reduction uses weighted totals and handles empty and expanded profiles', () => {
    assert.equal(tokenReduction(1000, 650), '减少 35.0%');
    assert.equal(tokenReduction(0, 0), '减少 0.0%');
    assert.equal(tokenReduction(100, 120), '增加 20.0%');
    assert.equal(tokenReduction(0, 12), '增加 12 tokens');
    assert.notEqual(profileSelectionKey('甲:1', 2), profileSelectionKey('甲', '1:2'));
});
