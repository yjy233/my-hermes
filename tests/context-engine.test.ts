/** 用确定性的脚本模型验证压缩请求，不使用真实账户、网络或个人配置。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextEngine, contextSize, SUMMARY_SECTIONS, SUMMARY_TASK,
  type CompressionOptions } from '../src/core/context-engine.js';
import { ContextBudgetExceeded } from '../src/core/errors.js';
import { messageSize, type Message, type ModelResponse, type Provider, type ToolSchema } from '../src/core/models.js';
import { hashContextPrefix, type ContextCheckpoint } from '../src/memory/store.js';

const BUDGET = 6000;
const OPTIONS: CompressionOptions = { summaryChars: 700, tailMessages: 4, memoryFlush: false };

function summary(marker = '已完成旧任务'): string {
  return SUMMARY_SECTIONS.map(section => `## ${section}\n${marker}`).join('\n\n');
}

function recentTools(suffix = ''): Message[] {
  return [
    { role: 'assistant', content: '同时检查两个结果。', reasoningContent: `recent_reasoning_${suffix}`, toolCalls: [
      { id: `sum${suffix}`, name: 'calculator', arguments: { expression: '2+3' } },
      { id: `product${suffix}`, name: 'calculator', arguments: { expression: '5*4' } },
    ] },
    { role: 'tool', content: `最新求和结果 ${'A'.repeat(200)}`, toolCallId: `sum${suffix}` },
    { role: 'tool', content: `最新乘法结果 ${'B'.repeat(200)}`, toolCallId: `product${suffix}` },
  ];
}

function history(oldChars = 850, turns = 10): Message[] {
  const result: Message[] = [
    { role: 'system', content: '冻结的系统规则与长期记忆快照。' },
    { role: 'user', content: '最早的目标，请持续完成。' },
    { role: 'assistant', content: '已经确认最早目标。' },
  ];
  for (let index = 0; index < turns; index++) {
    result.push({ role: 'user', content: `旧问题 ${index}` },
      { role: 'assistant', content: `old_record_${index} ${'旧'.repeat(oldChars)}`,
        reasoningContent: '历史思考元数据不应作为事实传入摘要器' });
  }
  result.push({ role: 'user', content: '当前用户原始问题：请核对两个计算结果。' }, ...recentTools());
  return result;
}

function oneOldRecord(length: number): Message[] {
  return [{ role: 'system', content: '固定系统提示。' }, { role: 'user', content: '旧问题' },
    { role: 'assistant', content: 'x'.repeat(length) }, { role: 'user', content: '当前问题，请继续。' }];
}

interface CapturedRequest { messages: Message[]; tools: ToolSchema[]; signal?: AbortSignal }
function scripted(reply?: (request: CapturedRequest, index: number) => ModelResponse | Promise<ModelResponse>) {
  const summaries: CapturedRequest[] = [], modelRequests: CapturedRequest[] = [];
  const provider: Provider = { async complete(messages, tools, signal) {
    const request = { messages: structuredClone(messages), tools: structuredClone(tools), signal };
    if (messages[0]?.content.startsWith(SUMMARY_TASK)) {
      summaries.push(request);
      assert.deepEqual(tools, [], '摘要器不能获得业务工具');
      return reply ? reply(request, summaries.length) : { content: summary(`摘要第 ${summaries.length} 批`) };
    }
    modelRequests.push(request);
    return { content: '最终答复' };
  } };
  return { provider, summaries, modelRequests };
}

test('结构化摘要替换旧中段，保留 system、最新 user、完整多工具组和 reasoning，输入不变', async () => {
  const { provider, summaries } = scripted();
  const input = history(), original = structuredClone(input);
  const engine = new ContextEngine(provider, BUDGET, OPTIONS);
  const prepared = await engine.prepare(input, []);
  assert.ok(summaries.length > 0);
  assert.ok(contextSize(prepared) < contextSize(input));
  assert.ok(contextSize(prepared) <= BUDGET);
  assert.deepEqual(prepared[0], original[0]);
  assert.ok(prepared.some(message => message.content === original.at(-4)!.content));
  assert.deepEqual(prepared.slice(-3), original.slice(-3));
  assert.ok(prepared.some(message => SUMMARY_SECTIONS.every(section => message.content.includes(`## ${section}`))));
  assert.ok(!prepared.some(message => message.content.startsWith('old_record_0 ')));
  assert.deepEqual(input, original);
  assert.ok(!JSON.stringify(summaries.map(request => request.messages)).includes('reasoningContent'));
  const draft = engine.checkpointDraft();
  assert.ok(draft && draft.coveredCount > 0);
  assert.equal(draft.prefixHash, hashContextPrefix(input.slice(1, 1 + draft.coveredCount)));
});

test('相同历史复用摘要，后续增长把 previousSummary 交给摘要器增量更新', async () => {
  const { provider, summaries } = scripted();
  const input = history();
  const engine = new ContextEngine(provider, BUDGET, OPTIONS);
  const first = await engine.prepare(input, []);
  const firstDraft = engine.checkpointDraft()!;
  const firstCalls = summaries.length;
  assert.deepEqual(await engine.prepare(input, []), first);
  assert.equal(summaries.length, firstCalls, '同一上下文不能反复花费摘要请求');
  const growth: Message[] = [...input, { role: 'assistant', content: '上一轮已经完成。' }];
  for (let index = 0; index < 8; index++) {
    growth.push({ role: 'user', content: `新增问题 ${index}` }, { role: 'assistant', content: 'new'.repeat(350) });
  }
  growth.push({ role: 'user', content: '新的当前问题。' }, ...recentTools('-new'));
  const second = await engine.prepare(growth, []);
  assert.ok(summaries.length > firstCalls);
  const updateInput = JSON.parse(summaries[firstCalls].messages[1].content);
  assert.equal(updateInput.previousSummary, firstDraft.summary);
  assert.ok(engine.checkpointDraft()!.coveredCount > firstDraft.coveredCount);
  assert.equal(engine.checkpointDraft()!.expectedGeneration, 0, '多次临时更新仍以最初代际原子提交');
  assert.deepEqual(second.slice(-3), growth.slice(-3));
});

test('单个长工具循环也能压缩早期步骤，真实 user 锚点和最新多工具组仍原样保留', async () => {
  const { provider, summaries } = scripted();
  const currentUser: Message = { role: 'user', content: '这是唯一的真实用户任务，请一直核对到结果完成。' };
  const input: Message[] = [{ role: 'system', content: '系统规则保持冻结。' }, currentUser];
  for (let index = 0; index < 9; index++) {
    input.push({ role: 'assistant', content: `第 ${index} 步`, reasoningContent: `old_reasoning_${index}`,
      toolCalls: [{ id: `loop-${index}`, name: 'calculator', arguments: { expression: `${index}+1` } }] },
    { role: 'tool', content: `第 ${index} 次结果：${'过程'.repeat(700)}`, toolCallId: `loop-${index}` });
  }
  input.push(...recentTools('-loop-end'));
  const original = structuredClone(input);
  // 避免仅靠工具摘录就降到阈值以下，确保本例确实走跨越当前 user 的摘要路径。
  const engine = new ContextEngine(provider, BUDGET, { ...OPTIONS, toolChars: 5000 });
  const prepared = await engine.prepare(input, []);
  assert.ok(summaries.length > 0);
  assert.ok(engine.checkpointDraft()!.coveredCount > 1);
  assert.equal(prepared.filter(message => message.role === 'user').length, 1);
  assert.deepEqual(prepared.find(message => message.role === 'user'), currentUser);
  assert.deepEqual(prepared.slice(-3), original.slice(-3));
  const pending = new Set<string>();
  for (const message of prepared) {
    if (message.role === 'assistant') for (const call of message.toolCalls ?? []) pending.add(call.id);
    if (message.role === 'tool') assert.ok(pending.delete(message.toolCallId!), '不能出现没有调用来源的工具结果');
  }
  assert.equal(pending.size, 0);
  assert.deepEqual(input, original);
});

test('重启后的检查点必须匹配完整历史指纹，元数据变化也拒绝复用', async () => {
  const { provider, summaries } = scripted();
  const input = history();
  const initial = new ContextEngine(provider, BUDGET, OPTIONS);
  const prepared = await initial.prepare(input, []), draft = initial.checkpointDraft()!;
  const checkpoint: ContextCheckpoint = { sessionId: 'session', generation: 3, updatedAt: '2026-11-05',
    coveredCount: draft.coveredCount, prefixHash: draft.prefixHash, summary: draft.summary };
  const previousCalls = summaries.length;
  const restarted = new ContextEngine(provider, BUDGET, OPTIONS, { checkpoint });
  assert.deepEqual(await restarted.prepare(input, []), prepared);
  assert.equal(summaries.length, previousCalls);
  assert.equal(restarted.checkpointDraft(), undefined, '只复用持久检查点时没有新草稿');
  const changed = structuredClone(input);
  changed[1].reasoningContent = '即使只改变协议元数据也应失效';
  await assert.rejects(restarted.prepare(changed, []), /checkpoint does not match/);
  await assert.rejects(new ContextEngine(provider, BUDGET, OPTIONS,
    { checkpoint: { ...checkpoint, coveredCount: input.length + 1 } }).prepare(input, []), /checkpoint does not match/);
  assert.equal(summaries.length, previousCalls);
});

test('请求预算包含工具 schema，精确边界通过，多一个字符拒绝且不调用模型', async () => {
  const tools: ToolSchema[] = [{ type: 'function', function: {
    name: 'test_tool', description: '说明'.repeat(80), parameters: { type: 'object', properties: {} },
  } }];
  const messages: Message[] = [{ role: 'system', content: '提示' }, { role: 'user', content: '' }];
  messages[1].content = 'x'.repeat(1000 - contextSize(messages, tools));
  assert.equal(contextSize(messages, tools), 1000);
  assert.equal(contextSize(messages, tools), messages.reduce((size, message) => size + messageSize(message), 0)
    + JSON.stringify(tools).length);
  const { provider, modelRequests } = scripted();
  const engine = new ContextEngine(provider, 1000, { enabled: false });
  assert.equal((await engine.complete(messages, tools)).content, '最终答复');
  assert.deepEqual(modelRequests[0].tools, tools);
  const overflow = structuredClone(messages);
  overflow[1].content += 'x';
  await assert.rejects(engine.complete(overflow, tools), ContextBudgetExceeded);
  assert.equal(modelRequests.length, 1);
});

test('工具 schema 自身占满硬预算时明确失败，不把 schema 从请求中移除', async () => {
  const { provider, modelRequests } = scripted();
  const tools: ToolSchema[] = [{ type: 'function', function: {
    name: 'large_tool', description: 'x'.repeat(1400), parameters: { type: 'object' },
  } }];
  const engine = new ContextEngine(provider, 1000, OPTIONS);
  await assert.rejects(engine.complete([{ role: 'system', content: '系统' },
    { role: 'user', content: '当前问题' }], tools), ContextBudgetExceeded);
  assert.equal(modelRequests.length, 0);
  assert.equal(engine.checkpointDraft(), undefined);
});

const invalidSummaries: Array<[string, ModelResponse]> = [
  ['空摘要', { content: '' }],
  ['超过摘要上限', { content: summary('x'.repeat(200)) }],
  ['缺少结构化标题', { content: '只说任务完成，没有任何要求的标题。' }],
  ['摘要调用了工具', { content: summary(), toolCalls: [{ id: 'forbidden', name: 'calculator', arguments: {} }] }],
];
for (const [label, response] of invalidSummaries) {
  test(`${label}：软阈值失败保留全部历史，硬预算失败报错，均不产生检查点`, async () => {
    const { provider } = scripted(() => response);
    const softInput = oneOldRecord(4700), before = structuredClone(softInput);
    assert.ok(contextSize(softInput) > BUDGET * 0.75 && contextSize(softInput) < BUDGET);
    const soft = new ContextEngine(provider, BUDGET, OPTIONS);
    assert.deepEqual(await soft.prepare(softInput, []), before);
    assert.deepEqual(softInput, before);
    assert.equal(soft.checkpointDraft(), undefined);
    const hard = new ContextEngine(provider, BUDGET, OPTIONS);
    await assert.rejects(hard.prepare(oneOldRecord(8000), []), ContextBudgetExceeded);
    assert.equal(hard.checkpointDraft(), undefined);
  });
}

test('有效格式却没有腾出空间的摘要也不能替换原历史', async () => {
  const candidate = summary('x'.repeat(25));
  assert.ok(candidate.length <= 300);
  const { provider, summaries } = scripted(() => ({ content: candidate }));
  const input: Message[] = [{ role: 'system', content: '系统' }, { role: 'user', content: '旧问题' },
    { role: 'assistant', content: '旧答复'.repeat(20) }, { role: 'user', content: '新'.repeat(900) }];
  const engine = new ContextEngine(provider, 2000,
    { threshold: 0.5, targetRatio: 0.2, summaryChars: 300, tailMessages: 1, memoryFlush: false });
  assert.deepEqual(await engine.prepare(input, []), input);
  assert.ok(summaries.length > 0);
  assert.equal(engine.checkpointDraft(), undefined);
});

test('调用方取消摘要时保留取消原因，迟到响应不产生检查点', async () => {
  let resolveSummary!: (response: ModelResponse) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const { provider, summaries, modelRequests } = scripted(() => {
    started();
    return new Promise<ModelResponse>(resolve => { resolveSummary = resolve; });
  });
  const engine = new ContextEngine(provider, BUDGET, OPTIONS), controller = new AbortController();
  const result = engine.complete(history(), [], controller.signal);
  await ready;
  const reason = new Error('用户取消本轮');
  controller.abort(reason);
  await assert.rejects(result, error => error === reason);
  assert.equal(summaries[0].signal?.aborted, true);
  resolveSummary({ content: summary() });
  await Promise.resolve();
  assert.equal(engine.checkpointDraft(), undefined);
  assert.equal(modelRequests.length, 0);
});

test('辅助模型超时后软预算保留历史，硬预算失败，底层信号被取消', async () => {
  const { provider, summaries } = scripted(() => new Promise<ModelResponse>(() => {}));
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const soft = new ContextEngine(provider, BUDGET, { ...OPTIONS, timeoutMs: 5 },
    { emit: (event, payload) => events.push({ event, payload }) });
  const input = oneOldRecord(4700);
  assert.deepEqual(await soft.prepare(input, []), input);
  assert.equal(soft.checkpointDraft(), undefined);
  assert.equal(summaries[0].signal?.aborted, true);
  assert.ok(events.some(item => item.event === 'context.compress.failed' && item.payload.error === 'TimeoutError'));
  const hard = new ContextEngine(provider, BUDGET, { ...OPTIONS, timeoutMs: 5 });
  await assert.rejects(hard.prepare(oneOldRecord(8000), []), ContextBudgetExceeded);
  assert.equal(hard.checkpointDraft(), undefined);
});

test('超长历史分批送入摘要器，每批不超预算，单条摘录明确标记省略', async () => {
  const budget = 3000;
  const { provider, summaries } = scripted();
  const input = history(5000, 10), original = structuredClone(input);
  const engine = new ContextEngine(provider, budget,
    { summaryChars: 400, tailMessages: 1, memoryFlush: false });
  const prepared = await engine.prepare(input, []);
  assert.ok(summaries.length > 1, '超长旧记录应分成多个有界请求');
  for (const request of summaries) {
    assert.ok(contextSize(request.messages, request.tools) <= budget);
    assert.ok(request.messages[0].content.startsWith(SUMMARY_TASK));
  }
  const first = JSON.parse(summaries[0].messages[1].content);
  const second = JSON.parse(summaries[1].messages[1].content);
  assert.equal(first.previousSummary, '');
  assert.equal(second.previousSummary, summary('摘要第 1 批'));
  assert.ok(summaries.some(request => request.messages[1].content.includes('中间内容省略')));
  assert.ok(contextSize(prepared) <= budget);
  assert.ok(engine.checkpointDraft());
  assert.deepEqual(input, original);
});

test('清理旧工具输出优先于摘要，Skill 提示重新加载，最新多工具组完整保留', async () => {
  const { provider, summaries } = scripted();
  const input: Message[] = [
    { role: 'system', content: '系统提示' }, { role: 'user', content: '先读技能再计算' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'skill', name: 'skill_read', arguments: { name: 'study' } }] },
    { role: 'tool', content: '技能正文'.repeat(1000), toolCallId: 'skill' },
    { role: 'assistant', content: '已读技能，现在计算。', toolCalls: [{ id: 'old-calc', name: 'calculator', arguments: {} }] },
    { role: 'tool', content: '旧计算输出'.repeat(1000), toolCallId: 'old-calc' },
    { role: 'assistant', content: '旧任务完成' }, { role: 'user', content: '请检查当前结果' },
    ...recentTools(),
  ];
  input.at(-2)!.content = '新工具结果一'.repeat(150);
  input.at(-1)!.content = '新工具结果二'.repeat(150);
  const original = structuredClone(input);
  const engine = new ContextEngine(provider, BUDGET, { ...OPTIONS, toolChars: 200 });
  const prepared = await engine.prepare(input, []);
  assert.equal(summaries.length, 0, '仅清理旧输出足够时不用额外请求摘要模型');
  assert.equal(engine.checkpointDraft(), undefined);
  assert.deepEqual(prepared.slice(-3), original.slice(-3));
  const prunedSkill = prepared.find(message => message.toolCallId === 'skill')!;
  assert.ok(prunedSkill.content.length < original[3].content.length);
  assert.match(prunedSkill.content, /SKILL_PRUNED/u);
  assert.match(prunedSkill.content, /skill_read/u);
  assert.match(prunedSkill.content, /history_search/u);
  assert.equal(prunedSkill.toolCallId, 'skill');
  assert.deepEqual(input, original);
});

test('跨轮复用工具 ID 时按当前调用类型裁剪，旧 Skill 重载提示与最新多工具组都正确', async () => {
  const { provider, summaries } = scripted();
  const latest = recentTools('-reuse');
  latest[0].toolCalls![0].id = 'reused';
  latest[1].toolCallId = 'reused';
  latest[1].content = '最新结果一'.repeat(180);
  latest[2].content = '最新结果二'.repeat(180);
  const input: Message[] = [
    { role: 'system', content: '固定规则' }, { role: 'user', content: '读取技能并计算' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'reused', name: 'skill_read', arguments: { name: 'study' } }] },
    { role: 'tool', content: '旧技能正文'.repeat(1000), toolCallId: 'reused' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'reused', name: 'calculator', arguments: { expression: '1+1' } }] },
    { role: 'tool', content: '旧计算正文'.repeat(1000), toolCallId: 'reused' },
    { role: 'assistant', content: '旧任务完成' }, { role: 'user', content: '检查最新计算结果' }, ...latest,
  ];
  const original = structuredClone(input);
  const engine = new ContextEngine(provider, BUDGET, { ...OPTIONS, toolChars: 200 });
  const prepared = await engine.prepare(input, []);
  const reusedResults = prepared.filter(message => message.role === 'tool' && message.toolCallId === 'reused');
  assert.equal(reusedResults.length, 3);
  assert.match(reusedResults[0].content, /SKILL_PRUNED/u);
  assert.match(reusedResults[0].content, /skill_read\(\{"name":"study"\}\)/u);
  assert.doesNotMatch(reusedResults[1].content, /SKILL_PRUNED/u);
  assert.ok(reusedResults[0].content.length < original[3].content.length);
  assert.ok(reusedResults[1].content.length < original[5].content.length);
  assert.deepEqual(prepared.slice(-3), original.slice(-3), '最近完整多工具组及 reasoning 不参与裁剪');
  assert.equal(summaries.length, 0);
  assert.deepEqual(input, original);
});

test('压缩事件只包含计数和类别，记忆 flush 失败不破坏成功摘要', async () => {
  const { provider } = scripted();
  const events: Record<string, unknown>[] = [];
  let flushCount = 0;
  const engine = new ContextEngine(provider, BUDGET, { ...OPTIONS, memoryFlush: true }, {
    emit: (event, payload) => events.push({ event, ...payload }),
    flushMemory: async () => {
      flushCount++;
      const error = new Error('私有记忆正文不能出现在事件里');
      error.name = '私有记忆正文也不能通过异常名称泄漏';
      throw error;
    },
  });
  await engine.prepare(history(), []);
  assert.equal(flushCount, 1);
  assert.ok(engine.checkpointDraft());
  assert.ok(events.some(item => item.event === 'memory.flush.failed' && item.error === 'Error'));
  const encoded = JSON.stringify(events);
  assert.equal(encoded.includes('私有记忆正文'), false);
  assert.equal(encoded.includes('old_record_'), false);
  assert.equal(encoded.includes('摘要第'), false);
});
