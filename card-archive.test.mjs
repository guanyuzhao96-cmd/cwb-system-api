import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cardKey, migrateOwnership, sourceHashes, receiptProgress } from './card-archive.mjs';
const owner = 'CWB:角色卡:Test.png';
const digest = async text => createHash('sha256').update(text).digest('hex');

test('requires an actual card file, rejects group and display-name-only identity', () => {
    assert.equal(cardKey({ characterId: 0, characters: [{ avatar: 'Test.png' }] }), owner);
    assert.throws(() => cardKey({ characterId: 0, characters: [{ name: '同名卡' }] }), /角色卡/);
    assert.throws(() => cardKey({ groupId: '1', characterId: 0, characters: [{ avatar: 'Test.png' }] }), /单人/);
});

test('all generated types migrate across old chats; preserve content, UIDs and manual data; idempotent', () => {
    const markers = ['CWB:自动档案', 'CWB:主角档案', 'CWB:故事时间线', 'CWB:角色关系汇总', 'CWB:角色档案目录', 'CWB:更新状态', 'CWB:更新记录', 'CWB:模块进度', 'Amily2角色总集'];
    const data = { entries: Object.fromEntries(markers.map((marker, uid) => [uid, { uid, key: [marker, 'old-chat-' + uid, 'CWB:聊天身份:old', '1-3'], content: `内容${uid}`, extra: true }])) };
    data.entries[99] = { uid: 99, key: ['手工', 'old-chat-1'], content: '不要改' };
    const originals = structuredClone(data);
    assert.equal(migrateOwnership(data, { owner, exclusivePrimary: true }).length, markers.length);
    for (let uid = 0; uid < markers.length; uid++) {
        assert.equal(data.entries[uid].content, originals.entries[uid].content);
        assert.equal(data.entries[uid].uid, uid);
        assert.equal(data.entries[uid].extra, true);
        assert.ok(data.entries[uid].key.includes(owner));
        assert.ok(!data.entries[uid].key.includes('old-chat-' + uid));
        assert.ok(!data.entries[uid].key.includes('CWB:聊天身份:old'));
        assert.deepEqual(data.entries[uid].cwbLegacyOwnerKeys, originals.entries[uid].key);
    }
    assert.deepEqual(data.entries[99], originals.entries[99]);
    assert.deepEqual(migrateOwnership(data, { owner, exclusivePrimary: true }), []);
});

test('shared books never absorb foreign or ambiguous owners', () => {
    const data = { entries: {
        0: { uid: 0, key: ['CWB:自动档案', 'known-old-chat', '同名角色'], content: '[姓名]:同名角色' },
        1: { uid: 1, key: ['CWB:自动档案', 'unknown-chat', '同名角色'], content: '[姓名]:同名角色' },
        2: { uid: 2, key: ['CWB:自动档案', 'CWB:角色卡:Other.png', 'known-old-chat'], content: '别的卡' },
        3: { uid: 3, key: ['CWB:自动档案', owner, 'CWB:角色卡:Other.png'], content: '混合归属' },
    } };
    assert.deepEqual(migrateOwnership(data, { owner, legacyOwners: ['known-old-chat'] }).map(row => row.uid), [0]);
    assert.equal(data.entries[1].key[1], 'unknown-chat');
    assert.equal(data.entries[2].key[1], 'CWB:角色卡:Other.png');
    assert.equal(data.entries[3].key.length, 3);
});

test('source receipts survive copy and append; changed prefixes and distinct chats have gaps', async () => {
    const chat = [{ mes: '第一件事' }, { mes: '第二件事' }];
    const hashes = await sourceHashes(chat, digest);
    const receipts = Object.fromEntries(hashes.map(hash => [hash, { profiles: { error: null, time: '2026' } }]));
    assert.equal(receiptProgress(receipts, await sourceHashes(structuredClone(chat), digest)).profiles.completed.length, 2);
    assert.equal(receiptProgress(receipts, await sourceHashes([...chat, { mes: '新增' }], digest)).profiles.completed.length, 2);
    assert.equal(receiptProgress(receipts, await sourceHashes([{ mes: '不同' }, chat[1]], digest)).profiles.completed.length, 0);
});
