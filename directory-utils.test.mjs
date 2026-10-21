import test from 'node:test';
import assert from 'node:assert/strict';
import {
    directoryContent,
    duplicateLines,
    findRoutedBook,
    namesFromDirectory,
    namesFromRoleEntries,
} from './directory-utils.mjs';

test('generated directory format is read back for routing', () => {
    const content = directoryContent(['周韵涵', 'Alice Smith']);
    assert.deepEqual(namesFromDirectory(content), ['周韵涵', 'Alice Smith']);
    assert.deepEqual(namesFromDirectory('<div>姓名："周韵涵"<br>姓名: "Alice Smith"</div>'), ['周韵涵', 'Alice Smith']);
});

test('route lookup matches names case-insensitively and reports no match', () => {
    const routes = {
        '主世界书': { names: ['赵冠宇'], primary: true },
        '小故事线': { names: ['周韵涵'], primary: false },
    };
    assert.equal(findRoutedBook(routes, ' 周韵涵 '), '小故事线');
    assert.equal(findRoutedBook(routes, 'not listed'), null);
    assert.equal(findRoutedBook(routes, ''), null);
    assert.equal(findRoutedBook({
        '主世界书': { names: ['周韵涵'], primary: true },
        '故事线': { names: ['周韵涵'], primary: false },
    }, '周韵涵'), '主世界书', 'primary route wins if the same role is present in more than one directory');
});

test('only person-shaped titles and trigger keys are used; body is ignored', () => {
    const entries = [
        { comment: '周韵涵', key: ['周韵涵', '学姐'], content: '规则正文里写着姓名：假角色' },
        { comment: '世界书目录', key: ['CWB:世界书目录'], content: '姓名: "目录里的名字"' },
        { comment: '更新规则', key: ['提示词模板'], content: '姓名: "不应读取正文"' },
        { comment: '动态-赵冠宇', key: ['赵冠宇', 'CWB:自动档案', 'chat-123'], content: '' },
    ];
    const names = namesFromRoleEntries(entries);
    assert.deepEqual([...names.keys()].sort(), ['周韵涵', '赵冠宇']);
    assert.equal(names.get('周韵涵').length, 1, 'same name in one title and trigger key counts once');
});

test('duplicate character entries in one book and across books are reported', () => {
    const duplicates = new Map([
        ['周韵涵', [
            { bookName: '故事线01', comment: '周韵涵' },
            { bookName: '故事线01', comment: '动态-周韵涵' },
            { bookName: '故事线02', comment: '周韵涵' },
        ]],
    ]);
    assert.deepEqual(duplicateLines(duplicates), ['周韵涵：故事线01（2个条目：周韵涵、动态-周韵涵）、故事线02']);
});
