/** 直接验证已完成的 L2/L3，并用真实 SQLite 和 Markdown 记忆串起 learner Agent。 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Agent } from '../src/core/agent.js';
import { ContextBudgetExceeded } from '../src/core/errors.js';
import { messageSize, type Message, type Provider, type ToolSchema } from '../src/core/models.js';
import { DemoProvider } from '../src/core/providers.js';
import { compactHistory, selectMemories } from '../src/learning/exercises.js';
import { LongTermMemory, SessionStore, type MemoryHit } from '../src/memory/index.js';
import { SkillCatalog } from '../src/skills/index.js';

function size(messages: Message[]): number {
  return messages.reduce((total, message) => total + messageSize(message), 0);
}

function multiToolTurn(): Message[] {
  return [
    { role: 'user', content: '请完成两次计算。' },
    { role: 'assistant', content: '先运行两个计算工具。', reasoningContent: '需要保留的模型协议元数据', toolCalls: [
      { id: 'sum-call', name: 'calculator', arguments: { expression: '2+3' } },
      { id: 'product-call', name: 'calculator', arguments: { expression: '(2+3)*4' } },
    ] },
    { role: 'tool', content: '{"ok":true,"result":5}', toolCallId: 'sum-call' },
    { role: 'tool', content: '{"ok":true,"result":20}', toolCallId: 'product-call' },
    { role: 'assistant', content: '两个结果分别是 5 和 20。', reasoningContent: '' },
  ];
}

test('L2 按精确预算保留完整多工具轮次、调用 ID 与思考元数据，且不修改输入', () => {
  const system: Message = { role: 'system', content: '固定系统提示。' };
  const latest = multiToolTurn();
  const input: Message[] = [system, { role: 'user', content: '旧问题' },
    { role: 'assistant', content: '旧答复'.repeat(1000) }, ...latest];
  const original = structuredClone(input), expected = structuredClone([system, ...latest]);
  const result = compactHistory(input, size(expected));
  assert.deepEqual(result, expected);
  assert.equal(size(result), size(expected));
  assert.deepEqual(result[2].toolCalls?.map(call => call.id), ['sum-call', 'product-call']);
  assert.deepEqual(result.filter(message => message.role === 'tool').map(message => message.toolCallId),
    ['sum-call', 'product-call']);
  assert.equal(result[2].reasoningContent, '需要保留的模型协议元数据');
  assert.equal(result.at(-1)?.reasoningContent, '');
  assert.deepEqual(input, original);
});

test('L2 只有 system 时也按序列化大小计算精确预算并拒绝溢出', () => {
  const system: Message = { role: 'system', content: '短提示' };
  const input = [system], original = structuredClone(input);
  assert.deepEqual(compactHistory(input, messageSize(system)), original);
  assert.throws(() => compactHistory(input, messageSize(system) - 1), ContextBudgetExceeded);
  assert.deepEqual(input, original);
});

test('L2 最新完整轮次放不下时明确报错，不丢掉新问题或只留下部分 tool 结果', () => {
  const system: Message = { role: 'system', content: '固定提示。' };
  const newest = multiToolTurn();
  const input: Message[] = [system, { role: 'user', content: '旧的短轮次' }, ...newest];
  const original = structuredClone(input);
  assert.throws(() => compactHistory(input, size([system, ...newest]) - 1), ContextBudgetExceeded);
  assert.deepEqual(input, original);
});

test('L2 连续保留历史后缀，不越过中间大轮次捡回更早的小轮次', () => {
  const system: Message = { role: 'system', content: '固定提示。' };
  const oldest: Message = { role: 'user', content: '很早的小问题' };
  const middle: Message[] = [{ role: 'user', content: '中间问题' }, { role: 'assistant', content: 'x'.repeat(3000) }];
  const newest: Message[] = [{ role: 'user', content: '最新问题' }, { role: 'assistant', content: '最新答复' }];
  const input = [system, oldest, ...middle, ...newest], original = structuredClone(input);
  assert.deepEqual(compactHistory(input, size([system, oldest, ...newest])), [system, ...newest]);
  assert.deepEqual(input, original);
});

test('L2 拒绝非正数、非有限数、非安全整数预算及缺少 system 的输入', () => {
  const input: Message[] = [{ role: 'system', content: '提示。' }];
  for (const budget of [0, -1, -100, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
    0.5, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => compactHistory(input, budget));
  assert.throws(() => compactHistory([], 1000));
  assert.throws(() => compactHistory([{ role: 'user', content: '没有系统提示' }], 1000));
  assert.throws(() => compactHistory([input[0], { role: 'tool', content: '{}', toolCallId: 'orphan' }], 1000));
});

test('L3 每个不同查询词只计一次，忽略大小写，并稳定保留同分候选的原顺序', () => {
  const hits: MemoryHit[] = [
    { sessionId: 'repeated', content: 'TypeScript TypeScript TypeScript', score: 1 },
    { sessionId: 'first', content: 'TypeScript agent', score: 1 },
    { sessionId: 'second', content: 'AGENT and TYPESCRIPT', score: 1 },
    { sessionId: 'unrelated', content: 'gardening', score: 1 },
  ];
  const original = structuredClone(hits);
  assert.deepEqual(selectMemories('TYPESCRIPT agent TYPESCRIPT', hits, 3).map(hit => hit.sessionId),
    ['first', 'second', 'repeated']);
  assert.deepEqual(selectMemories('TypeScript agent', hits, 1).map(hit => hit.sessionId), ['first']);
  assert.deepEqual(hits, original);
});

test('L3 支持 Unicode 查询词和下划线，不把重复出现次数当成额外权重', () => {
  const hits: MemoryHit[] = [
    { sessionId: 'only-chinese', content: '学习学习学习', score: 1 },
    { sessionId: 'split-identifier', content: '学习 agent 2', score: 1 },
    { sessionId: 'complete', content: '学习 AGENT_2 CAFÉ', score: 1 },
    { sessionId: 'two-terms', content: 'agent_2 café', score: 1 },
  ];
  assert.deepEqual(selectMemories('学习 AGENT_2 café 学习', hits, 4).map(hit => hit.sessionId),
    ['complete', 'two-terms', 'only-chinese', 'split-identifier']);
});

test('L3 空查询或只有分隔符时保持候选原有的最近顺序，并返回独立数组', () => {
  const hits: MemoryHit[] = [
    { sessionId: 'newest', content: '最新记录', score: 1 },
    { sessionId: 'older', content: '较早记录', score: 1 },
    { sessionId: 'oldest', content: '最早记录', score: 1 },
  ];
  const original = structuredClone(hits);
  for (const query of ['', '   ', '--- !!!']) {
    const selected = selectMemories(query, hits, 2);
    assert.deepEqual(selected, original.slice(0, 2));
    assert.notEqual(selected, hits);
  }
  assert.deepEqual(hits, original);
});

test('L3 非正整数上限返回空数组，非有限或非整数上限明确报错', () => {
  const hits: MemoryHit[] = [{ sessionId: 'one', content: 'TypeScript', score: 1 }];
  for (const limit of [0, -1, -100]) assert.deepEqual(selectMemories('TypeScript', hits, limit), []);
  for (const limit of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.5, 1.5, -1.5]) {
    assert.throws(() => selectMemories('TypeScript', hits, limit));
  }
  assert.deepEqual(selectMemories('TypeScript', [], 5), []);
});

interface CapturedRequest { messages: Message[]; tools: ToolSchema[] }
function fixture(t: TestContext, contextChars = 24_000) {
  const root = mkdtempSync(join(tmpdir(), 'hermes-learner-memory-'));
  const store = new SessionStore(join(root, 'sessions.db'));
  const memory = new LongTermMemory(join(root, 'memory'));
  const skills = new SkillCatalog([join(root, 'skills')]);
  const demo = new DemoProvider(), requests: CapturedRequest[] = [];
  const provider: Provider = { async complete(messages, tools, signal) {
    requests.push({ messages: structuredClone(messages), tools: structuredClone(tools) });
    return demo.complete(messages, tools, signal);
  } };
  // 直接使用 Agent，绕过尚未实现的 Gateway L4；这里没有替换任何 learner 算法。
  const agent = new Agent({ provider, store, memory, skills, mode: 'learner', contextChars,
    compression: { enabled: false } });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, memory, agent, requests };
}

function lastToolResult(store: SessionStore, key: string, scope: string) {
  const messages = store.loadMessages(store.getOrCreate(key, scope).id);
  const tool = messages.filter(message => message.role === 'tool').at(-1);
  assert.ok(tool, '本次场景应产生真实工具结果');
  return { messages, tool, payload: JSON.parse(tool.content) as { ok: boolean; result: unknown } };
}

test('learner Agent 跨会话记住同一 scope 的偏好，并隔离其他用户的长期记忆', async t => {
  const { store, memory, agent } = fixture(t);
  const preference = '我喜欢 TypeScript，并用中文写学习笔记。';
  await agent.run('alice-first', 'alice', `/remember ${preference}`);
  const first = store.getOrCreate('alice-first', 'alice');
  assert.ok(first.systemPrompt);
  const frozenPrompt = first.systemPrompt;
  assert.equal(frozenPrompt.includes(preference), false);
  assert.equal(memory.read('alice', 'MEMORY.md'), preference);
  await agent.run('alice-first', 'alice', '/memory');
  assert.equal(lastToolResult(store, 'alice-first', 'alice').payload.result, preference);
  assert.equal(store.getOrCreate('alice-first', 'alice').systemPrompt, frozenPrompt);
  await agent.run('alice-new-session', 'alice', '/memory');
  assert.equal(lastToolResult(store, 'alice-new-session', 'alice').payload.result, preference);
  assert.ok(store.getOrCreate('alice-new-session', 'alice').systemPrompt?.includes(preference));
  await agent.run('bob-first', 'bob', '/memory');
  assert.equal(lastToolResult(store, 'bob-first', 'bob').payload.result, '');
  assert.equal(store.getOrCreate('bob-first', 'bob').systemPrompt?.includes(preference), false);
  assert.deepEqual(store.search('TypeScript', 'bob'), []);
});

test('learner Agent 的 /recall 经过真实 history_search 和 L3，并保持历史用户隔离', async t => {
  const { store, agent } = fixture(t);
  const query = 'learner_recall_marker';
  for (let index = 1; index <= 3; index++) await agent.run('alice-source', 'alice', `${query} Alice 的第 ${index} 条记录`);
  await agent.run('bob-source', 'bob', `${query} Bob 的私有记录`);
  const candidates = store.search(query, 'alice', 20);
  assert.equal(candidates.length, 6);
  await agent.run('alice-recall', 'alice', `/recall ${query}`);
  const { messages, payload, tool } = lastToolResult(store, 'alice-recall', 'alice');
  assert.equal(messages[1].toolCalls?.[0].name, 'history_search');
  assert.equal(messages[1].toolCalls?.[0].id, tool.toolCallId);
  assert.equal(payload.ok, true, '未实现 L3 时 Registry 会返回 ok:false，不能把它当作召回成功');
  assert.deepEqual(payload.result, candidates.slice(0, 5));
  assert.ok(!(payload.result as MemoryHit[]).some(hit => hit.content.includes('Bob')));
  await agent.run('bob-recall', 'bob', `/recall ${query}`);
  const bob = lastToolResult(store, 'bob-recall', 'bob').payload;
  assert.equal(bob.ok, true);
  assert.ok((bob.result as MemoryHit[]).every(hit => hit.sessionId === store.getOrCreate('bob-source', 'bob').id));
});

test('learner Agent 裁剪 Provider 上下文后，SQLite 仍保留完整原始历史和最新工具轨迹', async t => {
  const contextChars = 6000;
  const { store, agent, requests } = fixture(t, contextChars);
  const session = store.getOrCreate('trim-session', 'alice');
  store.setSystemPrompt(session.id, '固定的测试系统提示。');
  const seeded: Message[] = [
    { role: 'user', content: 'archived_only_marker 旧问题' },
    { role: 'assistant', content: '旧历史正文'.repeat(2500) },
    { role: 'user', content: '最近的问题' },
    { role: 'assistant', content: '最近的答复', reasoningContent: '最近轮次的协议元数据' },
  ];
  store.appendMessages(session.id, seeded);
  await agent.run('trim-session', 'alice', '/calc 2+3');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].messages.map(message => message.role), ['system', 'user', 'assistant', 'user']);
  assert.ok(!requests[0].messages.some(message => message.content.includes('archived_only_marker')));
  assert.equal(requests[0].messages[2].reasoningContent, '最近轮次的协议元数据');
  for (const request of requests) {
    assert.ok(size(request.messages) + JSON.stringify(request.tools).length <= contextChars);
  }
  const persisted = store.loadMessages(session.id);
  assert.deepEqual(persisted.slice(0, seeded.length), seeded);
  assert.equal(persisted.length, seeded.length + 4);
  assert.equal(persisted.at(-3)?.toolCalls?.[0].id, persisted.at(-2)?.toolCallId);
  assert.equal(JSON.parse(persisted.at(-2)!.content).result, 5);
  assert.equal(store.search('archived_only_marker', 'alice').length, 1);
});
