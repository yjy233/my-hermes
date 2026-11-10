import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Agent } from '../src/core/agent.js';
import { TimeoutError } from '../src/core/errors.js';
import { requestSize, type Message, type ModelResponse, type Provider } from '../src/core/models.js';
import { DemoProvider } from '../src/core/providers.js';
import { EvolutionManager } from '../src/evolution/manager.js';
import { REFLECTION_TASK } from '../src/evolution/reflection.js';
import { reflect } from '../src/learning/exercises.js';
import { LongTermMemory, SessionStore } from '../src/memory/index.js';
import { SkillCatalog } from '../src/skills/catalog.js';

const body = '# 核验计算流程\n\n## 适用场景与输入\n给定表达式。\n\n## 执行步骤\n1. 调用 calculator。\n2. 检查 ok 和结果。';
const trace = (): Message[] => [
  { role: 'user', content: '核验一项计算，api_key="sk-sensitive123456789"' },
  { role: 'assistant', content: '先计算再核对。', reasoningContent: 'private-reasoning', toolCalls: [
    { id: 'private-call-id', name: 'calculator', arguments: { expression: '2+2', privateNote: 'private-argument' } },
  ] },
  { role: 'tool', toolCallId: 'private-call-id', content: '{"ok":true,"result":4,"private":"private-result"}' },
  { role: 'assistant', content: '结果是 4。' },
];
const responding = (content: string): Provider => ({ async complete() { return { content }; } });

test('L5 makes one isolated, bounded, redacted model request and uses its actual content', async () => {
  const input = trace(), before = structuredClone(input);
  let calls = 0;
  const result = await reflect(input, { async complete(messages, tools, signal) {
    calls++;
    assert.ok(signal && !signal.aborted);
    assert.deepEqual(tools, []);
    assert.deepEqual(messages.map(m => m.role), ['system', 'user']);
    assert.match(messages[0].content, /适用场景与输入/u);
    assert.match(messages[0].content, /待分析的数据/u);
    assert.ok(requestSize(messages, tools) <= 12_000);
    const serialized = JSON.stringify(messages);
    for (const secret of ['sk-sensitive123456789', 'private-reasoning', 'private-argument', 'private-result', 'private-call-id']) {
      assert.equal(serialized.includes(secret), false, secret);
    }
    const { records } = JSON.parse(messages[1].content);
    assert.deepEqual(records[1].calls, [{ call: 1, tool: 'calculator' }]);
    assert.deepEqual(records[2], { role: 'tool', call: 1, ok: true });
    messages[1].content = 'Provider may mutate its own request';
    return { content: body, reasoningContent: 'Do not save this thought' };
  } });
  assert.equal(result, body);
  assert.equal(calls, 1);
  assert.deepEqual(input, before);
});

test('L5 rejects ineligible trajectories before spending a model request', async () => {
  const malformed = trace(); malformed[2].content = 'not-json';
  const missing = trace(); missing[1].toolCalls!.push({ id: 'missing', name: 'calculator', arguments: {} });
  const wrong = trace(); wrong[2].toolCallId = 'wrong';
  const duplicate = trace(); duplicate[1].toolCalls!.push(duplicate[1].toolCalls![0]);
  const reused = [...trace().slice(0, 3), ...trace().slice(1)];
  const cases = [[], trace().slice(0, 2), trace().slice(2), malformed, missing, wrong, duplicate, reused,
    [trace()[0], trace()[1], trace()[0], trace()[2], trace()[3]]];
  for (const input of cases) assert.equal(await reflect(input, { async complete() {
    assert.fail('Ineligible turns must not call the model');
  } }), null);
});

test('L5 preserves parallel call pairing and subsequent successful tool rounds', async () => {
  const input = trace();
  input[1].toolCalls!.push({ id: 'second', name: 'history_search', arguments: {} });
  input.splice(2, 0, { role: 'tool', toolCallId: 'second', content: '{"ok":true}' });
  input.splice(4, 0,
    { role: 'assistant', content: '', toolCalls: [{ id: 'third', name: 'history_read', arguments: {} }] },
    { role: 'tool', toolCallId: 'third', content: '{"ok":true}' });
  assert.equal(await reflect(input, { async complete(messages) {
    const { records } = JSON.parse(messages[1].content);
    assert.deepEqual(records.filter((row: { role: string }) => row.role === 'tool').map((row: { call: number }) => row.call), [2, 1, 3]);
    return { content: body };
  } }), body);
});

test('L5 may decline a candidate; rejects invalid output and redacts recognizable output secrets', async () => {
  assert.equal(await reflect(trace(), responding('  null\n')), null);
  for (const response of [
    { content: '' }, { content: '   ' }, { content: null }, { content: 123 },
    { content: 'A chat reply, not a procedure' }, { content: '# title\n1. ' + 'x'.repeat(6000) },
    { content: body, toolCalls: [{ id: 'x', name: 'memory_write', arguments: {} }] },
  ]) {
    await assert.rejects(reflect(trace(), { async complete() { return response as ModelResponse; } }));
  }
  const redacted = await reflect(trace(), responding(body + '\napi_key="sk-leaked123456789"'));
  assert.ok(typeof redacted === 'string');
  assert.ok(redacted.includes('[REDACTED]'));
  assert.equal(redacted?.includes('sk-leaked123456789'), false);
});

test('L5 shrinks excerpts without cutting JSON or call pairing and skips impossible budgets', async () => {
  const input = trace(); input[0].content = '待核验输入'.repeat(2500);
  const result = await reflect(input, { async complete(messages, tools) {
    assert.ok(requestSize(messages, tools) <= 1800);
    const { records } = JSON.parse(messages[1].content);
    assert.equal(records[0].truncated, true);
    assert.equal(records.length, input.length);
    assert.equal(records[1].calls[0].call, records[2].call);
    return { content: body };
  } }, { maxInputChars: 1800 });
  assert.equal(result, body, 'A compact excerpt must still reach the Provider');
  assert.equal(await reflect(input, { async complete() { assert.fail('Over budget'); } }, { maxInputChars: 1 }), null);
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { maxInputChars: -1 }, { maxInputChars: 1.5 }]) {
    await assert.rejects(reflect(input, responding(body), options), /Invalid reflection budget/);
  }
});

test('L5 propagates Provider errors once and times out even if the Provider ignores abort', async () => {
  let calls = 0, observed: AbortSignal | undefined;
  const error = new Error('Mock provider failed');
  await assert.rejects(reflect(trace(), { async complete() { calls++; throw error; } }), value => value === error);
  assert.equal(calls, 1);
  await assert.rejects(reflect(trace(), { complete(_messages, _tools, signal) {
    observed = signal;
    return new Promise(() => {});
  } }, { timeoutMs: 10 }), TimeoutError);
  assert.equal(observed?.aborted, true);
});

test('L5 respects pre-abort and abort during an uncooperative model request', async () => {
  const controller = new AbortController(), error = new Error('Stop reflection');
  controller.abort(error);
  await assert.rejects(reflect(trace(), { async complete() { assert.fail('Already aborted'); } }, {
    signal: controller.signal,
  }), value => value === error);
  const active = new AbortController();
  let observed: AbortSignal | undefined;
  await assert.rejects(reflect(trace(), { complete(_messages, _tools, signal) {
    observed = signal;
    active.abort(error);
    return new Promise(() => {});
  } }, { signal: active.signal }), value => value === error);
  assert.equal(observed?.aborted, true);
});

test('canceling before the queued model request starts prevents that request', async () => {
  const controller = new AbortController(), error = new Error('Cancel before request');
  const pending = reflect(trace(), { async complete() { assert.fail('Canceled before dispatch'); } }, {
    signal: controller.signal,
  });
  controller.abort(error);
  await assert.rejects(pending, value => value === error);
});

function runtime(t: TestContext, provider: Provider, autoReflect = true, timeoutMs = 1000) {
  const root = mkdtempSync(join(tmpdir(), 'hermes-reflection-'));
  const store = new SessionStore(join(root, 'sessions.db'));
  const evolution = new EvolutionManager(join(root, 'proposals'), join(root, 'skills'));
  const skills = new SkillCatalog([join(root, 'skills')]);
  const events: { event: string; data: unknown }[] = [];
  const agent = new Agent({ provider, store, evolution, skills, mode: 'learner', autoReflect,
    memory: new LongTermMemory(join(root, 'memory')), reflection: { timeoutMs },
    emit: (event, data) => { events.push({ event, data }); },
  });
  t.after(() => { agent.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { agent, store, evolution, events };
}

test('Agent isolates reflection failure from a persisted answer without logging private errors', async t => {
  const demo = new DemoProvider();
  const { agent, store, evolution, events } = runtime(t, { async complete(messages, tools, signal) {
    if (messages[0]?.content.startsWith(REFLECTION_TASK)) throw new Error('private-error-detail');
    return demo.complete(messages, tools, signal);
  } });
  assert.match(await agent.run('key', 'scope', '/calc 2+2'), /"result":4/);
  await agent.waitForReflections();
  assert.equal(store.loadMessages(store.getOrCreate('key', 'scope').id).length, 4);
  assert.deepEqual(evolution.listProposals(), []);
  assert.ok(events.some(row => row.event === 'evolution.error'));
  assert.equal(JSON.stringify(events).includes('private-error-detail'), false);
});

test('late reflection results after timeout never write a proposal', async t => {
  const demo = new DemoProvider();
  let finish!: (result: ModelResponse) => void;
  const { agent, evolution, store } = runtime(t, { complete(messages, tools, signal) {
    if (messages[0]?.content.startsWith(REFLECTION_TASK)) return new Promise(resolve => { finish = resolve; });
    return demo.complete(messages, tools, signal);
  } }, true, 10);
  assert.match(await agent.run('key', 'scope', '/calc 2+2'), /"result":4/);
  await agent.waitForReflections();
  finish({ content: body });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(evolution.listProposals(), []);
  assert.equal(store.loadMessages(store.getOrCreate('key', 'scope').id).length, 4);
});

test('autoReflect off does not call the reflection model or create candidates', async t => {
  const demo = new DemoProvider();
  const { agent, evolution } = runtime(t, { async complete(messages, tools, signal) {
    assert.equal(messages[0]?.content.startsWith(REFLECTION_TASK), false);
    return demo.complete(messages, tools, signal);
  } }, false);
  await agent.run('key', 'scope', '/calc 2+2');
  assert.deepEqual(evolution.listProposals(), []);
});
