import test from 'node:test';
import assert from 'node:assert/strict';
import { cardOwnerKey, belongsToCardOrLegacyChat, legacyProfileMatchesWorldbook, hasOtherCardOwner } from './card-scope.mjs';

const card = (avatar, chatId, name = '角色甲') => ({
    characterId: 0, name2: name, chatId, characters: [{ avatar, name }],
});
test('one character card keeps the same identity across chat names and branches', () => {
    const first = cardOwnerKey(card('main-001.png', 'original - Branch #3'), '____世界');
    assert.equal(first, cardOwnerKey(card('main-001.png', 'another-chat'), '____世界'));
    assert.notEqual(first, cardOwnerKey(card('other-002.png', 'another-chat'), '____世界'));
    assert.notEqual(first, cardOwnerKey(card('main-001.png', 'another-chat'), 'other book'));
});
test('legacy identity uses primary worldbook, not an old chat integrity ID', () => {
    const oldKey = 'CWB:档案身份:' + encodeURIComponent('____世界\0integrity:40a6cd8a');
    assert.ok(legacyProfileMatchesWorldbook(['CWB:自动档案', oldKey], '____世界'));
    assert.ok(!legacyProfileMatchesWorldbook([oldKey], '另一世界'));
});
test('card-owned records cannot leak to another card or rely on chat id', () => {
    const one = cardOwnerKey(card('a.png', 'old'), '主世界');
    const other = cardOwnerKey(card('b.png', 'old'), '主世界');
    assert.ok(belongsToCardOrLegacyChat(['CWB:自动档案', one], one, 'new'));
    assert.ok(!belongsToCardOrLegacyChat(['CWB:自动档案', one, 'old'], other, 'old'));
    assert.ok(hasOtherCardOwner([one], other));
    assert.ok(belongsToCardOrLegacyChat(['CWB:自动档案', 'old'], other, 'old'));
});
test('fallback card name is stable without avatar and missing identity fails closed', () => {
    const char = { characters: [{ name: '旧角色' }], characterId: 0 };
    assert.equal(cardOwnerKey(char, '主书'), cardOwnerKey({ ...char, chatId: 'B' }, '主书'));
    assert.throws(() => cardOwnerKey({ characters: [{}], characterId: 0 }, '主书'), /稳定身份/);
});
