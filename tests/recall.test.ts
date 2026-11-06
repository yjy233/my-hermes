/** 召回走真实 learner → 工具 → SQLite，验证压缩与进程重启不会丢失可检索的原文。 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Agent } from '../src/core/agent.js';
import { buildRegistry } from '../src/core/builtin-tools.js';
import { DemoProvider } from '../src/core/providers.js';
import type { Message, Provider } from '../src/core/models.js';
import { Gateway } from '../src/gateway/router.js';
import { loadAlgorithms } from '../src/learning/index.js';
import { LongTermMemory, SessionStore } from '../src/memory/index.js';
import type { MemoryHit } from '../src/memory/store.js';
import { SkillCatalog } from '../src/skills/catalog.js';

function resultOf(reply: string): MemoryHit[] {
  const payload = JSON.parse(reply.slice(reply.indexOf('{')));
  assert.equal(payload.ok, true, reply);
  assert.ok(Array.isArray(payload.result), reply);
  return payload.result;
}

test('learner recalls original details across sessions after real compression and reopening SQLite', async t => {
  const root = mkdtempSync(join(tmpdir(), 'my-hermes-recall-'));
  const path = join(root, 'sessions.db');
  let store = new SessionStore(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const memory = new LongTermMemory(join(root, 'memory'));
  const skills = new SkillCatalog([]);
  const scope = Gateway.scopeFor('lab', 'alice');
  const first = store.getOrCreate('old-room', scope);
  const detail = '归档编号 archive-key 对应货架 B-42。';
  const raw: Message[] = Array.from({ length: 18 }, (_, index): Message[] => [
    { role: 'user', content: index === 5 ? detail : `Question ${index}: ` + 'detail '.repeat(40) },
    { role: 'assistant', content: `Observation ${index}: ` + 'evidence '.repeat(100) },
  ]).flat();
  store.appendMessages(first.id, raw);
  for (const privateScope of [Gateway.scopeFor('lab', 'bob'), Gateway.scopeFor('other', 'alice')]) {
    const session = store.getOrCreate(privateScope, privateScope);
    store.appendMessages(session.id, [{ role: 'user', content: 'archive-key PRIVATE_OTHER_SCOPE' }]);
  }
  let summaries = 0;
  const summary: Provider = { async complete() {
    summaries++;
    return { content: '## Outstanding request\nContinue the discussion.\n## Completed actions\nReviewed earlier observations.\n## Constraints and preferences\nNo additional constraints.' };
  } };
  const agent = () => new Agent({ provider: new DemoProvider(), summaryProvider: summary,
    store, memory, skills, mode: 'learner', compression: { protectLast: 4, summaryChars: 2000 } });
  await agent().run('old-room', scope, '整理之前的讨论');
  assert.equal(summaries, 1);
  assert.ok(store.loadContextMessages(first.id).some(message => message.contextSummary));
  assert.equal(store.loadContextMessages(first.id).some(message => message.content.includes('archive-key')), false);
  assert.deepEqual(store.loadMessages(first.id).slice(0, raw.length), raw);

  store.close();
  store = new SessionStore(path);
  for (const key of ['new-room', 'old-room']) {
    const hits = resultOf(await agent().run(key, scope, '/recall archive-key'));
    assert.ok(hits.some(hit => hit.sessionId === first.id && hit.content === detail));
    assert.equal(hits.some(hit => hit.content.includes('PRIVATE_OTHER_SCOPE')), false);
    assert.ok(hits.length <= 5);
  }
  assert.deepEqual(resultOf(await agent().run('no-match', scope, '/recall no-such-archive')), []);

  const isolatedStore = new SessionStore(join(root, 'other-profile', 'sessions.db'));
  try {
    const isolated = new Agent({ provider: new DemoProvider(), store: isolatedStore,
      memory: new LongTermMemory(join(root, 'other-profile', 'memory')), skills, mode: 'learner' });
    assert.deepEqual(resultOf(await isolated.run('new-room', scope, '/recall archive-key')), []);
  } finally { isolatedStore.close(); }
});

test('history tool rejects scope overrides, bounds output and reports storage failures to the learner loop', async t => {
  const root = mkdtempSync(join(tmpdir(), 'my-hermes-recall-tool-'));
  const store = new SessionStore(':memory:');
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const learner = loadAlgorithms('learner');
  const registry = buildRegistry(new LongTermMemory(root), store, new SkillCatalog([]), 'alice', learner);
  const session = store.getOrCreate('alice-room', 'alice');
  store.appendMessages(session.id, [{ role: 'user', content: 'large-history '.repeat(3000) }]);
  const call = { id: 'recall', name: 'history_search', arguments: { query: 'large-history' } };
  const bounded = await registry.execute(call);
  assert.ok(bounded.content.length <= registry.maxOutputChars);
  assert.equal(JSON.parse(bounded.content).ok, true);
  assert.equal(JSON.parse(bounded.content).truncated, true);
  const forbidden = JSON.parse((await registry.execute({ ...call, arguments: { query: 'large-history', scope: 'bob' } })).content);
  assert.equal(forbidden.ok, false);
  assert.match(forbidden.message, /unexpected property scope/);

  store.close();
  const delta = await learner.runLoop(new DemoProvider(), registry,
    [{ role: 'user', content: '/recall archive-key' }], 3, () => {});
  const failure = JSON.parse(delta.find(message => message.role === 'tool')!.content);
  assert.equal(failure.ok, false);
  assert.equal(typeof failure.message, 'string');
  assert.equal(delta.at(-1)?.role, 'assistant');
  assert.match(delta.at(-1)!.content, /"ok":false/);
});
