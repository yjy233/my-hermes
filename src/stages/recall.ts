/**
 * L3 进阶验收：真实 SQLite 候选召回 → 所选学习算法排序 → 原文窗口读取。
 *
 * 这里故意不调用 runLoop，阶段 2 不必依赖阶段 1 是否完成。
 * 模型如何连续调用 search/read，由对应集成测试通过脚本 Provider 验证。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRegistry } from '../core/builtin-tools.js';
import type { Emit, Message } from '../core/models.js';
import type { Algorithms } from '../learning/types.js';
import { LongTermMemory } from '../memory/long-term.js';
import { SessionStore, type HistoryPage, type MemoryHit } from '../memory/store.js';
import { SkillCatalog } from '../skills/catalog.js';
import type { StageCase } from './contracts.js';

function withStore(run: (store: SessionStore) => void): void {
  const store = new SessionStore(':memory:');
  try { run(store); } finally { store.close(); }
}

/** 断言检索命中提供稳定的数据库消息锚点；正文不作为身份，重复正文仍是不同记录。 */
function messageId(hit: MemoryHit): number {
  assert.ok(Number.isSafeInteger(hit.messageId) && hit.messageId! > 0, '持久历史命中必须带稳定 messageId');
  return hit.messageId!;
}

function thrownMessage(task: () => unknown): string {
  try { task(); } catch (error) {
    assert.ok(error instanceof Error);
    return error.message;
  }
  assert.fail('这次读取必须拒绝，而不是返回其他用户或其他会话的消息');
}

export function recallCases(algorithms: Algorithms, emit: Emit): StageCase[] {
  return [
    { name: 'L3/fts-multiword-candidates-and-stable-anchor', run(signal) {
      signal?.throwIfAborted();
      withStore(store => {
        const own = store.getOrCreate('own', 'alice'), foreign = store.getOrCreate('foreign', 'bob');
        const relevant = 'The memory implementation uses TypeScript and stores original messages.';
        store.appendMessages(own.id, [
          { role: 'user', content: relevant }, { role: 'assistant', content: 'TypeScript cookbook only.' },
        ]);
        store.appendMessages(foreign.id, [{ role: 'user', content: 'TypeScript memory PRIVATE_BOB' }]);
        // 两个词顺序不同、并非连续子串：旧的 LIKE 整段匹配不能通过这个验收。
        const candidates = store.search('TypeScript memory', 'alice', 20);
        const hits = algorithms.selectMemories('TypeScript memory', candidates, 5);
        assert.equal(hits.length, 1);
        assert.equal(hits[0].content, relevant);
        assert.equal(hits[0].source, 'fts5', '本机 Node SQLite 应使用真正的 FTS5 词索引');
        assert.equal(hits[0].sessionId, own.id);
        assert.equal(hits[0].role, 'user');
        messageId(hits[0]);
        assert.ok(Number.isFinite(hits[0].rank));
        emit('recall.search', { candidates: candidates.length, selected: hits.length, source: hits[0].source });
      });
    } },
    { name: 'L3/chinese-and-literal-query-fallback', run(signal) {
      signal?.throwIfAborted();
      withStore(store => {
        const session = store.getOrCreate('own', 'alice');
        store.appendMessages(session.id, [
          { role: 'user', content: '我们正在学习长期记忆检索，并保留原始对话。' },
          { role: 'assistant', content: '记录路径：100%_done；百分号和下划线都是普通文字。' },
          { role: 'user', content: '1000Zdone 不应被字面符号查询误命中。' },
        ]);
        const chinese = algorithms.selectMemories('记忆检索', store.search('记忆检索', 'alice', 20), 5);
        assert.equal(chinese.length, 1);
        assert.ok(['trigram', 'like'].includes(chinese[0].source!));
        const short = algorithms.selectMemories('记忆', store.search('记忆', 'alice', 20), 5);
        assert.equal(short.length, 1);
        assert.equal(short[0].source, 'like', '两个汉字不足以构成 trigram，必须有字面回退');
        const literal = algorithms.selectMemories('%_', store.search('%_', 'alice', 20), 5);
        assert.equal(literal.length, 1);
        assert.match(literal[0].content, /100%_done/u);
      });
    } },
    { name: 'L3/bm25-ties-and-message-identity-dedup', run(signal) {
      signal?.throwIfAborted();
      withStore(store => {
        const session = store.getOrCreate('own', 'alice');
        store.appendMessages(session.id, [
          { role: 'user', content: 'TypeScript memory' },
          { role: 'assistant', content: 'TypeScript memory ' + 'unrelated '.repeat(150) },
        ]);
        const hits = store.search('TypeScript memory', 'alice', 20);
        assert.equal(hits.length, 2);
        assert.ok(hits.every(hit => Number.isFinite(hit.rank) && hit.source === 'fts5'));
        const best = hits.reduce((left, right) => left.rank! <= right.rank! ? left : right);
        const duplicated = [hits[1], hits[0], structuredClone(hits[0])];
        const original = structuredClone(duplicated);
        const selected = algorithms.selectMemories('TypeScript memory', duplicated, 10);
        assert.equal(selected.length, 2, '数据库消息身份相同的重复候选只保留一次');
        assert.equal(messageId(selected[0]), messageId(best), '词项命中同分后，较小 BM25 rank 更相关');
        assert.deepEqual(duplicated, original, '排序不改写候选或数据库分数');
        const live: MemoryHit = { sessionId: session.id, content: 'TypeScript memory', score: 1, source: 'live' };
        assert.equal(algorithms.selectMemories('TypeScript memory', [live, ...hits], 1)[0], live,
          '同分的本轮原文不能因没有可比的数据库 BM25 而被挤掉');
      });
    } },
    { name: 'History/message-window-and-keyset-pagination', run(signal) {
      signal?.throwIfAborted();
      withStore(store => {
        const session = store.getOrCreate('own', 'alice'), other = store.getOrCreate('other', 'bob');
        for (let index = 0; index < 9; index++) {
          store.appendMessages(session.id, [{ role: index % 2 ? 'assistant' : 'user', content: `原文-${index}`,
            ...(index === 3 ? { reasoningContent: '需要保留的协议元数据' } : {}) }]);
          // 消息 ID 在全库内递增，但某个 session 的 ID 可以不连续，不能把 id 当数组下标。
          store.appendMessages(other.id, [{ role: 'user', content: `PRIVATE-${index}` }]);
        }
        const first = store.readHistory(session.id, 'alice', { limit: 3 });
        assert.equal(first.hasBefore, false); assert.equal(first.hasAfter, true);
        assert.deepEqual(first.messages.map(row => row.message.content), ['原文-0', '原文-1', '原文-2']);
        const second = store.readHistory(session.id, 'alice', { afterMessageId: first.afterCursor, limit: 3 });
        assert.deepEqual(second.messages.map(row => row.message.content), ['原文-3', '原文-4', '原文-5']);
        assert.equal(second.messages[0].message.reasoningContent, '需要保留的协议元数据');
        const previous = store.readHistory(session.id, 'alice', { beforeMessageId: second.beforeCursor, limit: 3 });
        assert.deepEqual(previous.messages, first.messages);
        const window = store.readHistory(session.id, 'alice', { aroundMessageId: second.messages[1].id, limit: 3 });
        assert.ok(window.messages.some(row => row.id === second.messages[1].id));
        assert.ok(window.messages.every(row => row.sessionId === session.id));
        assert.ok(window.messages.every((row, index, rows) => index === 0 || rows[index - 1].id < row.id));
        emit('recall.window', { messages: window.messages.length, hasBefore: window.hasBefore, hasAfter: window.hasAfter });
      });
    } },
    { name: 'History/window-scope-and-anchor-isolation', run(signal) {
      signal?.throwIfAborted();
      withStore(store => {
        const own = store.getOrCreate('own', 'alice'), second = store.getOrCreate('second', 'alice');
        const foreign = store.getOrCreate('foreign', 'bob');
        for (const session of [own, second, foreign]) store.appendMessages(session.id, [{ role: 'user', content: session.key }]);
        const missing = thrownMessage(() => store.readHistory('missing-session', 'alice'));
        const denied = thrownMessage(() => store.readHistory(foreign.id, 'alice'));
        assert.equal(denied, missing, '拒绝时不能透露该会话是否属于别的用户');
        const wrongAnchor = store.readHistory(second.id, 'alice').messages[0].id;
        assert.throws(() => store.readHistory(own.id, 'alice', { aroundMessageId: wrongAnchor }),
          '属于自己另一个会话的消息，也不能冒充目标会话的锚点');
      });
    } },
    { name: 'History/history-tools-search-then-read', async run(signal) {
      signal?.throwIfAborted();
      const root = mkdtempSync(join(tmpdir(), 'hermes-recall-stage-'));
      const store = new SessionStore(':memory:');
      try {
        const session = store.getOrCreate('own', 'alice');
        store.appendMessages(session.id, [
          { role: 'user', content: '部署前先确认配置。' },
          { role: 'assistant', content: 'memory implementation uses TypeScript，验证编号 B-42。' },
          { role: 'user', content: '继续检查部署后的日志。' },
        ]);
        const registry = buildRegistry(new LongTermMemory(join(root, 'memory')), store,
          new SkillCatalog([]), 'alice', algorithms);
        const search = await registry.execute({ id: 'search', name: 'history_search', arguments: { query: 'TypeScript memory' } }, signal);
        const payload = JSON.parse(search.content) as { ok: boolean; result: MemoryHit[] };
        assert.equal(payload.ok, true);
        assert.equal(payload.result.length, 1);
        const hit = payload.result[0];
        const read = await registry.execute({ id: 'read', name: 'history_read', arguments: {
          session_id: hit.sessionId, around_message_id: messageId(hit), limit: 3,
        } }, signal);
        const page = JSON.parse(read.content) as { ok: boolean; result: HistoryPage };
        assert.equal(page.ok, true);
        assert.ok(page.result.messages.some(row => row.message.content.includes('B-42')));
        assert.equal(read.toolCallId, 'read');
        assert.deepEqual(store.loadMessages(session.id).map(row => row.content), [
          '部署前先确认配置。', 'memory implementation uses TypeScript，验证编号 B-42。', '继续检查部署后的日志。',
        ], '读取窗口不会把检索结果写回原始历史');
      } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
    } },
  ];
}
