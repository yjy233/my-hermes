/** 合并后的默认异步 L2 必须保留长期记忆整理与本轮原文召回能力。 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Agent } from '../src/core/agent.js';
import { MEMORY_FLUSH_TASK } from '../src/core/context-engine.js';
import { requestSize, type Message, type Provider } from '../src/core/models.js';
import { DemoProvider } from '../src/core/providers.js';
import { LongTermMemory, SessionStore, type MemoryHit } from '../src/memory/index.js';
import { SkillCatalog } from '../src/skills/index.js';

const summary = '## Outstanding request\nContinue the current request.\n## Completed actions\nReviewed the prior records.\n## Constraints and preferences\nKeep original history.';

test('默认 Hermes 链路在摘要前整理长期偏好，并原子保存原始消息与工作上下文', async t => {
  const root = mkdtempSync(join(tmpdir(), 'hermes-merged-flush-'));
  const store = new SessionStore(join(root, 'sessions.db'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const memory = new LongTermMemory(join(root, 'memory')), skills = new SkillCatalog([]);
  const session = store.getOrCreate('old', 'alice');
  store.setSystemPrompt(session.id, 'A frozen initial prompt.');
  const raw: Message[] = Array.from({ length: 18 }, (_, index): Message[] => [
    { role: 'user', content: `Question ${index}: ` + 'detail '.repeat(40) },
    { role: 'assistant', content: `Evidence ${index}: ` + 'verified '.repeat(100) },
  ]).flat();
  store.appendMessages(session.id, raw);
  const preference = '用户希望使用 TypeScript，并用中文解释 Agent 实现。';
  let flushes = 0, summaries = 0;
  const auxiliary: Provider = { async complete(messages, tools) {
    if (messages[0].content.startsWith(MEMORY_FLUSH_TASK)) {
      flushes++;
      assert.deepEqual(tools.map(tool => tool.function.name), ['memory']);
      assert.ok(messages[1].content.includes(preference));
      return { content: '', toolCalls: [{ id: 'save-preference', name: 'memory', arguments: {
        target: 'user', operations: [{ action: 'add', content: preference }],
      } }] };
    }
    summaries++;
    return { content: summary };
  } };
  const agent = new Agent({ provider: new DemoProvider(), summaryProvider: auxiliary, store, memory, skills,
    mode: 'learner', compression: { protectLast: 4, summaryChars: 1000 } });
  await agent.run('old', 'alice', preference);
  assert.equal(flushes, 1); assert.equal(summaries, 1);
  assert.equal(memory.read('alice', 'USER.md'), preference);
  assert.ok(store.loadContextMessages(session.id).some(message => message.contextSummary));
  assert.deepEqual(store.loadMessages(session.id).slice(0, raw.length), raw);
  assert.equal(store.getOrCreate('old', 'alice').systemPrompt, 'A frozen initial prompt.');
  await agent.run('new', 'alice', '继续学习');
  assert.ok(store.getOrCreate('new', 'alice').systemPrompt?.includes(preference));
  assert.equal(memory.read('bob', 'USER.md'), '');
});

test('工具原文在本轮压缩后仍可立即检索，不必等待最终答复提交 SQLite', async t => {
  const root = mkdtempSync(join(tmpdir(), 'hermes-live-recall-'));
  const store = new SessionStore(join(root, 'sessions.db'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const memory = new LongTermMemory(join(root, 'memory')), skills = new SkillCatalog([]);
  const session = store.getOrCreate('session', 'alice');
  store.setSystemPrompt(session.id, 'Fixed system.');
  const plugin = join(root, 'long-result.mjs');
  writeFileSync(plugin, "let calls=0; export function register(ctx) { ctx.registerTool({name:'large_output',description:'Read long data',parameters:{type:'object'},handler:()=>`live-original-${++calls}:`+'x'.repeat(4500)}); }");
  let calls = 0;
  const provider: Provider = { async complete(messages, tools) {
    assert.ok(requestSize(messages, tools) <= 9500);
    const step = calls++;
    if (step < 2) return { content: '正在处理已确认的中间步骤。'.repeat(100), toolCalls: [
      { id: `large-${step}`, name: 'large_output', arguments: {} },
    ] };
    if (step === 2) {
      assert.deepEqual(store.loadMessages(session.id), [], '主轮次尚未成功，原文此时还没有入库');
      return { content: '', toolCalls: [{ id: 'find-live', name: 'history_search', arguments: { query: 'live-original-1' } }] };
    }
    const result = JSON.parse(messages.at(-1)!.content) as { ok: boolean; result: MemoryHit[] };
    assert.equal(result.ok, true);
    assert.ok(result.result.some(hit => hit.sessionId === session.id && hit.content.includes('live-original-1')
      && JSON.parse(hit.content).result.length > 4500));
    return { content: '已从本轮原始工具记录中找回内容。' };
  } };
  await new Agent({ provider, summaryProvider: { async complete() { return { content: summary }; } },
    store, memory, skills, plugins: [plugin], contextChars: 9500, mode: 'learner',
    compression: { protectFirst: 1, protectLast: 2, summaryChars: 600, memoryFlush: false },
  }).run('session', 'alice', '完成两个读取步骤，再找回第一个步骤的完整原文。');
  assert.equal(calls, 4);
  assert.equal(store.loadMessages(session.id).filter(message => message.role === 'tool').length, 3);
});
