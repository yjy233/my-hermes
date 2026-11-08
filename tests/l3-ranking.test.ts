/** L3 只重排已按 scope 召回的候选；这些测试不需要网络或真实模型密钥。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { selectMemories as learner } from '../src/learning/exercises.js';
import { selectMemories as reference } from '../src/learning/reference.js';
import type { MemoryHit } from '../src/memory/store.js';

for (const [mode, select] of [['learner', learner], ['reference', reference]] as const) {
  test(`${mode}：唯一词项命中数优先，兼容旧候选且不把 score 当作通用相关性`, () => {
    const hits: MemoryHit[] = [
      { sessionId: 'repeated', content: 'TypeScript TypeScript TypeScript', score: 999 },
      { sessionId: 'chinese', content: '记忆保存在本地', score: 200 },
      { sessionId: 'both', content: '使用 TYPESCRIPT 实现记忆', score: 0 },
    ];
    const before = structuredClone(hits);
    assert.deepEqual(select('typescript TYPESCRIPT 记忆', hits, 10).map(hit => hit.sessionId),
      ['both', 'repeated', 'chinese']);
    assert.deepEqual(hits, before);
  });

  test(`${mode}：同来源 BM25 越小越好，跨来源维持原槽位，缺失 rank 不被隐式当成零`, () => {
    const hits: MemoryHit[] = [
      { sessionId: 'fts-weaker', content: 'agent memory', score: 1, source: 'fts5', rank: -1 },
      { sessionId: 'literal', content: 'agent memory', score: 1, source: 'like', rank: -9999 },
      { sessionId: 'fts-stronger', content: 'agent memory', score: 1, source: 'fts5', rank: -9 },
      { sessionId: 'tri-weaker', content: 'agent memory', score: 1, source: 'trigram', rank: -3 },
      { sessionId: 'missing', content: 'agent memory', score: 1, source: 'fts5' },
      { sessionId: 'tri-stronger', content: 'agent memory', score: 1, source: 'trigram', rank: -20 },
    ];
    const before = structuredClone(hits);
    assert.deepEqual(select('agent memory', hits, 10).map(hit => hit.sessionId),
      ['fts-stronger', 'literal', 'fts-weaker', 'tri-stronger', 'missing', 'tri-weaker']);
    assert.deepEqual(hits, before);
  });

  test(`${mode}：同词项分数时本轮 live 原文在前，更多词项命中仍优先于 live`, () => {
    const hits: MemoryHit[] = [
      { sessionId: 'history', content: 'agent memory', score: 1, source: 'fts5', rank: -100 },
      { sessionId: 'live-first', content: 'agent memory', score: 1, source: 'live' },
      { sessionId: 'history-all', content: 'agent memory TypeScript', score: 1, source: 'fts5', rank: -1 },
      { sessionId: 'live-second', content: 'agent memory', score: 1, source: 'live' },
    ];
    assert.deepEqual(select('agent memory TypeScript', hits, 10).map(hit => hit.sessionId),
      ['history-all', 'live-first', 'live-second', 'history']);
  });

  test(`${mode}：按会话与消息 ID 去重后再限制条数，不合并不同经历或无持久 ID 的消息`, () => {
    const first: MemoryHit = { sessionId: 'one', messageId: 1, content: 'agent', score: 1 };
    const second: MemoryHit = { sessionId: 'one', messageId: 2, content: 'agent', score: 1 };
    const otherSession: MemoryHit = { sessionId: 'two', messageId: 1, content: 'agent', score: 1 };
    const transientOne: MemoryHit = { sessionId: 'one', content: 'agent', score: 1, source: 'like' };
    const transientTwo: MemoryHit = { sessionId: 'one', content: 'agent', score: 1, source: 'like' };
    const hits = [first, { ...first }, second, otherSession, transientOne, transientTwo];
    const before = structuredClone(hits);
    const four = select('agent', hits, 4);
    assert.equal(four.length, 4, '不能先 slice 四条再去重，导致只剩三条');
    assert.equal(four[0], first, '同一持久身份沿用首次候选');
    assert.equal(four[1], second);
    assert.equal(four[2], otherSession, '另一个会话的同 ID 不是同一条消息');
    assert.equal(four[3], transientOne);
    assert.equal(select('agent', hits, 10).length, 5, '无 ID 的两条相同正文不能擅自合并');
    assert.deepEqual(hits, before);
  });

  test(`${mode}：BM25 同分与非有限 rank 不扰乱稳定输入顺序`, () => {
    const hits: MemoryHit[] = [
      { sessionId: 'first', content: 'agent', score: 1, source: 'fts5', rank: -5 },
      { sessionId: 'invalid', content: 'agent', score: 1, source: 'fts5', rank: Number.NaN },
      { sessionId: 'second', content: 'agent', score: 1, source: 'fts5', rank: -5 },
      { sessionId: 'infinite', content: 'agent', score: 1, source: 'fts5', rank: Number.POSITIVE_INFINITY },
    ];
    assert.deepEqual(select('agent', hits, 10).map(hit => hit.sessionId), ['first', 'invalid', 'second', 'infinite']);
    assert.ok(Number.isNaN(hits[1].rank));
  });

  test(`${mode}：空查询、符号、非法上限维持明确契约`, () => {
    const hits: MemoryHit[] = [
      { sessionId: 'plain', content: 'plain text', score: 1 },
      { sessionId: 'symbol', content: '100% complete', score: 1 },
    ];
    assert.deepEqual(select('   ', hits, 5), []);
    assert.deepEqual(select('%', hits, 0), []);
    assert.deepEqual(select('%', hits, -1), []);
    assert.equal(select('%', hits, 1)[0]?.sessionId, 'symbol');
    for (const limit of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5]) {
      assert.throws(() => select('plain', hits, limit), RangeError);
    }
  });
}
