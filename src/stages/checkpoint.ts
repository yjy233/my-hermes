/** 高级上下文与长期记忆验收；所有模型响应由本机脚本提供，不读取真实凭证。 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextEngine, contextSize, SUMMARY_SECTIONS } from '../core/context-engine.js';
import { ContextBudgetExceeded } from '../core/errors.js';
import type { Emit, Message, Provider, ToolSchema } from '../core/models.js';
import { hashContextPrefix, LongTermMemory, MemoryOperationError, SessionStore } from '../memory/index.js';
import type { StageCase } from './contracts.js';

const BUDGET = 8000;
const options = { tailMessages: 2, memoryFlush: false };
const tools: ToolSchema[] = [{ type: 'function', function: {
  name: 'calculator', description: '离线验收计算工具', parameters: {
    type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'],
  },
} }];

function longContext(): Message[] {
  const history: Message[] = [{ role: 'system', content: '固定的系统提示，不随摘要改变。' }];
  for (let index = 0; index < 10; index++) {
    history.push({ role: 'user', content: `第 ${index} 个历史问题` },
      { role: 'assistant', content: `history_marker_${index} ` + '历史中的实验结果和学习记录。'.repeat(90) });
  }
  history.push({ role: 'user', content: '保留当前问题：请计算 2+3。' },
    { role: 'assistant', content: '先使用计算工具。', reasoningContent: 'latest-tool-protocol-metadata',
      toolCalls: [{ id: 'latest-call', name: 'calculator', arguments: { expression: '2+3' } }] },
    { role: 'tool', content: '{"ok":true,"result":5}', toolCallId: 'latest-call' });
  return history;
}

function structuredSummary(): string {
  return SUMMARY_SECTIONS.map(section => `## ${section}\n离线记录：保留任务信息，不编造事实。`).join('\n\n');
}

function summarizer(onCall: () => void = () => undefined): Provider {
  return { async complete(messages, schemas, signal) {
    signal?.throwIfAborted();
    onCall();
    assert.deepEqual(schemas, [], '摘要模型不能调用业务工具');
    assert.ok(contextSize(messages, schemas) <= BUDGET, '摘要请求自身也必须满足预算');
    return { content: structuredSummary() };
  } };
}

function assertToolPairs(messages: Message[]): void {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool') {
      assert.ok(message.toolCallId && pending.delete(message.toolCallId), '工具结果必须匹配已保留的声明');
    } else {
      assert.equal(pending.size, 0, '进入下一条非工具消息前必须收齐当前组结果');
      for (const call of message.toolCalls ?? []) pending.add(call.id);
    }
  }
  assert.equal(pending.size, 0, '压缩视图不能保留未完成工具组');
}

async function temporary(run: (root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'hermes-compression-check-'));
  try { await run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

export function compressionCases(emit: Emit): StageCase[] {
  return [{
    name: 'Context/structured-summary-and-tool-pairs',
    async run(signal) {
      const input = longContext(), original = structuredClone(input);
      let summaries = 0, actual: Message[] = [];
      const main: Provider = { async complete(messages, schemas, modelSignal) {
        modelSignal?.throwIfAborted();
        actual = structuredClone(messages);
        assert.deepEqual(schemas, tools);
        return { content: '5' };
      } };
      const engine = new ContextEngine(main, BUDGET, options,
        { summaryProvider: summarizer(() => summaries++), emit });
      const answer = await engine.complete(input, tools, signal);
      assert.equal(answer.content, '5');
      assert.ok(summaries > 0, '较长历史必须实际请求摘要，不能只丢弃旧消息');
      assert.ok(contextSize(actual, tools) <= BUDGET);
      assert.deepEqual(actual[0], original[0], '冻结 system 不被改写');
      assert.ok(actual.some(message => message.content.includes('## 关键决策')));
      assert.deepEqual(actual.slice(-2), original.slice(-2), '最新工具声明、推理字段和结果完整保留');
      assert.ok(actual.some(message => message.content === original.at(-3)!.content), '当前真实 user 必须保留');
      assertToolPairs(actual);
      assert.ok(engine.checkpointDraft()?.coveredCount);
      assert.deepEqual(input, original, '摘要不能修改循环持有的原始历史');
    },
  }, {
    name: 'Context/failure-keeps-original',
    async run(signal) {
      const input = longContext(), original = structuredClone(input);
      const invalid: Provider = { async complete() { return { content: '缺少规定标题的无效摘要' }; } };
      const engine = new ContextEngine(invalid, BUDGET, options, { summaryProvider: invalid, emit });
      assert.ok(contextSize(input, tools) > BUDGET, '场景必须确实超过硬预算');
      await assert.rejects(() => engine.prepare(input, tools, signal), ContextBudgetExceeded);
      assert.equal(engine.checkpointDraft(), undefined, '失败摘要不能产生待提交检查点');
      assert.deepEqual(input, original, '摘要失败也不能清空或改写原始消息');
    },
  }, {
    name: 'Context/checkpoint-restart',
    run: signal => temporary(async root => {
      const path = join(root, 'sessions.db'), input = longContext();
      // prepare 模拟工具结果返回后的请求；提交时再补上成功的最终 assistant 答复。
      const raw: Message[] = [...input.slice(1), { role: 'assistant', content: '5' }];
      const store = new SessionStore(path);
      let summaries = 0;
      const provider = summarizer(() => summaries++);
      let sessionId: string;
      try {
        const session = store.getOrCreate('compression-session', 'alice');
        sessionId = session.id;
        const engine = new ContextEngine(provider, BUDGET, options, { summaryProvider: provider, emit });
        await engine.prepare(input, tools, signal);
        const checkpoint = engine.checkpointDraft();
        assert.ok(checkpoint, '先产生摘要，再验证持久化恢复');
        store.commitTurn(session.id, raw, checkpoint);
        assert.equal(store.search('history_marker_0', 'alice').length, 1, '原始历史仍然可检索');
      } finally { store.close(); }
      const reopened = new SessionStore(path);
      try {
        const checkpoint = reopened.loadCheckpoint(sessionId)!;
        assert.ok(checkpoint);
        assert.equal(checkpoint.prefixHash, hashContextPrefix(raw.slice(0, checkpoint.coveredCount)));
        assert.deepEqual(reopened.loadMessages(sessionId), raw);
        const before = summaries;
        const engine = new ContextEngine(provider, BUDGET, options, { checkpoint, summaryProvider: provider, emit });
        const restored = await engine.prepare([input[0], ...reopened.loadMessages(sessionId)], tools, signal);
        assert.ok(contextSize(restored, tools) <= BUDGET);
        assert.equal(summaries, before, '重启后相同历史复用有效摘要，不重复请求模型');
        assert.equal(engine.checkpointDraft(), undefined, '复用不会伪造新代际');
        assertToolPairs(restored);
      } finally { reopened.close(); }
    }),
  }, {
    name: 'Memory/atomic-curation-and-scope',
    run: signal => temporary(root => {
      signal?.throwIfAborted();
      const memory = new LongTermMemory(join(root, 'memory'), 64);
      memory.manage('alice', 'memory', [{ action: 'add', content: 'old fact '.repeat(6).trim() }]);
      const original = memory.read('alice', 'MEMORY.md');
      assert.throws(() => memory.manage('alice', 'memory', [
        { action: 'add', content: 'new fact requires more capacity' },
      ]), MemoryOperationError);
      assert.equal(memory.read('alice', 'MEMORY.md'), original, '超容量不允许部分落盘');
      const result = memory.manage('alice', 'memory', [
        // 整批按最终容量校验：即使 add 暂时超限，也可在后续 remove 腾出空间。
        { action: 'add', content: 'Project uses TypeScript.' },
        { action: 'remove', old_text: original },
      ]);
      assert.deepEqual(result.entries, ['Project uses TypeScript.']);
      assert.ok(result.usage.chars <= result.usage.limit);
      assert.equal(memory.read('bob', 'MEMORY.md'), '', '同文件名不能突破 scope 隔离');
      assert.equal(memory.read('alice', 'USER.md'), '', 'memory 与 user 两个目标保持独立');
    }),
  }];
}
