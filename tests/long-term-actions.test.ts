/** 长期记忆整理要可恢复、按用户隔离；失败的一批操作不能留下半套事实。 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { buildRegistry } from '../src/core/builtin-tools.js';
import { loadAlgorithms } from '../src/learning/index.js';
import { LongTermMemory, MemoryOperationError, type MemoryOperation } from '../src/memory/long-term.js';
import { SessionStore } from '../src/memory/store.js';
import { SkillCatalog } from '../src/skills/catalog.js';

function fixture(t: TestContext, maxChars = 4000) {
  const root = mkdtempSync(join(tmpdir(), 'hermes-memory-actions-'));
  const memory = new LongTermMemory(join(root, 'memory'), maxChars);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, memory };
}

test('长期记忆按条目管理，显示容量，用户档案与环境事实按 scope 分开', t => {
  const { memory } = fixture(t);
  const result = memory.manage('alice', 'memory', [
    { action: 'add', content: '项目使用 TypeScript。' },
    { action: 'add', content: '测试命令是 npm test。\n完成修改后运行。' },
  ]);
  assert.equal(result.changed, true);
  assert.equal(result.target, 'memory');
  assert.deepEqual(result.entries, ['项目使用 TypeScript。', '测试命令是 npm test。\n完成修改后运行。']);
  const raw = memory.read('alice', 'MEMORY.md');
  assert.equal(raw, result.entries.join('\n\n§\n\n'));
  assert.deepEqual(result.usage, { chars: raw.length, limit: 4000, percent: Math.round(raw.length / 4000 * 100) });
  memory.manage('alice', 'user', [{ action: 'add', content: '请用中文解释代码。' }]);
  assert.equal(memory.read('alice', 'USER.md'), '请用中文解释代码。');
  assert.equal(memory.read('bob', 'MEMORY.md'), '');
  assert.equal(memory.read('bob', 'USER.md'), '');
  assert.match(memory.snapshot('alice'), /## MEMORY\.md \[\d+\/4000 chars; \d+%\]/);
  assert.match(memory.snapshot('alice'), /请用中文解释代码。/);
});

test('容量只按整批最终结果检查，可先 add 再移除旧事实腾空间', t => {
  const { memory } = fixture(t, 50);
  const obsolete = 'old deployment notes '.repeat(2).trim();
  memory.manage('alice', 'memory', [
    { action: 'add', content: obsolete },
    { action: 'add', content: 'TS' },
  ]);
  const result = memory.manage('alice', 'memory', [
    { action: 'add', content: 'new stable preference' },
    { action: 'remove', old_text: obsolete },
  ]);
  assert.deepEqual(result.entries, ['TS', 'new stable preference']);
  assert.ok(result.usage.chars <= 50);
  assert.equal(memory.read('alice', 'MEMORY.md'), result.entries.join('\n\n§\n\n'));
});

test('最终容量超限时给出原条目和所需空间，不提交前面的 patch', t => {
  const { memory } = fixture(t, 40);
  const original = 'first durable fact';
  memory.write('alice', 'MEMORY.md', original);
  assert.throws(() => memory.manage('alice', 'memory', [
    { action: 'patch', old_text: 'first', content: 'other' },
    { action: 'add', content: 'second lasting fact is too long' },
  ]), error => {
    assert.ok(error instanceof MemoryOperationError);
    assert.equal(error.details.code, 'capacity_exceeded');
    assert.deepEqual(error.details.current_entries, [original]);
    assert.deepEqual(error.details.usage, { chars: original.length, limit: 40, percent: Math.round(original.length / 40 * 100) });
    assert.equal(error.details.required_space, ('other durable fact\n\n§\n\nsecond lasting fact is too long').length - 40);
    assert.match(error.message, /No operation was committed/);
    return true;
  });
  assert.equal(memory.read('alice', 'MEMORY.md'), original);
});

test('patch 只修改唯一 span，保留同一条中的其它事实', t => {
  const { memory } = fixture(t);
  memory.manage('alice', 'memory', [{ action: 'add', content: 'User prefers dark mode; project uses TypeScript.' }]);
  const result = memory.manage('alice', 'memory', [{ action: 'patch', old_text: 'dark mode', content: 'light mode' }]);
  assert.deepEqual(result.entries, ['User prefers light mode; project uses TypeScript.']);
  assert.equal(memory.read('alice', 'MEMORY.md'), result.entries[0]);
  // 只有独占一行的 § 是分隔符，普通句子中的字符可以按 span 正常修改。
  assert.deepEqual(memory.manage('alice', 'memory', [{ action: 'patch', old_text: 'light', content: '§' }]).entries,
    ['User prefers § mode; project uses TypeScript.']);
});

test('匹配歧义或后续操作失败时，整批回滚；完整条目匹配优先', t => {
  const { memory } = fixture(t);
  memory.manage('alice', 'memory', [
    { action: 'add', content: 'use tabs' },
    { action: 'add', content: 'editor use tabs' },
  ]);
  const original = memory.read('alice', 'MEMORY.md');
  assert.throws(() => memory.manage('alice', 'memory', [{ action: 'remove', old_text: 'tabs' }]), /multiple entries/);
  assert.throws(() => memory.manage('alice', 'memory', [
    { action: 'add', content: 'must not be committed' },
    { action: 'patch', old_text: 'missing entry', content: 'replacement' },
  ]), error => {
    assert.ok(error instanceof MemoryOperationError);
    assert.equal(error.details.code, 'not_found');
    assert.equal(error.details.operation_index, 1);
    return true;
  });
  assert.equal(memory.read('alice', 'MEMORY.md'), original);
  const changed = memory.manage('alice', 'memory', [{ action: 'patch', old_text: 'use tabs', content: 'use spaces' }]);
  assert.deepEqual(changed.entries, ['use spaces', 'editor use tabs']);
});

test('同条记忆中的重复 span 不能被 patch，remove 则删除整个唯一条目', t => {
  const { memory } = fixture(t);
  memory.manage('alice', 'memory', [{ action: 'add', content: 'alpha and alpha' }]);
  const original = memory.read('alice', 'MEMORY.md');
  assert.throws(() => memory.manage('alice', 'memory', [{ action: 'patch', old_text: 'alpha', content: 'beta' }]), /more than once/);
  assert.equal(memory.read('alice', 'MEMORY.md'), original);
  assert.deepEqual(memory.manage('alice', 'memory', [{ action: 'remove', old_text: 'alpha' }]).entries, []);
  assert.equal(memory.read('alice', 'MEMORY.md'), '');
});

test('精确重复 add 和无变化 patch 幂等成功，保留旧 write 文档的原格式', t => {
  const { memory } = fixture(t);
  const original = '\n  I prefer TypeScript. \n';
  memory.write('alice', 'USER.md', original);
  const duplicate = memory.manage('alice', 'user', [{ action: 'add', content: 'I prefer TypeScript.' }]);
  assert.equal(duplicate.changed, false);
  assert.deepEqual(duplicate.entries, ['I prefer TypeScript.']);
  assert.equal(duplicate.usage.chars, original.length);
  assert.equal(memory.read('alice', 'USER.md'), original);
  const unchanged = memory.manage('alice', 'user', [{ action: 'patch', old_text: 'TypeScript', content: 'TypeScript' }]);
  assert.equal(unchanged.changed, false);
  assert.equal(memory.read('alice', 'USER.md'), original);
});

test('无效批次、字段或跨目标操作不能写入；条目不能注入分隔符', t => {
  const { memory } = fixture(t);
  memory.write('alice', 'USER.md', 'existing fact');
  const invalid: unknown[] = [
    [], null,
    [{ action: 'add', content: '' }],
    [{ action: 'add', content: 'one\n§\ntwo' }],
    [{ action: 'patch', old_text: 'existing', content: 42 }],
    [{ action: 'remove', old_text: '   ' }],
    [{ action: 'add', content: 'new', target: 'memory' }],
    [{ action: 'replace', old_text: 'existing fact', content: 'new' }],
    [{ action: 'add', content: 'new' }, { action: 'patch', old_text: 'existing' }],
  ];
  for (const operations of invalid) {
    assert.throws(() => memory.manage('alice', 'user', operations as MemoryOperation[]), MemoryOperationError);
    assert.equal(memory.read('alice', 'USER.md'), 'existing fact');
  }
  assert.throws(() => memory.manage('alice', '../escape' as 'user', [{ action: 'add', content: 'new' }]), /target/);
});

test('memory 工具将容量错误交给模型，并能在下一次调用中合并条目后重试', async t => {
  const { root, memory } = fixture(t, 30);
  const store = new SessionStore(join(root, 'sessions.db'));
  t.after(() => store.close());
  const registry = buildRegistry(memory, store, new SkillCatalog([join(root, 'skills')]), 'alice', loadAlgorithms('reference'));
  const schema = registry.schemas().find(item => item.function.name === 'memory');
  assert.ok(schema);
  assert.match(schema.function.description, /Never store credentials/);
  memory.write('alice', 'USER.md', 'A lengthy old preference');
  const rejected = await registry.execute({ id: 'overflow', name: 'memory', arguments: {
    target: 'user', operations: [{ action: 'add', content: 'likes TypeScript' }],
  } });
  const failure = JSON.parse(rejected.content);
  assert.equal(failure.ok, false);
  assert.equal(failure.error, 'MemoryOperationError');
  assert.match(failure.message, /current_entries/);
  assert.match(failure.message, /required_space/);
  const retried = await registry.execute({ id: 'retry', name: 'memory', arguments: {
    target: 'user', operations: [
      { action: 'patch', old_text: 'A lengthy old preference', content: 'concise' },
      { action: 'add', content: 'likes TypeScript' },
    ],
  } });
  const success = JSON.parse(retried.content);
  assert.equal(success.ok, true);
  assert.deepEqual(success.result.entries, ['concise', 'likes TypeScript']);
  assert.equal(retried.toolCallId, 'retry');
  assert.equal(memory.read('bob', 'USER.md'), '');
});
