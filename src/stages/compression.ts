/** L2 验收直接选择被测算法，模型只用本机内存 stub，不依赖 L1/L3 或真实凭证。 */
import assert from 'node:assert/strict';
import { ContextCompressor, type CompressorOptions } from '../core/compression/compressor.js';
import type { CompactHistory } from '../core/compression/types.js';
import { initialCompressionState } from '../core/compression/settings.js';
import { summaryMessage, withoutSummaries } from '../core/compression/text.js';
import { ProviderError } from '../core/errors.js';
import { requestSize, type Emit, type Message, type Provider } from '../core/models.js';
import type { StageCase } from './contracts.js';

const summary = '## Outstanding request\nVerify the current task.\n## Completed actions\nRead src/example.ts.\n## Constraints and preferences\nKeep the original history.';
const summarizer: Provider = { async complete() { return { content: summary }; } };

function history(): Message[] {
  return [{ role: 'system', content: 'Fixed identity.' }, ...Array.from({ length: 18 }, (_, index): Message[] => [
    { role: 'user', content: `Question ${index}: ` + 'detail '.repeat(40) },
    { role: 'assistant', content: `Evidence ${index}: ` + 'observation '.repeat(80) },
  ]).flat(), { role: 'user', content: 'Stop the previous task. Only verify the result.' }];
}
function round(id: string, size = 1800): Message[] {
  return [{ role: 'assistant', content: '', reasoningContent: `reasoning-${id}`,
    toolCalls: [{ id, name: 'read_file', arguments: { path: 'src/example.ts' } }] },
  { role: 'tool', toolCallId: id, content: JSON.stringify({ ok: true, result: 'x'.repeat(size) }) }];
}

export function compressionCases(algorithm: CompactHistory, emit: Emit): StageCase[] {
  const make = (options: Partial<CompressorOptions> = {}) => new ContextCompressor({
    provider: summarizer, maxChars: 24_000, settings: { protectLast: 4, summaryChars: 2000 }, ...options, algorithm, emit,
  });
  return [
    { name: 'L2/threshold-and-disabled-no-model', async run(signal) {
      let calls = 0;
      const provider: Provider = { async complete() { calls++; return { content: summary }; } };
      const messages: Message[] = [{ role: 'system', content: 'fixed' }, { role: 'user', content: 'hello' }];
      const normal = await make({ provider }).compress(messages, [], signal);
      assert.equal(normal.changed, false); assert.deepEqual(normal.messages, messages);
      assert.equal((await make({ provider, settings: { enabled: false } }).compress(history(), [], signal, true)).changed, false);
      assert.equal(calls, 0);
    } },
    { name: 'L2/structured-summary-prompt-and-immutability', async run(signal) {
      const messages = history(), original = structuredClone(messages), observed: Message[][] = [];
      const provider: Provider = { async complete(prompt, tools) {
        assert.deepEqual(tools, []); observed.push(structuredClone(prompt));
        return { content: summary };
      } };
      const result = await make({ provider }).compress(messages, [], signal);
      assert.equal(result.method, 'summary'); assert.equal(observed.length, 1);
      assert.ok(requestSize(observed[0], []) <= 24_000);
      const source = JSON.parse(observed[0][1].content);
      assert.ok(source.transcript); assert.equal(source.focus, messages.at(-1)!.content);
      assert.deepEqual(result.messages[0], messages[0]);
      assert.deepEqual(withoutSummaries(result.messages).at(-1), messages.at(-1));
      assert.ok(result.messages.some(row => row.contextSummary));
      assert.ok(requestSize(result.messages, []) < requestSize(messages, []));
      assert.deepEqual(messages, original);
    } },
    { name: 'L2/prune-tools-before-summary', async run(signal) {
      let calls = 0;
      const provider: Provider = { async complete() { calls++; return { content: summary }; } };
      const messages: Message[] = [{ role: 'system', content: 'fixed' }, { role: 'user', content: 'initial' },
        { role: 'assistant', content: 'started' }, ...round('old', 18_000), { role: 'assistant', content: 'read' },
        { role: 'user', content: 'current' }, ...round('current')];
      const result = await make({ provider, settings: { protectLast: 3 } }).compress(messages, [], signal);
      assert.equal(result.method, 'prune'); assert.equal(calls, 0);
      assert.equal(JSON.parse(result.messages.find(row => row.toolCallId === 'old')!.content).compressed, true);
      assert.deepEqual(result.messages.slice(-2), messages.slice(-2));
    } },
    { name: 'L2/inflight-user-and-complete-tool-round', async run(signal) {
      const messages: Message[] = [{ role: 'system', content: 'fixed' }, { role: 'user', content: 'Complete the task.' },
        ...Array.from({ length: 10 }, (_, i) => round(String(i))).flat()];
      const result = await make().compress(messages, [], signal);
      assert.equal(result.method, 'summary');
      assert.deepEqual(withoutSummaries(result.messages).find(row => row.role === 'user'), messages[1]);
      assert.deepEqual(result.messages.slice(-2), messages.slice(-2));
      const calls = result.messages.flatMap(row => row.toolCalls?.map(call => call.id) ?? []);
      const results = result.messages.filter(row => row.role === 'tool').map(row => row.toolCallId);
      assert.deepEqual(calls, results);
    } },
    { name: 'L2/update-previous-summary', async run(signal) {
      const messages = history();
      messages.splice(3, 0, summaryMessage('## Goal\nKeep the prior decision.\n[Reload skill: study-notes]'));
      const provider: Provider = { async complete(prompt) {
        assert.match(JSON.parse(prompt[1].content).previousCheckpoint, /Keep the prior decision/);
        return { content: summary };
      } };
      const result = await make({ provider }).compress(messages, [], signal);
      assert.equal(result.method, 'summary');
      const rows = result.messages.filter(row => row.contextSummary);
      assert.equal(rows.length, 1); assert.match(rows[0].content, /\[Reload skill: study-notes\]/);
    } },
    { name: 'L2/failure-preserves-history-and-cools-down', async run(signal) {
      let calls = 0;
      const provider: Provider = { async complete() { calls++; throw new ProviderError('denied', 'access'); } };
      const messages = history(), compressor = make({ provider });
      assert.deepEqual((await compressor.compress(messages, [], signal)).messages, messages);
      assert.deepEqual((await compressor.compress(messages, [], signal)).messages, messages);
      assert.equal(calls, 1); assert.equal(compressor.snapshot().lastFailure, 'access');
      assert.ok(compressor.snapshot().cooldownUntil > Date.now());
    } },
    { name: 'L2/auxiliary-fallback-once', async run(signal) {
      let auxiliaryCalls = 0, mainCalls = 0;
      const summaryProvider: Provider = { async complete() { auxiliaryCalls++; throw new ProviderError('empty', 'empty'); } };
      const provider: Provider = { async complete() { mainCalls++; return { content: summary }; } };
      assert.equal((await make({ provider, summaryProvider }).compress(history(), [], signal)).method, 'summary');
      assert.equal(auxiliaryCalls, 1); assert.equal(mainCalls, 1);
    } },
    { name: 'L2/cancel-does-not-create-fallback', async run(signal) {
      const controller = new AbortController(), reason = new Error('cancel L2 summary');
      const provider: Provider = { async complete() { controller.abort(reason); return { content: summary }; } };
      const compressor = make({ provider });
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      await assert.rejects(() => compressor.compress(history(), [], combined), error => error === reason);
      assert.deepEqual(compressor.snapshot(), initialCompressionState());
    } },
    { name: 'L2/deterministic-fallback-and-strict-policy', async run(signal) {
      const provider: Provider = { async complete() { throw new Error('summary unavailable'); } };
      const messages = history();
      assert.equal((await make({ provider }).compress(messages, [], signal)).method, 'fallback');
      const strict = make({ provider, settings: { abortOnFailure: true } });
      assert.deepEqual((await strict.compress(messages, [], signal)).messages, messages);
    } },
    { name: 'L2/protected-context-no-destructive-trim', async run(signal) {
      let calls = 0;
      const provider: Provider = { async complete() { calls++; return { content: summary }; } };
      const messages: Message[] = [{ role: 'system', content: 'fixed' }, { role: 'user', content: 'x'.repeat(25_000) }];
      const result = await make({ provider }).compress(messages, [], signal);
      assert.equal(result.changed, false); assert.deepEqual(result.messages, messages); assert.equal(calls, 0);
    } },
  ];
}
