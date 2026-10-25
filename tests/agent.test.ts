/** 在可替换的算法边界注入故障，并使用真实的本地持久化存储进行测试。 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { Agent, BudgetProvider, validateTurn, type AgentOptions } from '../src/core/agent.js';
import { ContextBudgetExceeded, TimeoutError } from '../src/core/errors.js';
import { messageSize, type Message, type ModelResponse, type Provider, type ToolSchema } from '../src/core/models.js';
import type { Algorithms, Mode } from '../src/learning/index.js';
import * as reference from '../src/learning/reference.js';
import { LongTermMemory, SessionStore } from '../src/memory/index.js';
import { SkillCatalog } from '../src/skills/index.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(fulfill => { resolve = fulfill; });
  return { promise, resolve };
}

function fixture(t: TestContext, provider: Provider,
  overrides: Partial<Omit<AgentOptions, 'provider' | 'store' | 'memory' | 'skills'>> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'my-hermes-agent-'));
  const store = new SessionStore(join(root, 'sessions.db'));
  const memory = new LongTermMemory(join(root, 'memory'));
  const skills = new SkillCatalog([join(root, 'skills')]);
  const agent = new Agent({ provider, store, memory, skills, ...overrides });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, agent, messages: () => store.loadMessages(store.getOrCreate('session', 'alice').id) };
}

/** 不修改学习者源码或全局模块，模拟已完成或存在缺陷的练习实现。 */
function injectAlgorithms(agent: Agent, overrides: Partial<Algorithms>): void {
  (agent as unknown as { algorithms: Algorithms }).algorithms = { ...reference, ...overrides };
}

test('request budget includes serialized tool schemas, allowing the exact bound only', async () => {
  let calls = 0;
  const delegate: Provider = { async complete() { calls++; return { content: 'ok' }; } };
  const messages: Message[] = [{ role: 'user', content: 'short input' }];
  const tools: ToolSchema[] = [{ type: 'function', function: {
    name: 'large_schema', description: 'documentation'.repeat(100), parameters: { type: 'object' },
  } }];
  const exact = messages.reduce((size, message) => size + messageSize(message), 0) + JSON.stringify(tools).length;
  await assert.rejects(() => new BudgetProvider(delegate, exact - 1).complete(messages, tools), ContextBudgetExceeded);
  assert.equal(calls, 0);
  assert.deepEqual(await new BudgetProvider(delegate, exact).complete(messages, tools), { content: 'ok' });
  assert.equal(calls, 1);
});

test('tool schemas exceeding the Agent budget prevent model calls and successful persistence', async t => {
  let calls = 0;
  const provider: Provider = { async complete() { calls++; return { content: 'should not execute' }; } };
  const { agent, messages } = fixture(t, provider, { contextChars: 1000 });
  await assert.rejects(() => agent.run('session', 'alice', 'hello'), ContextBudgetExceeded);
  assert.equal(calls, 0);
  assert.deepEqual(messages(), []);
});

for (const mode of ['reference', 'learner'] as const satisfies readonly Mode[]) {
  test(`oversized provider final cannot be persisted in ${mode} mode`, async t => {
    const provider: Provider = { async complete() { return { content: 'x'.repeat(16_001) }; } };
    const { agent, messages } = fixture(t, provider, { mode });
    // learner 中通常保留待实现的练习；这里提供已完成的循环，
    // 验证它发出的模型请求经过实际运行时同一个 BudgetProvider 包装层。
    if (mode === 'learner') injectAlgorithms(agent, {});
    await assert.rejects(() => agent.run('session', 'alice', 'hello'), /content exceeds/);
    assert.deepEqual(messages(), []);
  });
}

test('observer exceptions after persistence cannot turn a completed turn into failure', async t => {
  const observed: string[] = [];
  t.mock.method(console, 'warn', () => undefined);
  const provider: Provider = { async complete() { return { content: 'saved answer' }; } };
  const { agent, messages } = fixture(t, provider, { emit: event => {
    observed.push(event);
    throw new Error('broken observer');
  } });
  assert.equal(await agent.run('session', 'alice', 'hello'), 'saved answer');
  assert.ok(observed.includes('turn.persisted'));
  assert.deepEqual(messages().map(message => message.content), ['hello', 'saved answer']);
});

test('total turn timeout releases the session and cannot persist a later stale model response', async t => {
  const firstResponse = deferred<ModelResponse>(), started = deferred<void>();
  let calls = 0;
  const events: string[] = [];
  const provider: Provider = { async complete() {
    if (++calls === 1) { started.resolve(); return firstResponse.promise; }
    return { content: 'current answer' };
  } };
  const { agent, messages } = fixture(t, provider, { turnTimeoutMs: 10, emit: event => events.push(event) });
  const first = agent.run('session', 'alice', 'stale user request');
  await started.promise;
  await assert.rejects(first, TimeoutError);
  assert.deepEqual(messages(), []);
  assert.equal(events.includes('turn.persisted'), false);
  assert.equal(await agent.run('session', 'alice', 'current request'), 'current answer');
  firstResponse.resolve({ content: 'too late to save' });
  await nextTurn();
  assert.deepEqual(messages().map(message => message.content), ['current request', 'current answer']);
  assert.equal(events.filter(event => event === 'turn.persisted').length, 1);
});

test('caller cancellation propagates its reason and ignores a provider that completes later', async t => {
  const response = deferred<ModelResponse>(), started = deferred<void>();
  const events: string[] = [];
  const provider: Provider = { async complete() { started.resolve(); return response.promise; } };
  const { agent, messages } = fixture(t, provider, { emit: event => events.push(event) });
  const controller = new AbortController(), reason = new Error('caller canceled');
  const running = agent.run('session', 'alice', 'cancel me', controller.signal);
  await started.promise;
  controller.abort(reason);
  await assert.rejects(running, error => error === reason);
  response.resolve({ content: 'late ignored answer' });
  await nextTurn();
  assert.deepEqual(messages(), []);
  assert.equal(events.includes('turn.persisted'), false);
});

const called: Message = {
  role: 'assistant', content: '', toolCalls: [{ id: 'expected', name: 'calculator', arguments: { expression: '2+2' } }],
};
const result: Message = { role: 'tool', content: '{"ok":true,"result":4}', toolCallId: 'expected' };
const final: Message = { role: 'assistant', content: '4' };
const malformedTurns: Array<[string, Message[], RegExp]> = [
  ['missing result', [called, final], /Missing tool results/],
  ['orphan result', [result, final], /Orphan/],
  ['wrong result ID', [called, { ...result, toolCallId: 'wrong' }, final], /Orphan/],
  ['duplicate result', [called, result, result, final], /Orphan/],
  ['unresolved final call', [called], /end with an assistant final/],
  ['returned user message', [{ role: 'user', content: 'duplicate input' }, final], /only new assistant\/tool/],
  ['bypassed final response bound', [{ role: 'assistant', content: 'x'.repeat(16_001) }], /content exceeds/],
];
for (const [name, delta, pattern] of malformedTurns) {
  test(`malformed learner turn is rejected before persistence: ${name}`, async t => {
    assert.throws(() => validateTurn(delta), pattern);
    const provider: Provider = { async complete() { throw new Error('faulty learner should not call the model'); } };
    const { agent, messages } = fixture(t, provider, { mode: 'learner' });
    injectAlgorithms(agent, { async runLoop() { return structuredClone(delta); } });
    await assert.rejects(() => agent.run('session', 'alice', 'exercise input'), pattern);
    assert.deepEqual(messages(), []);
  });
}

test('plugin top-level load failure never writes a successful model turn', async t => {
  let modelCalls = 0;
  const provider: Provider = { async complete() { modelCalls++; return { content: 'must not save' }; } };
  const root = mkdtempSync(join(tmpdir(), 'my-hermes-broken-plugin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plugin = join(root, 'broken.mjs');
  writeFileSync(plugin, 'throw new Error("plugin initialization failed");\nexport function register() {}\n');
  const events: string[] = [];
  const { agent, messages } = fixture(t, provider, { plugins: [plugin], emit: event => events.push(event) });
  await assert.rejects(() => agent.run('session', 'alice', 'hello'), /plugin initialization failed/);
  assert.equal(modelCalls, 0);
  assert.deepEqual(messages(), []);
  assert.equal(events.includes('turn.persisted'), false);
});
