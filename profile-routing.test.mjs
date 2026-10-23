import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directoryTarget, profilePayload } from './profile-routing.mjs';

test('directory match is exact, case insensitive and independent of primary book', () => {
    assert.equal(directoryTarget({ 主书: { names: ['其他人'] }, 人物书: { names: ['Alice Smith'] } }, ' alice smith '), '人物书');
    assert.throws(() => directoryTarget({ 主书: { names: ['林清'] } }, '林'), /未匹配/);
});

test('duplicate directory names never choose the primary or first book silently', () => {
    assert.throws(() => directoryTarget({ 主书: { names: ['林清'], primary: true }, 人物书: { names: ['林清'] } }, '林清'), /多个世界书目录/);
});

test('central archive is never an ordinary character destination, including stale central catalogs', () => {
    assert.equal(directoryTarget({ 主存档: { names: ['林清'] }, 人物书: { names: ['林清'] } }, '林清', '主存档'), '人物书');
    assert.throws(() => directoryTarget({ 主存档: { names: ['林清'] } }, '林清', '主存档'), /未匹配/);
});

test('migration equivalence preserves unknown fields, flags, keys and content while allowing a new UID', () => {
    const source = { uid: 7, key: ['角色', '归属'], content: '完整正文', disable: true, extensions: { custom: { b: 2, a: 1 } } };
    assert.equal(profilePayload(source), profilePayload({ ...source, uid: 90, extensions: { custom: { a: 1, b: 2 } } }));
    assert.notEqual(profilePayload(source), profilePayload({ ...source, disable: false }));
    assert.notEqual(profilePayload(source), profilePayload({ ...source, extensions: {} }));
    assert.notEqual(profilePayload(source), profilePayload({ ...source, content: '不同正文' }));
});
