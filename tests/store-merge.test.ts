/** 两条开发线的检查点分表兼容，迁移不改写原始会话。 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { Message } from '../src/core/models.js';
import { initialCompressionState } from '../src/core/compression/settings.js';
import { hashContextPrefix, SessionStore, type ContextCheckpointDraft,
  type WorkingContextCheckpoint } from '../src/memory/store.js';

function location(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'hermes-store-merge-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'sessions.db');
}

function turn(label: string): Message[] {
  return [{ role: 'user', content: `${label} question` }, { role: 'assistant', content: `${label} answer` }];
}

function summary(messages: Message[], expectedGeneration = 0): ContextCheckpointDraft {
  return { coveredCount: messages.length, prefixHash: hashContextPrefix(messages),
    summary: '保留目标和已经核实的进展。', expectedGeneration };
}

function createBase(database: DatabaseSync, messages: Message[]): void {
  database.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, session_key TEXT NOT NULL UNIQUE,
    scope TEXT NOT NULL, system_prompt TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
    payload TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
  database.prepare('INSERT INTO sessions (id, session_key, scope, system_prompt) VALUES (?, ?, ?, ?)')
    .run('existing', 'existing-key', 'alice', 'frozen existing prompt');
  for (const message of messages) {
    database.prepare('INSERT INTO messages (session_id, payload, content) VALUES (?, ?, ?)')
      .run('existing', JSON.stringify(message), message.content);
  }
}

function createSummaryTable(database: DatabaseSync, name: string): void {
  assert.ok(['context_checkpoints', 'summary_checkpoints'].includes(name));
  database.exec(`CREATE TABLE ${name} (session_id TEXT PRIMARY KEY REFERENCES sessions(id),
    generation INTEGER NOT NULL CHECK (generation >= 1), covered_count INTEGER NOT NULL CHECK (covered_count > 0),
    prefix_hash TEXT NOT NULL, summary TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
}

test('本地旧generation表原子改名，原消息、指纹和冻结提示保留，重启迁移幂等', t => {
  const path = location(t), messages = turn('local_legacy_marker');
  const old = new DatabaseSync(path);
  createBase(old, messages);
  createSummaryTable(old, 'context_checkpoints');
  old.prepare('INSERT INTO context_checkpoints (session_id,generation,covered_count,prefix_hash,summary) VALUES (?,?,?,?,?)')
    .run('existing', 3, messages.length, hashContextPrefix(messages), '本地原摘要');
  old.close();
  const store = new SessionStore(path);
  assert.deepEqual(store.loadMessages('existing'), messages);
  assert.equal(store.getOrCreate('existing-key', 'alice').systemPrompt, 'frozen existing prompt');
  assert.equal(store.loadCheckpoint('existing')?.generation, 3);
  assert.equal(store.loadCheckpoint('existing')?.summary, '本地原摘要');
  assert.deepEqual(store.loadContextMessages('existing'), messages);
  assert.deepEqual(store.loadCompressionState('existing'), initialCompressionState());
  store.close();
  const raw = new DatabaseSync(path);
  assert.ok(raw.prepare('PRAGMA table_info(context_checkpoints)').all().some(row => row.name === 'compression_state'));
  assert.ok(raw.prepare('PRAGMA table_info(summary_checkpoints)').all().some(row => row.name === 'generation'));
  raw.close();
  const reopened = new SessionStore(path);
  try {
    assert.equal(reopened.loadCheckpoint('existing')?.generation, 3);
    assert.deepEqual(reopened.loadMessages('existing'), messages);
  } finally { reopened.close(); }
});

test('远端旧工作上下文表原样恢复，摘要marker与冷却状态不丢失', t => {
  const path = location(t), original = turn('remote_legacy_marker');
  const working: Message[] = [{ role: 'user', content: '[summary] 远端摘要',
    contextSummary: { body: '远端摘要', hasUserTurn: true, originalContent: 'original user anchor' } }];
  const state = { cooldownUntil: 1234, failures: 2, nextAttemptChars: 5000, lastFailure: 'timeout' as const };
  const old = new DatabaseSync(path);
  createBase(old, original);
  old.exec(`CREATE TABLE context_checkpoints (session_id TEXT PRIMARY KEY REFERENCES sessions(id),
    payload TEXT, message_count INTEGER NOT NULL DEFAULT -1, compression_state TEXT NOT NULL);`);
  old.prepare('INSERT INTO context_checkpoints (session_id,payload,message_count,compression_state) VALUES (?,?,?,?)')
    .run('existing', JSON.stringify(working), original.length, JSON.stringify(state));
  old.close();
  const store = new SessionStore(path);
  try {
    assert.deepEqual(store.loadMessages('existing'), original);
    assert.deepEqual(store.loadContextMessages('existing'), working);
    assert.deepEqual(store.loadCompressionState('existing'), state);
    assert.equal(store.loadCheckpoint('existing'), null);
  } finally { store.close(); }
});

test('统一commitTurn同时保存原始轨迹和两种检查点，任一检查失败全部不提交', t => {
  const store = new SessionStore(location(t));
  t.after(() => store.close());
  const session = store.getOrCreate('dual', 'alice'), first = turn('first');
  const working: WorkingContextCheckpoint = { messages: [{ role: 'assistant', content: '第一轮摘要',
    reasoningContent: '', contextSummary: { body: '第一轮摘要', hasUserTurn: true } }], state: initialCompressionState() };
  store.commitTurn(session.id, first, summary(first), working);
  const savedSummary = store.loadCheckpoint(session.id), savedWorking = store.loadContextMessages(session.id);
  assert.equal(savedSummary?.generation, 1);
  assert.deepEqual(savedWorking, working.messages);
  assert.deepEqual(store.loadMessages(session.id), first);
  const pending = turn('pending'), replacement = { ...working, messages: turn('replacement') };
  assert.throws(() => store.commitTurn(session.id, pending,
    { ...summary([...first, ...pending], 1), prefixHash: '0'.repeat(64) }, replacement), /hash mismatch/u);
  assert.deepEqual(store.loadMessages(session.id), first);
  assert.deepEqual(store.loadCheckpoint(session.id), savedSummary);
  assert.deepEqual(store.loadContextMessages(session.id), savedWorking);
  assert.throws(() => store.commitTurn(session.id, pending, summary([...first, ...pending], 1), {
    ...replacement, state: { ...initialCompressionState(), failures: Number.NaN },
  }), /Invalid compression state/u);
  assert.deepEqual(store.loadMessages(session.id), first);
  assert.deepEqual(store.loadContextMessages(session.id), savedWorking);
});

test('appendMessages第三参数保留远端行为，普通追加使工作水位失效但不清除代际摘要', t => {
  const store = new SessionStore(location(t));
  t.after(() => store.close());
  const session = store.getOrCreate('append', 'alice'), first = turn('first');
  const working: WorkingContextCheckpoint = { messages: turn('short view'), state: initialCompressionState() };
  store.commitTurn(session.id, first, summary(first));
  const second = turn('second');
  store.appendMessages(session.id, second, working);
  assert.deepEqual(store.loadContextMessages(session.id), working.messages);
  assert.equal(store.loadCheckpoint(session.id)?.generation, 1);
  const last = turn('third');
  store.appendMessages(session.id, last);
  assert.deepEqual(store.loadContextMessages(session.id), [...first, ...second, ...last]);
  const cooldown = { ...initialCompressionState(), failures: 1, lastFailure: 'overload' as const, cooldownUntil: 500 };
  store.saveCompressionState(session.id, cooldown);
  assert.deepEqual(store.loadCompressionState(session.id), cooldown);
  assert.deepEqual(store.loadContextMessages(session.id), [...first, ...second, ...last]);
  assert.equal(store.loadCheckpoint(session.id)?.generation, 1);
});

test('原始与工作消息保留contextSummary和所有协议字段，指纹也覆盖summary元数据', t => {
  const store = new SessionStore(location(t));
  t.after(() => store.close());
  const session = store.getOrCreate('metadata', 'alice');
  const messages: Message[] = [{ role: 'assistant', content: '', reasoningContent: 'reasoning',
    toolCalls: [{ id: 'c', name: 'calculator', arguments: { expression: '2+3' } }],
    contextSummary: { body: 'summary', hasUserTurn: true, originalContent: 'original' } },
  { role: 'tool', content: '{"ok":true,"result":5}', toolCallId: 'c' }];
  store.appendMessages(session.id, messages, { messages, state: initialCompressionState() });
  assert.deepEqual(store.loadMessages(session.id), messages);
  assert.deepEqual(store.loadContextMessages(session.id), messages);
  const changed = structuredClone(messages);
  changed[0].contextSummary!.body = 'changed';
  assert.notEqual(hashContextPrefix(messages), hashContextPrefix(changed));
});

test('若两张旧摘要表同时存在，迁移拒绝覆盖并回滚，保留所有原始数据', t => {
  const path = location(t), messages = turn('collision_marker');
  const old = new DatabaseSync(path);
  createBase(old, messages);
  createSummaryTable(old, 'context_checkpoints');
  createSummaryTable(old, 'summary_checkpoints');
  old.close();
  assert.throws(() => new SessionStore(path), /refusing to overwrite/u);
  const raw = new DatabaseSync(path);
  try {
    assert.ok(raw.prepare('PRAGMA table_info(context_checkpoints)').all().some(row => row.name === 'generation'));
    assert.ok(raw.prepare('PRAGMA table_info(summary_checkpoints)').all().some(row => row.name === 'generation'));
    assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM messages').get()!.count, messages.length);
  } finally { raw.close(); }
});
