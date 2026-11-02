/** 直接验证已完成的 L1，避免只靠 reference 或外围场景掩盖循环分支错误。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderError } from '../src/core/errors.js';
import type { Message, Provider, ToolCall } from '../src/core/models.js';
import { ToolRegistry } from '../src/core/tools.js';
import { runLoop } from '../src/learning/exercises.js';

const noop = () => undefined;

test('学习者循环在同时收到文本和工具调用时继续执行，并保留 assistant 原文', async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'calculator', description: '本机测试工具',
    parameters: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'] },
    handler: args => Number(args.value) * 2,
  });
  const history: Message[] = [
    { role: 'system', content: '系统规则' },
    { role: 'user', content: '上一个问题' },
    { role: 'assistant', content: '上一个答复' },
    { role: 'user', content: '请计算 2 的两倍' },
  ];
  const original = structuredClone(history), observed: Message[][] = [];
  const provider: Provider = { async complete(messages) {
    observed.push(structuredClone(messages));
    if (observed.length === 1) return {
      content: '我先调用工具计算。', reasoningContent: '测试用协议元数据',
      toolCalls: [{ id: 'mixed-call', name: 'calculator', arguments: { value: 2 } }],
    };
    if (observed.length === 2) return { content: '结果是 4。' };
    throw new Error('不应发起第三次模型请求');
  } };
  const delta = await runLoop(provider, registry, history, 3, noop);
  assert.equal(observed.length, 2);
  assert.deepEqual(delta.map(message => message.role), ['assistant', 'tool', 'assistant']);
  assert.equal(delta[0].content, '我先调用工具计算。');
  assert.equal(delta[0].reasoningContent, '测试用协议元数据');
  assert.equal(delta[0].toolCalls?.[0].id, 'mixed-call');
  assert.equal(delta[1].toolCallId, 'mixed-call');
  assert.deepEqual(JSON.parse(delta[1].content), { ok: true, result: 4 });
  assert.equal(delta[2].content, '结果是 4。');
  assert.deepEqual(observed[1], [...original, ...delta.slice(0, 2)]);
  assert.deepEqual(history, original);
});

test('学习者循环原样传递 Provider Error，不吞掉错误或替换成字符串', async () => {
  const failure = new ProviderError('Kimi HTTP 429');
  let requests = 0;
  const provider: Provider = { async complete() { requests++; throw failure; } };
  const history: Message[] = [{ role: 'user', content: '发送一次请求' }];
  const original = structuredClone(history), events: string[] = [];
  await assert.rejects(() => runLoop(provider, new ToolRegistry(), history, 3,
    event => events.push(event)), error => error === failure);
  assert.equal(requests, 1);
  assert.deepEqual(events, ['model.start']);
  assert.deepEqual(history, original);
});

test('第一工具返回期间发生取消时，不接收迟到结果、不执行第二工具或再次请求模型', async () => {
  const controller = new AbortController(), reason = new Error('调用方在第一个工具期间取消');
  const executions: string[] = [], events: string[] = [];
  // 模拟工具结果和取消同时到达：即使 Registry 返回成功，loop 仍须在 await 后检查 signal。
  class ReturningRegistry extends ToolRegistry {
    override async execute(call: ToolCall, signal?: AbortSignal): Promise<Message> {
      executions.push(call.name);
      assert.ok(signal, '循环应将取消信号传给 Registry');
      if (call.name === 'first_tool') controller.abort(reason);
      assert.equal(signal.aborted, true);
      return { role: 'tool', toolCallId: call.id, content: '{"ok":true,"result":1}' };
    }
  }
  let requests = 0;
  const provider: Provider = { async complete() {
    requests++;
    if (requests > 1) return { content: '取消后不应请求到这里' };
    return { content: '', toolCalls: [
      { id: 'first-call', name: 'first_tool', arguments: {} },
      { id: 'second-call', name: 'second_tool', arguments: {} },
    ] };
  } };
  await assert.rejects(() => runLoop(provider, new ReturningRegistry(),
    [{ role: 'user', content: '运行两个工具' }], 3, event => events.push(event), controller.signal),
  error => error === reason);
  assert.deepEqual(executions, ['first_tool']);
  assert.equal(requests, 1);
  assert.deepEqual(events, ['model.start', 'tool.start']);
});
