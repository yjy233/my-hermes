/** 摘要检查点和完整历史必须一起成功提交，失败时不能留下半轮记录。 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { Message } from '../src/core/models.js';
import { hashContextPrefix, SessionStore, type ContextCheckpointDraft } from '../src/memory/index.js';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'hermes-checkpoint-'));
  const path = join(root, 'state.db');
  const store = new SessionStore(path);
  const session = store.getOrCreate('alice-chat', 'alice');
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { path, store, session };
}

function turn(topic: string): Message[] {
  return [{ role: 'user', content: `${topic} question` }, { role: 'assistant', content: `${topic} answer` }];
}

function draft(messages: Message[], expectedGeneration = 0): ContextCheckpointDraft {
  return { coveredCount: messages.length, prefixHash: hashContextPrefix(messages),
    summary: '## Goal\n保留压缩前的任务目标。\n## Progress\n已完成测试。', expectedGeneration };
}

test('摘要与原始轮次原子保存，重启后仍可恢复且原始历史可以检索', t => {
  const { path, store, session } = fixture(t);
  const messages = turn('checkpoint_recovery_marker');
  assert.equal(store.loadCheckpoint(session.id), null);
  store.commitTurn(session.id, messages, draft(messages));
  const checkpoint = store.loadCheckpoint(session.id)!;
  assert.equal(checkpoint.sessionId, session.id);
  assert.equal(checkpoint.generation, 1);
  assert.equal(checkpoint.coveredCount, 2);
  assert.equal(checkpoint.prefixHash, hashContextPrefix(messages));
  assert.ok(checkpoint.updatedAt);
  store.close();
  const reopened = new SessionStore(path);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.loadCheckpoint(session.id), checkpoint);
  assert.deepEqual(reopened.loadMessages(session.id), messages);
  assert.equal(reopened.search('checkpoint_recovery_marker', 'alice').length, 2);
});

test('检查点可以覆盖本轮新产生的完整工具轨迹，普通追加不会抹去既有摘要', t => {
  const { store, session } = fixture(t);
  const original = turn('first');
  store.appendMessages(session.id, original);
  const tools: Message[] = [
    { role: 'user', content: '计算 2+3' },
    { role: 'assistant', content: '', reasoningContent: '保留元数据',
      toolCalls: [{ id: 'call-sum', name: 'calculator', arguments: { expression: '2+3' } }] },
    { role: 'tool', content: '{"ok":true,"result":5}', toolCallId: 'call-sum' },
    { role: 'assistant', content: '5' },
  ];
  const transcript = [...original, ...tools];
  store.commitTurn(session.id, tools, draft(transcript));
  const checkpoint = store.loadCheckpoint(session.id)!;
  assert.equal(checkpoint.coveredCount, 6);
  assert.deepEqual(store.loadMessages(session.id), transcript);
  store.commitTurn(session.id, turn('new tail'));
  assert.deepEqual(store.loadCheckpoint(session.id), checkpoint);
  assert.deepEqual(store.loadMessages(session.id), [...transcript, ...turn('new tail')]);
});

test('错误的摘要指纹、覆盖范围、代际和摘要字段都不会提交新消息', t => {
  const { store, session } = fixture(t);
  const original = turn('saved'), pending = turn('pending');
  store.appendMessages(session.id, original);
  const valid = draft([...original, ...pending]);
  const invalid: ContextCheckpointDraft[] = [
    { ...valid, coveredCount: 0 }, { ...valid, coveredCount: -1 },
    { ...valid, coveredCount: 1.5 }, { ...valid, coveredCount: Number.NaN },
    { ...valid, coveredCount: Number.POSITIVE_INFINITY },
    { ...valid, coveredCount: 5 }, { ...valid, prefixHash: '0'.repeat(64) },
    { ...valid, prefixHash: 'not a digest' }, { ...valid, summary: '' },
    { ...valid, summary: '   ' }, { ...valid, summary: 'x'.repeat(16_001) },
    { ...valid, expectedGeneration: 1 }, { ...valid, expectedGeneration: -1 },
    { ...valid, expectedGeneration: 0.5 }, { ...valid, expectedGeneration: Number.NaN },
    { ...valid, expectedGeneration: Number.MAX_SAFE_INTEGER },
  ];
  for (const checkpoint of invalid) {
    assert.throws(() => store.commitTurn(session.id, pending, checkpoint));
    assert.deepEqual(store.loadMessages(session.id), original);
    assert.equal(store.loadCheckpoint(session.id), null);
  }
  // 事务失败后数据库仍然可写。
  store.commitTurn(session.id, pending, valid);
  assert.equal(store.loadMessages(session.id).length, 4);
  assert.equal(store.loadCheckpoint(session.id)?.generation, 1);
});

test('迟到的旧代际或回退的覆盖范围不能覆盖更新检查点', t => {
  const { store, session } = fixture(t);
  const first = turn('first'), second = turn('second'), third = turn('third');
  store.commitTurn(session.id, first, draft(first));
  store.commitTurn(session.id, second, draft([...first, ...second], 1));
  const latest = store.loadCheckpoint(session.id)!;
  assert.equal(latest.generation, 2);
  assert.throws(() => store.commitTurn(session.id, third, draft([...first, ...second, ...third], 1)),
    /generation conflict/);
  assert.throws(() => store.commitTurn(session.id, third, draft(first, 2)), /moves backward/);
  assert.deepEqual(store.loadCheckpoint(session.id), latest);
  assert.deepEqual(store.loadMessages(session.id), [...first, ...second]);
});

test('检查点按会话隔离，其他用户的历史不能通过前缀校验', t => {
  const { store, session: alice } = fixture(t);
  const bob = store.getOrCreate('bob-chat', 'bob');
  const aliceMessages = turn('alice private'), bobMessages = turn('bob private');
  store.commitTurn(alice.id, aliceMessages, draft(aliceMessages));
  assert.equal(store.loadCheckpoint(bob.id), null);
  assert.throws(() => store.commitTurn(bob.id, bobMessages, draft(aliceMessages)), /hash mismatch/);
  assert.deepEqual(store.loadMessages(bob.id), []);
  assert.equal(store.loadCheckpoint(bob.id), null);
  assert.deepEqual(store.search('alice private', 'bob'), []);
});

test('畸形消息或不存在的会话不会留下摘要，指纹保留全部模型协议字段', t => {
  const { store, session } = fixture(t);
  const valid = turn('valid');
  assert.throws(() => store.commitTurn(session.id,
    [...valid, { role: 'invalid', content: 'bad' } as unknown as Message], draft(valid)), /Invalid stored message/);
  assert.throws(() => store.commitTurn('missing-session', valid, draft(valid)));
  assert.deepEqual(store.loadMessages(session.id), []);
  assert.equal(store.loadCheckpoint(session.id), null);
  const base: Message[] = [{ role: 'assistant', content: '', reasoningContent: '',
    toolCalls: [{ id: 'a', name: 'calc', arguments: { number: 1 } }] }];
  assert.notEqual(hashContextPrefix(base), hashContextPrefix([{ ...base[0], reasoningContent: 'changed' }]));
  assert.notEqual(hashContextPrefix(base), hashContextPrefix([{ ...base[0],
    toolCalls: [{ id: 'b', name: 'calc', arguments: { number: 1 } }] }]));
  assert.notEqual(hashContextPrefix(base), hashContextPrefix([{ ...base[0],
    toolCalls: [{ id: 'a', name: 'calc', arguments: { number: 2 } }] }]));
  assert.equal(hashContextPrefix(valid), hashContextPrefix(structuredClone(valid)));
});

test('旧数据库自动增加检查点表，原始消息和冻结提示不被迁移改写', t => {
  const root = mkdtempSync(join(tmpdir(), 'hermes-checkpoint-legacy-'));
  const path = join(root, 'legacy.db');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, session_key TEXT NOT NULL UNIQUE,
    scope TEXT NOT NULL, system_prompt TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
    payload TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
  legacy.prepare('INSERT INTO sessions (id, session_key, scope, system_prompt) VALUES (?, ?, ?, ?)')
    .run('legacy-session', 'legacy-key', 'alice', 'frozen legacy prompt');
  const message: Message = { role: 'user', content: 'legacy_marker' };
  legacy.prepare('INSERT INTO messages (session_id, payload, content) VALUES (?, ?, ?)')
    .run('legacy-session', JSON.stringify(message), message.content);
  legacy.close();
  const store = new SessionStore(path);
  t.after(() => store.close());
  assert.equal(store.loadCheckpoint('legacy-session'), null);
  assert.equal(store.getOrCreate('legacy-key', 'alice').systemPrompt, 'frozen legacy prompt');
  assert.deepEqual(store.loadMessages('legacy-session'), [message]);
  store.commitTurn('legacy-session', [], draft([message]));
  assert.equal(store.loadCheckpoint('legacy-session')?.generation, 1);
  assert.equal(store.search('legacy_marker', 'alice').length, 1);
});

test('手工损坏的检查点显式报错，原始消息仍可读取和搜索', t => {
  const { store, path, session } = fixture(t);
  const messages = turn('source_marker');
  store.commitTurn(session.id, messages, draft(messages));
  const raw = new DatabaseSync(path);
  raw.prepare('UPDATE context_checkpoints SET summary = ? WHERE session_id = ?').run('', session.id);
  raw.close();
  assert.throws(() => store.loadCheckpoint(session.id), /Invalid stored context checkpoint/);
  assert.deepEqual(store.loadMessages(session.id), messages);
  assert.equal(store.search('source_marker', 'alice').length, 2);
});
