/** 压缩前的辅助模型只能整理记忆；请求预算、取消和失败都不能突破这条边界。 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { buildRegistry } from '../src/core/builtin-tools.js';
import { contextSize, MEMORY_FLUSH_TASK } from '../src/core/context-engine.js';
import { ContextBudgetExceeded } from '../src/core/errors.js';
import { flushLongTermMemory, MemoryFlushError } from '../src/core/memory-flush.js';
import type { Emit, Message, ModelResponse, Provider, ToolCall } from '../src/core/models.js';
import { ToolRegistry } from '../src/core/tools.js';
import { loadAlgorithms } from '../src/learning/index.js';
import { LongTermMemory, type MemoryOperation, type MemoryStoreTarget } from '../src/memory/long-term.js';
import { SessionStore } from '../src/memory/store.js';
import { SkillCatalog } from '../src/skills/catalog.js';

function fixture(t: TestContext, memoryChars = 4000) {
  const root = mkdtempSync(join(tmpdir(), 'hermes-memory-flush-'));
  const memory = new LongTermMemory(join(root, 'memory'), memoryChars);
  const store = new SessionStore(join(root, 'sessions.db'));
  const registry = buildRegistry(memory, store, new SkillCatalog([join(root, 'skills')]), 'alice', loadAlgorithms('reference'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const events: { name: string; payload: Record<string, unknown> }[] = [];
  const emit: Emit = (name, payload) => events.push({ name, payload });
  return { memory, registry, events, emit };
}
const source: Message[] = [{ role: 'user', content: '我喜欢 TypeScript，并希望用中文解释代码。' }];
function call(id: string, target: MemoryStoreTarget, operations: MemoryOperation[]): ToolCall {
  return { id, name: 'memory', arguments: { target, operations } };
}

test('flush 只开放 memory，执行所有记忆调用，并报告计数而非原文', async t => {
  const { memory, registry, events, emit } = fixture(t);
  const originalSource = structuredClone(source);
  let requests = 0;
  const provider: Provider = { async complete(messages, tools, signal) {
    requests++;
    assert.equal(signal?.aborted, false);
    assert.match(messages[0].content, new RegExp(MEMORY_FLUSH_TASK.replace(/[\[\]]/gu, '\\$&'), 'u'));
    assert.deepEqual(tools.map(schema => schema.function.name), ['memory']);
    assert.ok(contextSize(messages, tools) <= 10_000);
    return { content: '提炼用户偏好和环境事实。', toolCalls: [
      call('profile', 'user', [{ action: 'add', content: '偏好 TypeScript，并用中文解释代码。' }]),
      call('environment', 'memory', [{ action: 'add', content: '学习项目采用 Node.js。' }]),
    ] };
  } };
  await flushLongTermMemory(provider, registry, memory, 'alice', source, 10_000, emit, new AbortController().signal);
  assert.equal(requests, 1);
  assert.equal(memory.read('alice', 'USER.md'), '偏好 TypeScript，并用中文解释代码。');
  assert.equal(memory.read('alice', 'MEMORY.md'), '学习项目采用 Node.js。');
  assert.equal(memory.read('bob', 'USER.md'), '');
  assert.deepEqual(source, originalSource);
  assert.deepEqual(events.map(event => event.name), ['memory.flush.start', 'memory.flush.end']);
  assert.deepEqual(events.at(-1)?.payload, { count: 2, changes: 2, attempts: 1, failures: 0 });
  assert.equal(JSON.stringify(events).includes('TypeScript'), false);
});

test('容量错误进入第二次模型请求，保留工具配对和思考协议，再用整批整理成功', async t => {
  const { memory, registry, events, emit } = fixture(t, 30);
  memory.write('alice', 'USER.md', 'A lengthy old preference');
  let requests = 0;
  const provider: Provider = { async complete(messages, tools) {
    requests++;
    assert.ok(contextSize(messages, tools) <= 10_000);
    if (requests === 1) return { content: '', reasoningContent: 'protocol-only-reasoning', toolCalls: [
      call('overflow', 'user', [{ action: 'add', content: 'likes TypeScript' }]),
    ] };
    assert.equal(messages.at(-2)?.role, 'assistant');
    assert.equal(messages.at(-2)?.reasoningContent, 'protocol-only-reasoning');
    assert.equal(messages.at(-1)?.toolCallId, 'overflow');
    const failure = JSON.parse(messages.at(-1)!.content);
    assert.equal(failure.ok, false);
    assert.match(failure.message, /required_space/);
    return { content: '', toolCalls: [call('repair', 'user', [
      { action: 'patch', old_text: 'A lengthy old preference', content: 'concise' },
      { action: 'add', content: 'likes TypeScript' },
    ])] };
  } };
  await flushLongTermMemory(provider, registry, memory, 'alice', source, 10_000, emit, new AbortController().signal);
  assert.equal(requests, 2);
  assert.equal(memory.read('alice', 'USER.md'), 'concise\n\n§\n\nlikes TypeScript');
  assert.deepEqual(events.at(-1)?.payload, { count: 1, changes: 1, attempts: 2, failures: 1 });
});

test('包含非 memory 工具的整组响应被拒绝，前面的合法记忆调用也不会先执行', async t => {
  const { memory, registry, events, emit } = fixture(t);
  let sideEffects = 0;
  registry.register({ name: 'plugin_side_effect', description: 'must not run', parameters: { type: 'object' },
    handler: () => { sideEffects++; return true; } });
  const provider: Provider = { async complete() { return { content: '', toolCalls: [
    call('allowed-but-not-executed', 'user', [{ action: 'add', content: 'must remain absent' }]),
    { id: 'forbidden', name: 'plugin_side_effect', arguments: {} },
  ] }; } };
  await assert.rejects(flushLongTermMemory(provider, registry, memory, 'alice', source, 10_000, emit,
    new AbortController().signal), MemoryFlushError);
  assert.equal(sideEffects, 0);
  assert.equal(memory.read('alice', 'USER.md'), '');
  assert.equal(events.at(-1)?.payload.error, 'MemoryFlushError');
});

test('取消后忽略不响应 signal 的迟到 Provider，不执行它返回的记忆写入', async t => {
  const { memory, registry, events, emit } = fixture(t);
  const controller = new AbortController(), reason = new Error('stop late flush');
  let resolveResponse!: (response: ModelResponse) => void;
  const provider: Provider = { complete() { return new Promise(resolve => { resolveResponse = resolve; }); } };
  const pending = flushLongTermMemory(provider, registry, memory, 'alice', source, 10_000, emit, controller.signal);
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  resolveResponse({ content: '', toolCalls: [call('too-late', 'user', [{ action: 'add', content: 'late fact' }])] });
  await Promise.resolve();
  assert.equal(memory.read('alice', 'USER.md'), '');
  assert.equal(events.at(-1)?.payload.error, 'AbortError');
});

test('首个工具写入期间取消会阻止第二个工具；已落盘的写入不假装被回滚', async t => {
  const { memory, emit } = fixture(t);
  const controller = new AbortController(), reason = new Error('cancel after first write');
  const registry = new ToolRegistry();
  let executed = 0;
  registry.register({ name: 'memory', description: 'scoped memory', parameters: { type: 'object', additionalProperties: true },
    handler: args => {
      executed++;
      const result = memory.manage('alice', 'user', args.operations as MemoryOperation[]);
      controller.abort(reason);
      return result;
    } });
  const provider: Provider = { async complete() { return { content: '', toolCalls: [
    call('first', 'user', [{ action: 'add', content: 'first persistent fact' }]),
    call('second', 'user', [{ action: 'add', content: 'must not execute' }]),
  ] }; } };
  await assert.rejects(flushLongTermMemory(provider, registry, memory, 'alice', source, 10_000, emit,
    controller.signal), error => error === reason);
  assert.equal(executed, 1);
  assert.equal(memory.read('alice', 'USER.md'), 'first persistent fact');
});

test('长 source 使用明确头尾摘录，完整 live snapshot 不截断，纯文本不写入', async t => {
  const { memory, registry, events, emit } = fixture(t);
  memory.write('alice', 'MEMORY.md', 'EXISTING_ENVIRONMENT_FACT');
  memory.write('alice', 'USER.md', 'EXISTING_USER_PREFERENCE');
  let requests = 0;
  const evidence: Message[] = [{ role: 'user', content: 'HEAD_SENTINEL ' + 'large record '.repeat(5000) + ' TAIL_SENTINEL',
    reasoningContent: 'REASONING_MUST_NOT_BECOME_EVIDENCE' }];
  const provider: Provider = { async complete(messages, tools) {
    requests++;
    assert.ok(contextSize(messages, tools) <= 3000);
    const payload = JSON.parse(messages[1].content);
    assert.equal(payload.source.format, 'json-excerpt');
    assert.match(payload.source.head, /HEAD_SENTINEL/);
    assert.match(payload.source.tail, /TAIL_SENTINEL/);
    assert.match(payload.source.omitted, /中间原文省略/);
    assert.equal(payload.liveMemorySnapshot, memory.snapshot('alice'));
    assert.equal(JSON.stringify(messages).includes('REASONING_MUST_NOT_BECOME_EVIDENCE'), false);
    return { content: '无需更新' };
  } };
  await flushLongTermMemory(provider, registry, memory, 'alice', evidence, 3000, emit, new AbortController().signal);
  assert.equal(requests, 1);
  assert.equal(memory.read('alice', 'MEMORY.md'), 'EXISTING_ENVIRONMENT_FACT');
  assert.deepEqual(events.at(-1)?.payload, { count: 0, changes: 0, attempts: 1, failures: 0 });
});

test('schema 或完整实时记忆本身超过预算时，拒绝辅助请求而不是截断记忆', async t => {
  const { memory, registry, events, emit } = fixture(t);
  let requests = 0;
  const provider: Provider = { async complete() { requests++; return { content: 'must not be called' }; } };
  const oversized = new ToolRegistry();
  oversized.register({ name: 'memory', description: 'large schema '.repeat(300), parameters: { type: 'object' }, handler: () => true });
  await assert.rejects(flushLongTermMemory(provider, oversized, memory, 'alice', source, 1000, emit,
    new AbortController().signal), ContextBudgetExceeded);
  assert.equal(requests, 0);
  memory.write('alice', 'MEMORY.md', 'environment fact '.repeat(200));
  const original = memory.read('alice', 'MEMORY.md');
  await assert.rejects(flushLongTermMemory(provider, registry, memory, 'alice', source, 3000, emit,
    new AbortController().signal), ContextBudgetExceeded);
  assert.equal(requests, 0);
  assert.equal(memory.read('alice', 'MEMORY.md'), original);
  assert.equal(events.at(-1)?.payload.error, 'ContextBudgetExceeded');
});

test('第二次工具仍失败时明确结束，不进行第三次请求，也不输出错误原文', async t => {
  const { memory, registry, events, emit } = fixture(t, 20);
  memory.write('alice', 'USER.md', 'existing stable fact');
  let requests = 0;
  const provider: Provider = { async complete() {
    requests++;
    return { content: '', toolCalls: [call(`overflow-${requests}`, 'user', [{ action: 'add', content: 'new fact' }])] };
  } };
  await assert.rejects(flushLongTermMemory(provider, registry, memory, 'alice', source, 10_000, emit,
    new AbortController().signal), MemoryFlushError);
  assert.equal(requests, 2);
  assert.equal(memory.read('alice', 'USER.md'), 'existing stable fact');
  assert.deepEqual(events.at(-1)?.payload, { count: 0, changes: 0, attempts: 2, failures: 2, error: 'MemoryFlushError' });
  assert.equal(JSON.stringify(events).includes('existing stable fact'), false);
  assert.equal(JSON.stringify(events).includes('current_entries'), false);
});

test('Provider 原始错误不进入观察事件，观察器自身异常也不影响无操作完成', async t => {
  const { memory, registry, events, emit } = fixture(t);
  const privateError = new Error('PRIVATE_PROVIDER_DETAIL');
  privateError.name = 'PRIVATE_PROVIDER_NAME';
  const provider: Provider = { async complete() { throw privateError; } };
  await assert.rejects(flushLongTermMemory(provider, registry, memory, 'alice', source, 10_000, emit,
    new AbortController().signal), error => error === privateError);
  assert.equal(events.at(-1)?.payload.error, 'ProviderError');
  assert.equal(JSON.stringify(events).includes('PRIVATE'), false);
  await flushLongTermMemory({ async complete() { return { content: '无需更新' }; } }, registry, memory,
    'alice', source, 10_000, () => { throw new Error('observer failed'); }, new AbortController().signal);
});
