/** 工具层预算属于真实协议边界：缩短正文后，锚点和续读能力仍必须可用。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHistoryTools } from '../src/core/history-tools.js';
import { ToolRegistry } from '../src/core/tools.js';
import { loadAlgorithms } from '../src/learning/index.js';
import { SessionStore, type HistoryMessage, type MemoryHit } from '../src/memory/store.js';

interface Preview extends HistoryMessage {
  contentOffset: number; originalContentChars: number; contentTruncated: boolean; nextContentOffset?: number;
}

test('搜索在实际 JSON 预算内保留数组和锚点，长原文可继续读取', async t => {
  const store = new SessionStore(':memory:'); t.after(() => store.close());
  const session = store.getOrCreate('old', 'alice');
  const original = 'TypeScript memory ' + '\n"\\🙂'.repeat(1500);
  store.appendMessages(session.id, [{ role: 'user', content: original }]);
  const registry = new ToolRegistry(1400);
  registerHistoryTools(registry, store, 'alice', loadAlgorithms('learner'));
  const search = await registry.execute({ id: 'search', name: 'history_search', arguments: { query: 'TypeScript memory' } });
  const payload = JSON.parse(search.content) as { ok: boolean; result: MemoryHit[] };
  assert.ok(payload.ok && Array.isArray(payload.result));
  assert.ok(search.content.length <= registry.maxOutputChars);
  const hit = payload.result[0];
  assert.equal(hit.contentTruncated, true);
  assert.equal(hit.originalContentChars, original.length);
  assert.ok(hit.messageId);
  assert.ok(!/[\ud800-\udbff]$/u.test(hit.content), '预览末尾不能留下半个emoji');
  const read = await registry.execute({ id: 'read', name: 'history_read', arguments: {
    session_id: hit.sessionId, around_message_id: hit.messageId, limit: 1,
  } });
  const page = JSON.parse(read.content);
  assert.equal(page.ok, true);
  assert.equal(page.result.messages[0].id, hit.messageId);
  assert.ok(page.result.messages[0].nextContentOffset > 0);
  assert.equal(store.loadMessages(session.id)[0].content, original, '预览不能覆盖持久原文');
});

test('按正文 offset 续读能无损拼回 Unicode 原文，历史推理与旧工具参数不进入模型预览', async t => {
  const store = new SessionStore(':memory:'); t.after(() => store.close());
  const session = store.getOrCreate('old', 'alice');
  const original = '🙂中文\n"\\'.repeat(120);
  store.appendMessages(session.id, [{ role: 'assistant', content: original,
    reasoningContent: 'PRIVATE_REASONING', toolCalls: [{ id: 'old-call', name: 'calculator', arguments: { private: 'PRIVATE_ARGS' } }] }]);
  const id = store.readHistory(session.id, 'alice').messages[0].id;
  const registry = new ToolRegistry(1100);
  registerHistoryTools(registry, store, 'alice', loadAlgorithms('learner'));
  let offset = 0, restored = '', finished = false;
  for (let attempts = 0; attempts < 30; attempts++) {
    const reply = await registry.execute({ id: 'read', name: 'history_read', arguments: {
      session_id: session.id, around_message_id: id, limit: 1, content_offset: offset, content_chars: 6000,
    } });
    assert.ok(reply.content.length <= registry.maxOutputChars);
    assert.ok(!reply.content.includes('PRIVATE_REASONING') && !reply.content.includes('PRIVATE_ARGS'));
    const payload = JSON.parse(reply.content) as { ok: boolean; result: { messages: Preview[] } };
    assert.equal(payload.ok, true);
    const row = payload.result.messages[0];
    assert.equal(row.contentOffset, offset); assert.equal(row.originalContentChars, original.length);
    restored += row.message.content;
    if (row.nextContentOffset === undefined) { finished = true; break; }
    assert.ok(row.nextContentOffset > offset, '每个成功续读必须前进');
    offset = row.nextContentOffset;
  }
  assert.ok(finished); assert.equal(restored, original);
  assert.equal(store.readHistory(session.id, 'alice').messages[0].message.reasoningContent, 'PRIVATE_REASONING');
});

test('正文范围和极小预算错误成为可观察失败，不能返回永远不前进的成功游标', async t => {
  const store = new SessionStore(':memory:'); t.after(() => store.close());
  const session = store.getOrCreate('old', 'alice');
  store.appendMessages(session.id, [{ role: 'user', content: '🙂hello' }]);
  const id = store.readHistory(session.id, 'alice').messages[0].id;
  const registry = new ToolRegistry();
  registerHistoryTools(registry, store, 'alice', loadAlgorithms('learner'));
  const args = { session_id: session.id, around_message_id: id, limit: 1 };
  for (const extra of [{ content_offset: 1 }, { content_offset: 99 }, { content_chars: 1 },
    { content_chars: 6001 }, { content_offset: 2, limit: 2 }, { content_offset: -1 }]) {
    const reply = JSON.parse((await registry.execute({ id: 'bad', name: 'history_read', arguments: { ...args, ...extra } })).content);
    assert.equal(reply.ok, false);
  }
  const tiny = new ToolRegistry(200);
  registerHistoryTools(tiny, store, 'alice', loadAlgorithms('learner'));
  const reply = await tiny.execute({ id: 'small', name: 'history_read', arguments: args });
  assert.equal(JSON.parse(reply.content).ok, false);
  assert.ok(reply.content.length <= 200);
});
