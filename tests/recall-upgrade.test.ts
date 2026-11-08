/**
 * L3 进阶集成：用真实 SQLite 和真正的学习者工具循环，模拟模型先搜索、再读取原文。
 * Provider 只是可复现的决策脚本，不使用真实凭证、网络或日常 profile。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildRegistry } from '../src/core/builtin-tools.js';
import type { Message, Provider } from '../src/core/models.js';
import { loadAlgorithms } from '../src/learning/index.js';
import { LongTermMemory } from '../src/memory/long-term.js';
import { SessionStore, type HistoryPage, type MemoryHit } from '../src/memory/store.js';
import { SkillCatalog } from '../src/skills/catalog.js';
import { recallCases } from '../src/stages/recall.js';

for (const mode of ['learner', 'reference'] as const) {
  test(`${mode} 模型先收到搜索锚点，再调用 history_read，下一次请求能看到邻近原文`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'hermes-recall-upgrade-'));
    const store = new SessionStore(join(root, 'sessions.db'));
    t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
    const algorithms = loadAlgorithms(mode), session = store.getOrCreate('old-task', 'alice');
    const foreign = store.getOrCreate('private-task', 'bob');
    const raw: Message[] = [
      { role: 'user', content: '这次排查的前提：部署环境是本地测试。' },
      { role: 'assistant', content: 'memory implementation uses TypeScript，原始编号 B-42。' },
      { role: 'user', content: '后续要求：保留原始日志，不改变配置。' },
      { role: 'assistant', content: '已核对原始信息。', reasoningContent: '协议元数据仍保存在数据库。' },
    ];
    store.appendMessages(session.id, raw);
    store.appendMessages(foreign.id, [{ role: 'user', content: 'TypeScript memory PRIVATE_BOB' }]);
    const registry = buildRegistry(new LongTermMemory(join(root, 'memory')), store,
      new SkillCatalog([]), 'alice', algorithms);
    let requests = 0, anchor: MemoryHit | undefined;
    const provider: Provider = { async complete(messages, tools) {
      assert.ok(tools.some(tool => tool.function.name === 'history_search'));
      assert.ok(tools.some(tool => tool.function.name === 'history_read'));
      if (requests++ === 0) return { content: '', toolCalls: [
        { id: 'search-call', name: 'history_search', arguments: { query: 'TypeScript memory' } },
      ] };
      if (requests === 2) {
        // 第二次模型请求必须带上第一次工具结果，不能在查完数据库后直接对用户答复。
        assert.equal(messages.at(-1)?.role, 'tool');
        assert.equal(messages.at(-1)?.toolCallId, 'search-call');
        const result = JSON.parse(messages.at(-1)!.content) as { ok: boolean; result: MemoryHit[] };
        assert.equal(result.ok, true); assert.equal(result.result.length, 1);
        anchor = result.result[0];
        assert.equal(anchor.source, 'fts5');
        assert.ok(Number.isSafeInteger(anchor.messageId));
        assert.equal(anchor.sessionId, session.id);
        assert.ok(!result.result.some(hit => hit.content.includes('PRIVATE_BOB')));
        return { content: '需要读取这条命中的前后文。', toolCalls: [{ id: 'read-call', name: 'history_read', arguments: {
          session_id: anchor.sessionId, around_message_id: anchor.messageId, limit: 3,
        } }] };
      }
      assert.equal(messages.at(-1)?.role, 'tool');
      assert.equal(messages.at(-1)?.toolCallId, 'read-call');
      const read = JSON.parse(messages.at(-1)!.content) as { ok: boolean; result: HistoryPage };
      assert.equal(read.ok, true);
      assert.equal(read.result.sessionId, session.id);
      assert.ok(read.result.messages.some(row => row.id === anchor!.messageId));
      assert.ok(read.result.messages.some(row => row.message.content.includes('部署环境是本地测试')));
      assert.ok(read.result.messages.some(row => row.message.content.includes('保留原始日志')));
      return { content: '原始编号是 B-42，前提是本地部署，后续要求保留日志。' };
    } };
    const input: Message[] = [{ role: 'system', content: '需要历史信息时先查再读。' },
      { role: 'user', content: '找回 TypeScript 和 memory 的讨论，结合前后文回答。' }];
    const before = structuredClone(input);
    const delta = await algorithms.runLoop(provider, registry, input, 4, () => {});
    assert.equal(requests, 3);
    assert.deepEqual(delta.map(row => row.role), ['assistant', 'tool', 'assistant', 'tool', 'assistant']);
    assert.equal(delta.at(-1)?.content, '原始编号是 B-42，前提是本地部署，后续要求保留日志。');
    assert.deepEqual(input, before);
    assert.deepEqual(store.loadMessages(session.id), raw, '检索工具只读，不覆盖原始历史');
  });
}

test('基于消息 ID 的前后翻页不依赖连续编号，正反读取都不混入其他会话', () => {
  const store = new SessionStore(':memory:');
  try {
    const own = store.getOrCreate('own', 'alice'), foreign = store.getOrCreate('foreign', 'bob');
    const contents = Array.from({ length: 11 }, (_, index) => `message-${index}`);
    for (const content of contents) {
      store.appendMessages(own.id, [{ role: 'user', content }]);
      store.appendMessages(foreign.id, [{ role: 'user', content: 'PRIVATE' }]);
    }
    const ids: number[] = [], visible: string[] = [];
    let page = store.readHistory(own.id, 'alice', { limit: 4 });
    assert.equal(page.hasBefore, false);
    for (let count = 0; count < 10; count++) {
      ids.push(...page.messages.map(row => row.id));
      visible.push(...page.messages.map(row => row.message.content));
      if (!page.hasAfter) break;
      assert.ok(page.afterCursor);
      page = store.readHistory(own.id, 'alice', { afterMessageId: page.afterCursor, limit: 4 });
    }
    assert.deepEqual(visible, contents);
    assert.equal(new Set(ids).size, ids.length, '向后翻页不重复先前的消息');
    assert.equal(page.hasAfter, false);
    const previous = store.readHistory(own.id, 'alice', { beforeMessageId: page.beforeCursor, limit: 4 });
    assert.deepEqual(previous.messages.map(row => row.message.content), contents.slice(4, 8));
    assert.ok(previous.hasBefore && previous.hasAfter);
  } finally { store.close(); }
});

test('history_read 拒绝非法分页参数，不通过 session 或锚点透露其他用户的数据', async t => {
  const root = mkdtempSync(join(tmpdir(), 'hermes-recall-guard-'));
  const store = new SessionStore(':memory:');
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const own = store.getOrCreate('own', 'alice'), foreign = store.getOrCreate('foreign', 'bob');
  store.appendMessages(own.id, [{ role: 'user', content: 'public' }]);
  store.appendMessages(foreign.id, [{ role: 'user', content: 'PRIVATE_BOB' }]);
  for (const limit of [0, -1, 51, 1.5, NaN, Infinity]) {
    assert.throws(() => store.readHistory(own.id, 'alice', { limit }));
  }
  assert.throws(() => store.readHistory(own.id, 'alice', { afterMessageId: 1, beforeMessageId: 1 }));
  assert.throws(() => store.readHistory(own.id, 'alice', { aroundMessageId: 0 }));
  const registry = buildRegistry(new LongTermMemory(root), store, new SkillCatalog([]), 'alice', loadAlgorithms('learner'));
  const call = { id: 'read', name: 'history_read', arguments: { session_id: own.id, scope: 'bob' } };
  const forbidden = JSON.parse((await registry.execute(call)).content) as { ok: boolean; message: string };
  assert.equal(forbidden.ok, false);
  assert.match(forbidden.message, /unexpected property scope/u);
  const denied = JSON.parse((await registry.execute({ id: 'denied', name: 'history_read', arguments: { session_id: foreign.id } })).content);
  const missing = JSON.parse((await registry.execute({ id: 'missing', name: 'history_read', arguments: { session_id: 'not-found' } })).content);
  assert.equal(denied.ok, false);
  assert.equal(denied.message, missing.message);
  assert.ok(!JSON.stringify(denied).includes('PRIVATE_BOB'));
});

test('进阶阶段 case 必须运行传入的 L3，不能静默改用参考排序', async () => {
  const learner = loadAlgorithms('learner');
  let calls = 0;
  const broken = { ...learner, selectMemories() { calls++; throw new Error('injected learner ranking failure'); } };
  const cases = recallCases(broken, () => {});
  const search = cases.find(item => item.name === 'L3/fts-multiword-candidates-and-stable-anchor');
  assert.ok(search);
  await assert.rejects(async () => search.run(), /injected learner ranking failure/u);
  assert.equal(calls, 1);
});
