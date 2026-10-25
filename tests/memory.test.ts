import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Message } from '../src/core/models.js';
import { LongTermMemory, SessionStore } from '../src/memory/index.js';

function temporary(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'my-hermes-memory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('complete transcripts survive restart with tool links and a fixed prompt', t => {
  const path = join(temporary(t), 'sessions.db');
  const store = new SessionStore(path);
  const session = store.getOrCreate('chat-a', 'alice');
  store.setSystemPrompt(session.id, 'original snapshot');
  store.setSystemPrompt(session.id, 'cannot replace it');
  const transcript: Message[] = [
    { role: 'user', content: '计算 1+1' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'sum', arguments: { a: 1, b: 1 } }] },
    { role: 'tool', content: '{"ok":true,"result":2}', toolCallId: 'call-1' },
    { role: 'assistant', content: '2' },
  ];
  store.appendMessages(session.id, transcript);
  store.close();
  const reopened = new SessionStore(path);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.loadMessages(session.id), transcript);
  assert.equal(reopened.getOrCreate('chat-a', 'alice').systemPrompt, 'original snapshot');
  assert.throws(() => reopened.getOrCreate('chat-a', 'bob'), /scope/);
  const records = reopened.listSessions();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.messageCount, 4);
  assert.equal(records[0]?.id, session.id);
  assert.ok(records[0]?.createdAt);
});

test('memory recall is scoped and SQL wildcard characters are literal', t => {
  const store = new SessionStore(join(temporary(t), 'state.db'));
  t.after(() => store.close());
  const alice = store.getOrCreate('chat-a', 'alice');
  const bob = store.getOrCreate('chat-b', 'bob');
  store.appendMessages(alice.id, [{ role: 'assistant', content: 'rate: 100%_done' }]);
  store.appendMessages(bob.id, [{ role: 'assistant', content: 'secret 100%_done' }]);
  const hits = store.search('%_', 'alice');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.sessionId, alice.id);
  assert.equal(hits[0]?.content.includes('secret'), false);
  assert.deepEqual(store.search('', 'alice'), []);
  assert.deepEqual(store.search("' OR 1=1 --", 'alice'), []);
  assert.deepEqual(store.search('%_', 'nobody'), []);
  assert.deepEqual(store.search('%_', 'alice', 0), []);
});

test('append rejects invalid turns before partially persisting them', t => {
  const store = new SessionStore(join(temporary(t), 'state.db'));
  t.after(() => store.close());
  const session = store.getOrCreate('chat-a', 'alice');
  assert.throws(() => store.appendMessages(session.id, [
    { role: 'user', content: 'valid prefix' },
    { role: 'invalid', content: 'bad role' } as unknown as Message,
  ]), /Invalid stored message/);
  assert.deepEqual(store.loadMessages(session.id), []);
  assert.throws(() => store.appendMessages(session.id, [{
    role: 'assistant', content: '',
    toolCalls: [{ id: 'c1', name: 'bad_number', arguments: { value: Number.NaN } }],
  }]), /finite/);
  assert.deepEqual(store.loadMessages(session.id), []);
  assert.throws(() => store.appendMessages('missing', [{ role: 'user', content: 'bad session' }]));
  store.appendMessages(session.id, [{ role: 'user', content: 'still usable after rollback' }]);
  assert.equal(store.loadMessages(session.id).length, 1);
});

test('long-term memory enforces budgets, user isolation and safe paths', t => {
  const root = temporary(t);
  const memory = new LongTermMemory(join(root, 'memory'), 12);
  memory.write('alice', 'MEMORY.md', '喜欢 Python');
  memory.write('alice', 'USER.md', 'Alice');
  assert.match(memory.snapshot('alice'), /喜欢 Python/);
  assert.equal(memory.read('bob', 'MEMORY.md'), '');
  assert.throws(() => memory.write('alice', 'MEMORY.md', 'x'.repeat(13)), /at most/);
  assert.equal(memory.read('alice', 'MEMORY.md'), '喜欢 Python');
  assert.throws(() => memory.write('alice', '../escape', 'text'), /target/);
  const scope = join(memory.root, createHash('sha256').update('alice').digest('hex'));
  const external = join(root, 'external.md');
  writeFileSync(external, 'private');
  unlinkSync(join(scope, 'USER.md'));
  symlinkSync(external, join(scope, 'USER.md'));
  assert.throws(() => memory.read('alice', 'USER.md'), /escapes/);
  assert.throws(() => memory.write('alice', 'USER.md', 'replacement'), /escapes/);
  assert.equal(readFileSync(external, 'utf8'), 'private');
});

test('manual oversized memory edits cannot silently overflow the prompt', t => {
  const root = temporary(t);
  const memory = new LongTermMemory(root, 4);
  memory.write('alice', 'USER.md', 'Alic');
  const scope = join(root, createHash('sha256').update('alice').digest('hex'));
  writeFileSync(join(scope, 'USER.md'), 'oversized');
  assert.throws(() => memory.snapshot('alice'), /budget/);
});
