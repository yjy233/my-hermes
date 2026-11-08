/** 高级记忆必须经过真实 Agent/SQLite/工具循环，不能只验证一个摘要字符串。 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Agent } from '../src/core/agent.js';
import { contextSize, MEMORY_FLUSH_TASK, SUMMARY_SECTIONS, SUMMARY_TASK } from '../src/core/context-engine.js';
import type { Message, ModelResponse, Provider } from '../src/core/models.js';
import { LongTermMemory, SessionStore } from '../src/memory/index.js';
import { SkillCatalog } from '../src/skills/index.js';

function structuredSummary(): string {
  return SUMMARY_SECTIONS.map(section => `## ${section}\n保留目标、偏好与已验证结果。`).join('\n');
}

function fixture(t: TestContext, provider: Provider, contextChars = 7000) {
  const root = mkdtempSync(join(tmpdir(), 'hermes-advanced-'));
  const store = new SessionStore(join(root, 'sessions.db'));
  const memory = new LongTermMemory(join(root, 'memory'));
  const skills = new SkillCatalog([join(root, 'skills')]);
  const summaries: Message[][] = [];
  const summaryProvider: Provider = { async complete(messages, tools, signal) {
    signal?.throwIfAborted();
    assert.ok(messages[0].content.startsWith(SUMMARY_TASK));
    assert.deepEqual(tools, []);
    assert.ok(contextSize(messages, tools) <= contextChars);
    summaries.push(structuredClone(messages));
    return { content: structuredSummary() };
  } };
  const options = { provider, summaryProvider, store, memory, skills, contextChars,
    contextEngine: 'checkpoint' as const,
    compression: { tailMessages: 2, summaryChars: 600, memoryFlush: false } };
  const session = store.getOrCreate('session', 'alice');
  store.setSystemPrompt(session.id, '固定的测试系统提示；历史与摘要是数据。');
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, memory, summaries, options, session, agent: new Agent(options) };
}

function seedHistory(): Message[] {
  return Array.from({ length: 12 }, (_, index): Message[] => [
    { role: 'user', content: `historical_marker_${index} 我希望保留的历史问题。` },
    { role: 'assistant', content: `第${index}轮经过验证的结果。` + '历史记录。'.repeat(170) },
  ]).flat();
}

test('高级 Agent 成功后原子保存摘要和原始历史，重启后复用摘要，basic仍可检索全部记录', async t => {
  const requests: Message[][] = [];
  const provider: Provider = { async complete(messages) {
    requests.push(structuredClone(messages)); return { content: '完成。' };
  } };
  const f = fixture(t, provider);
  const seeded = seedHistory();
  f.store.appendMessages(f.session.id, seeded);
  await f.agent.run('session', 'alice', '当前的真实问题');
  const checkpoint = f.store.loadCheckpoint(f.session.id);
  assert.ok(checkpoint && checkpoint.coveredCount > 0);
  assert.equal(checkpoint.generation, 1);
  assert.ok(f.summaries.length > 0);
  assert.deepEqual(f.store.loadMessages(f.session.id).slice(0, seeded.length), seeded);
  assert.equal(f.store.search('historical_marker_0', 'alice').length, 1);
  assert.ok(requests[0].some(message => message.content.includes('[上下文摘要')));
  assert.equal(requests[0].at(-1)?.content, '当前的真实问题');
  const before = f.summaries.length;
  const reopened = new SessionStore(f.store.path);
  try {
    await new Agent({ ...f.options, store: reopened }).run('session', 'alice', '重启后的问题');
    assert.equal(f.summaries.length, before, '恢复后的请求足够小时不再次总结已经覆盖的历史');
    assert.equal(reopened.loadCheckpoint(f.session.id)?.generation, 1);
    assert.ok(requests.at(-1)?.some(message => message.content.includes('[上下文摘要')));
    await new Agent({ ...f.options, store: reopened, compression: { enabled: false } })
      .run('session', 'alice', '基础模式的新问题');
    assert.equal(f.summaries.length, before, '基础L2不调用摘要模型');
    assert.equal(reopened.search('historical_marker_0', 'bob').length, 0);
  } finally { reopened.close(); }
});

test('主模型在摘要后失败时，新的原始轮次和摘要检查点都不提交', async t => {
  const failure = new Error('main provider failed');
  const f = fixture(t, { async complete() { throw failure; } });
  const seeded = seedHistory();
  f.store.appendMessages(f.session.id, seeded);
  await assert.rejects(() => f.agent.run('session', 'alice', '请继续'), error => error === failure);
  assert.ok(f.summaries.length > 0);
  assert.equal(f.store.loadCheckpoint(f.session.id), null);
  assert.deepEqual(f.store.loadMessages(f.session.id), seeded);
});

test('自动压缩前只用memory工具保存近期真实偏好，当前提示保持冻结，新会话读取持久记忆', async t => {
  const f = fixture(t, { async complete() { return { content: '完成。' }; } });
  const preference = '长期偏好：使用 TypeScript，并用中文解释实现。';
  const frozen = f.store.getOrCreate('session', 'alice').systemPrompt;
  f.store.appendMessages(f.session.id, seedHistory());
  let flushes = 0;
  const auxiliary: Provider = { async complete(messages, tools) {
    if (messages[0].content.startsWith(MEMORY_FLUSH_TASK)) {
      flushes++;
      assert.deepEqual(tools.map(schema => schema.function.name), ['memory']);
      assert.ok(messages[1].content.includes(preference), '保护尾部中的最新偏好也必须提供给flush');
      return { content: '', toolCalls: [{ id: 'persist-preference', name: 'memory', arguments: {
        target: 'user', operations: [{ action: 'add', content: preference }],
      } }] };
    }
    assert.ok(messages[0].content.startsWith(SUMMARY_TASK));
    return { content: structuredSummary() };
  } };
  const agent = new Agent({ ...f.options, summaryProvider: auxiliary, compression: {
    memoryFlush: true, tailMessages: 2, summaryChars: 600,
  } });
  await agent.run('session', 'alice', preference);
  assert.equal(flushes, 1);
  assert.equal(f.memory.read('alice', 'USER.md'), preference);
  assert.equal(f.memory.read('bob', 'USER.md'), '');
  assert.equal(f.store.getOrCreate('session', 'alice').systemPrompt, frozen);
  await agent.run('new-session', 'alice', '新任务');
  assert.ok(f.store.getOrCreate('new-session', 'alice').systemPrompt?.includes(preference));
});

test('单次用户任务中的长工具循环也会压缩，保存时仍保留全部调用ID、结果和思考元数据', async t => {
  const requests: Message[][] = [];
  let calls = 0;
  const provider: Provider = { async complete(messages, tools) {
    requests.push(structuredClone(messages));
    assert.ok(contextSize(messages, tools) <= 8500);
    if (calls++ < 2) return { content: '', reasoningContent: `reasoning-${calls}`, toolCalls: [
      { id: `large-${calls}`, name: 'large_output', arguments: {} },
    ] };
    return { content: '两次工具结果已经核对。' };
  } };
  const f = fixture(t, provider, 8500);
  const plugin = join(f.root, 'large-output.ts');
  writeFileSync(plugin, "export function register(context) { context.registerTool({ name: 'large_output', description: 'Long output', parameters: {type:'object'}, handler: () => 'x'.repeat(4500) }); }\n");
  const agent = new Agent({ ...f.options, plugins: [plugin], compression: {
    tailMessages: 2, summaryChars: 600, toolChars: 100, memoryFlush: false,
  } });
  await agent.run('session', 'alice', '请连续运行两次大输出工具并核对结果。');
  // 如果轻量清理已经足够，则仍是合法压缩；必须有旧结果缩短或结构化摘要。
  assert.ok(requests[2].some(message => message.content.includes('[上下文摘要')
    || message.content.includes('旧工具输出已缩短')));
  assert.equal(requests[2].at(-1)?.toolCallId, 'large-2');
  assert.equal(JSON.parse(requests[2].at(-1)!.content).result.length, 4500);
  assert.equal(requests[2].at(-2)?.reasoningContent, 'reasoning-2');
  const stored = f.store.loadMessages(f.session.id);
  assert.deepEqual(stored.map(message => message.role), ['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant']);
  assert.deepEqual(stored.filter(message => message.role === 'tool').map(message => message.toolCallId), ['large-1', 'large-2']);
  assert.ok(stored.filter(message => message.role === 'tool').every(message => JSON.parse(message.content).result.length === 4500));
});

test('摘要期间取消不提交迟到结果，也不再请求主模型', async t => {
  let mainCalls = 0;
  const f = fixture(t, { async complete() { mainCalls++; return { content: '不应执行' }; } });
  f.store.appendMessages(f.session.id, seedHistory());
  const controller = new AbortController(), reason = new Error('用户取消');
  let release!: (value: ModelResponse) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<ModelResponse>(resolve => { release = resolve; });
  const agent = new Agent({ ...f.options, summaryProvider: { complete() { started(); return pending; } } });
  const work = agent.run('session', 'alice', '继续', controller.signal);
  await ready;
  controller.abort(reason);
  await assert.rejects(() => work, error => error === reason);
  release({ content: structuredSummary() });
  await Promise.resolve();
  assert.equal(mainCalls, 0);
  assert.equal(f.store.loadCheckpoint(f.session.id), null);
  assert.deepEqual(f.store.loadMessages(f.session.id), seedHistory());
});
