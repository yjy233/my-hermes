import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { Agent } from '../src/core/agent.js';
import { ContextCompressor } from '../src/core/compression/compressor.js';
import { CompressingProvider } from '../src/core/compression/provider.js';
import { compressionSettings, initialCompressionState, type SummaryFailure } from '../src/core/compression/settings.js';
import { buildSummaryPrompt, summaryMessage, withoutSummaries } from '../src/core/compression/text.js';
import { messageGroups } from '../src/core/compression/window.js';
import { ContextBudgetExceeded, ProviderError } from '../src/core/errors.js';
import { requestSize, type Message, type ModelResponse, type Provider, type ToolSchema } from '../src/core/models.js';
import { LongTermMemory, SessionStore } from '../src/memory/index.js';
import { SkillCatalog } from '../src/skills/catalog.js';
import { ToolRegistry } from '../src/core/tools.js';
import { runLoop } from '../src/learning/exercises.js';
import { loadSettings } from '../src/config.js';

const checkpoint = '## Outstanding request\nContinue investigating src/example.ts.\n## Completed actions\nRead the implementation; validation is still pending.\n## Constraints and preferences\nKeep the original files.';
const summaryProvider: Provider = { async complete() { return { content: checkpoint }; } };
const settings = { protectLast: 4, summaryChars: 2000 };

function history(turns = 18): Message[] {
  return [{ role: 'system', content: 'A fixed system prompt.' },
    ...Array.from({ length: turns }, (_, index): Message[] => [
      { role: 'user', content: `Question ${index}: ` + 'detail '.repeat(40) },
      { role: 'assistant', content: `Observation ${index}: ` + 'evidence '.repeat(100) },
    ]).flat(), { role: 'user', content: 'Stop the old task. Just verify the current result.' }];
}

function toolRound(id: string, size = 2500, name = 'read_file'): Message[] {
  return [{ role: 'assistant', content: '', reasoningContent: `reasoning-${id}`,
    toolCalls: [{ id, name, arguments: name === 'skill_read' ? { name: 'study-notes' } : { path: 'src/example.ts' } }] },
  { role: 'tool', toolCallId: id, content: JSON.stringify({ ok: true, result: `${id}:` + 'x'.repeat(size) }) }];
}

function assertPairs(messages: Message[]): void {
  const pending = new Set<string>();
  for (const row of messages) {
    if (row.role === 'tool') assert.ok(pending.delete(row.toolCallId!), `orphan result ${row.toolCallId}`);
    else {
      assert.equal(pending.size, 0, 'tool round split');
      for (const call of row.toolCalls ?? []) pending.add(call.id);
    }
  }
  assert.equal(pending.size, 0);
}

test('below threshold and disabled compression leave both context and provider untouched', async () => {
  const provider: Provider = { async complete() { throw new Error('unexpected call'); } };
  const messages = history(1);
  const compressor = new ContextCompressor({ provider, maxChars: 24_000 });
  assert.equal((await compressor.compress(messages, [])).messages, messages);
  const disabled = new ContextCompressor({ provider, maxChars: 24_000, settings: { enabled: false } });
  assert.equal((await disabled.compress(history(), [], undefined, true)).changed, false);
});

test('structured summary preserves head, current request, immutable history and bounded redacted prompt', async () => {
  const input = history(), original = structuredClone(input);
  input[5].content += ' api_key="sensitive-value-123"';
  const before = structuredClone(input);
  const observed: Message[][] = [];
  const provider: Provider = { async complete(messages, tools) {
    assert.deepEqual(tools, []);
    assert.ok(requestSize(messages, tools) <= 24_000);
    observed.push(structuredClone(messages));
    return { content: checkpoint + '\npassword="never-echo-this"' };
  } };
  const result = await new ContextCompressor({ provider, maxChars: 24_000, settings, memory: 'api_key="memory-secret"' }).compress(input, []);
  assert.equal(result.method, 'summary');
  assert.deepEqual(result.messages.slice(0, 3), original.slice(0, 3));
  assert.deepEqual(result.messages.at(-1), input.at(-1));
  assert.deepEqual(input, before);
  assert.equal(result.messages.filter(row => row.contextSummary).length, 1);
  assert.ok(requestSize(result.messages, []) < requestSize(input, []));
  const prompt = JSON.stringify(observed);
  assert.match(prompt, /Completed actions|Completed Actions/);
  assert.match(prompt, /earlier checkpoint/);
  for (const secret of ['sensitive-value-123', 'memory-secret']) assert.ok(!prompt.includes(secret));
  assert.ok(!JSON.stringify(result.messages.find(row => row.contextSummary)).includes('never-echo-this'));
  assertPairs(result.messages);
});

test('prompt input remains bounded for escaped text, previous checkpoint and memory; no-user provenance is explicit', () => {
  const messages: Message[] = [{ role: 'assistant', content: '\\"\n'.repeat(30_000) }];
  const prompt = buildSummaryPrompt({ middle: messages, previous: '', memory: 'm'.repeat(80_000), focus: 'f'.repeat(5000),
    summaryChars: 1000, inputChars: 12_000, date: '2026-11-05' })!;
  assert.ok(requestSize(prompt, []) <= 12_000);
  assert.match(prompt[0].content, /no user-authored turns/);
  assert.match(prompt[0].content, /2026-11-05/);
  assert.equal(buildSummaryPrompt({ middle: messages, previous: '', memory: '', focus: '',
    summaryChars: 256, inputChars: 100, date: '2026-11-05' }), null);
});

test('large stale tools are pruned without a model call, preserving current observations and tool arguments', async () => {
  const messages: Message[] = [{ role: 'system', content: 'fixed' }, { role: 'user', content: 'first' },
    { role: 'assistant', content: 'starting' }, ...toolRound('old', 18_000), { role: 'assistant', content: 'read complete' },
    { role: 'user', content: 'current' }, ...toolRound('current', 2000)];
  const original = structuredClone(messages);
  const provider: Provider = { async complete() { throw new Error('prune should be enough'); } };
  const result = await new ContextCompressor({ provider, maxChars: 24_000, settings: { protectLast: 3 } }).compress(messages, []);
  assert.equal(result.method, 'prune');
  const old = result.messages.find(row => row.toolCallId === 'old')!;
  assert.equal(JSON.parse(old.content).compressed, true);
  assert.deepEqual(result.messages.slice(-2), messages.slice(-2));
  assert.deepEqual(result.messages.find(row => row.toolCalls?.[0].id === 'old')?.toolCalls, messages[3].toolCalls);
  assert.deepEqual(messages, original);
  assertPairs(result.messages);
});

test('single long tool loop keeps latest user after checkpoint, full newest tool round and reasoning', async () => {
  const messages: Message[] = [{ role: 'system', content: 'fixed' }, { role: 'user', content: 'Do the whole task.' },
    ...Array.from({ length: 10 }, (_, index) => toolRound(String(index), 1800)).flat()];
  const original = structuredClone(messages);
  const result = await new ContextCompressor({ provider: summaryProvider, maxChars: 24_000, settings }).compress(messages, []);
  assert.equal(result.method, 'summary');
  const summaryIndex = result.messages.findIndex(row => row.contextSummary);
  assert.ok(result.messages.findIndex(row => row.role === 'user') >= summaryIndex);
  assert.deepEqual(withoutSummaries(result.messages).find(row => row.role === 'user'), messages[1]);
  assert.deepEqual(result.messages.slice(-2), messages.slice(-2));
  assert.deepEqual(messages, original);
  assertPairs(result.messages);
});

test('repeated compression updates prior summary and deterministically keeps skill reload reminders', async () => {
  const observed: Message[][] = [];
  const provider: Provider = { async complete(messages) { observed.push(structuredClone(messages)); return { content: checkpoint }; } };
  const old = summaryMessage('## Goal\nRemember the earlier design.\n[Reload skill: study-notes]');
  const messages = history();
  messages.splice(3, 0, old);
  const result = await new ContextCompressor({ provider, maxChars: 24_000, settings }).compress(messages, []);
  assert.equal(result.method, 'summary');
  assert.match(JSON.stringify(observed), /Remember the earlier design/);
  assert.match(observed[0][0].content, /Update the earlier checkpoint/);
  assert.equal(result.messages.filter(row => row.contextSummary).length, 1);
  assert.match(result.messages.find(row => row.contextSummary)!.content, /\[Reload skill: study-notes\]/);
});

test('malformed historical tool groups are repaired without leaving orphaned or duplicate results', () => {
  const messages = toolRound('a');
  messages[0].toolCalls!.push({ id: 'missing', name: 'read_file', arguments: {} });
  messages.push(structuredClone(messages[1]), { role: 'tool', toolCallId: 'orphan', content: 'bad' });
  const result = messageGroups(messages).flat();
  assertPairs(result);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0].toolCalls?.map(call => call.id), ['a']);
});

for (const kind of ['access', 'network', 'timeout', 'overload', 'empty', 'truncated', 'invalid'] as const satisfies readonly SummaryFailure[]) {
  test(`${kind} summary failure preserves entire unpruned history and arms cooldown`, async () => {
    let calls = 0;
    const provider: Provider = { async complete() { calls++; throw new ProviderError('private upstream error', kind); } };
    const events: unknown[] = [];
    const compressor = new ContextCompressor({ provider, maxChars: 24_000, settings,
      emit: (event, payload) => events.push([event, payload]) });
    const messages = history();
    messages.splice(5, 0, ...toolRound('stale-sensitive-observation', 8000));
    assert.equal((await compressor.compress(messages, [])).messages, messages);
    assert.equal((await compressor.compress(messages, [])).messages, messages);
    assert.equal(calls, 1);
    assert.equal(compressor.snapshot().lastFailure, kind);
    assert.ok(compressor.snapshot().cooldownUntil > Date.now());
    assert.ok(!JSON.stringify(events).includes('private upstream error'));
  });
}

for (const content of ['', '  ', '<think>internal only</think>', '<think>unclosed\n## Internal reasoning', "I'm sorry, I cannot summarize this.", 'not a checkpoint']) {
  test(`unusable summary is never committed: ${JSON.stringify(content)}`, async () => {
    const provider: Provider = { async complete() { return { content }; } };
    const messages = history();
    assert.equal((await new ContextCompressor({ provider, maxChars: 24_000, settings }).compress(messages, [])).messages, messages);
  });
}

test('an auxiliary failure retries the main model exactly once', async () => {
  let auxiliaryCalls = 0, mainCalls = 0;
  const auxiliary: Provider = { async complete() { auxiliaryCalls++; throw new ProviderError('denied', 'access'); } };
  const main: Provider = { async complete() { mainCalls++; return { content: checkpoint }; } };
  const compressor = new ContextCompressor({ provider: main, summaryProvider: auxiliary, maxChars: 24_000, settings });
  assert.equal((await compressor.compress(history(), [])).method, 'summary');
  assert.equal(auxiliaryCalls, 1); assert.equal(mainCalls, 1);
  assert.equal(compressor.snapshot().failures, 0);
});

test('generic summary failure uses a bounded local fallback, unless configured to preserve history', async () => {
  const provider: Provider = { async complete() { throw new Error('unavailable summarizer'); } };
  const messages = history();
  const result = await new ContextCompressor({ provider, maxChars: 24_000, settings }).compress(messages, []);
  assert.equal(result.method, 'fallback');
  assert.match(result.messages.find(row => row.contextSummary)!.content, /Local fallback/);
  const strict = new ContextCompressor({ provider, maxChars: 24_000, settings: { ...settings, abortOnFailure: true } });
  assert.equal((await strict.compress(messages, [])).messages, messages);
});

test('repeated timeout/overload escalates cooldown and eventually permits deterministic recovery', async () => {
  const provider: Provider = { async complete() { throw new ProviderError('busy', 'overload'); } };
  const compressor = new ContextCompressor({ provider, maxChars: 24_000, settings });
  const messages = history();
  assert.equal((await compressor.compress(messages, [], undefined, true)).changed, false);
  assert.equal((await compressor.compress(messages, [], undefined, true)).changed, false);
  const result = await compressor.compress(messages, [], undefined, true);
  assert.equal(result.method, 'fallback');
  assert.equal(compressor.snapshot().failures, 3);
  assert.ok(compressor.snapshot().cooldownUntil - Date.now() > 899_000);
});

test('summary timeout ignores late success, and caller cancellation leaves compressor state unchanged', async () => {
  let finish!: (value: ModelResponse) => void;
  const provider: Provider = { complete() { return new Promise(resolve => { finish = resolve; }); } };
  const messages = history();
  const compressor = new ContextCompressor({ provider, maxChars: 24_000, settings: { ...settings, timeoutMs: 5 } });
  assert.equal((await compressor.compress(messages, [])).messages, messages);
  const after = compressor.snapshot();
  finish({ content: checkpoint }); await nextTurn();
  assert.deepEqual(compressor.snapshot(), after);
  const controller = new AbortController(), reason = new Error('cancel this turn');
  const cancelled = new ContextCompressor({ provider, maxChars: 24_000, settings });
  const work = cancelled.compress(messages, [], controller.signal);
  await nextTurn(); controller.abort(reason);
  await assert.rejects(work, error => error === reason);
  finish({ content: checkpoint }); await nextTurn();
  assert.deepEqual(cancelled.snapshot(), initialCompressionState());
});

test('protected content and schema pressure cannot cause a pointless summary loop', async () => {
  let calls = 0;
  const provider: Provider = { async complete() { calls++; return { content: checkpoint }; } };
  const messages: Message[] = [{ role: 'system', content: 'fixed' }, { role: 'user', content: 'x'.repeat(25_000) }];
  const compressor = new ContextCompressor({ provider, maxChars: 24_000 });
  const wrapper = new CompressingProvider(provider, compressor, 24_000);
  await assert.rejects(() => wrapper.complete(messages, []), ContextBudgetExceeded);
  assert.equal(calls, 0);
  const tools: ToolSchema[] = [{ type: 'function', function: { name: 'huge', description: 'x'.repeat(24_000), parameters: {} } }];
  assert.equal((await compressor.compress(history(), tools, undefined, true)).changed, false);
  assert.equal(calls, 0);
});

test('provider-confirmed overflow forces bounded recovery below the proactive threshold', async () => {
  let mainCalls = 0, summaryCalls = 0;
  const main: Provider = { async complete() {
    if (++mainCalls === 1) throw new ProviderError('overflow', 'context_length', 400);
    return { content: 'recovered' };
  } };
  const summary: Provider = { async complete() { summaryCalls++; return { content: checkpoint }; } };
  const compressor = new ContextCompressor({ provider: main, summaryProvider: summary, maxChars: 30_000,
    settings: { ...settings, threshold: 0.95 } });
  const wrapper = new CompressingProvider(main, compressor, 30_000);
  assert.equal((await wrapper.complete(history(12), [])).content, 'recovered');
  assert.equal(mainCalls, 2); assert.equal(summaryCalls, 1);
});

test('a real learner tool loop compresses between requests without replaying tools or losing its full delta', async () => {
  let actions = 0, modelCalls = 0, summaries = 0;
  const observed: Message[][] = [];
  const registry = new ToolRegistry();
  registry.register({ name: 'long_result', description: 'produce evidence', parameters: { type: 'object', properties: {} },
    handler: () => { actions++; return `result ${actions}: ` + 'e'.repeat(1800); } });
  const main: Provider = { async complete(messages) {
    observed.push(structuredClone(messages));
    if (modelCalls++ < 10) return { content: '', toolCalls: [{ id: `call-${modelCalls}`, name: 'long_result', arguments: {} }] };
    return { content: 'finished' };
  } };
  const summary: Provider = { async complete() { summaries++; return { content: checkpoint }; } };
  const wrapper = new CompressingProvider(main, new ContextCompressor({ provider: main, summaryProvider: summary,
    maxChars: 14_000, settings: { ...settings, threshold: 0.75 } }), 14_000);
  const input: Message[] = [{ role: 'system', content: 'fixed' }, { role: 'user', content: 'Finish all ten actions.' }];
  const delta = await runLoop(wrapper, registry, input, 12, () => undefined);
  assert.equal(actions, 10);
  assert.equal(delta.length, 21);
  assert.equal(delta.filter(row => row.role === 'tool').length, 10);
  assert.ok(observed.every(rows => requestSize(rows, registry.schemas()) <= 14_000));
  assert.ok(summaries > 0);
  for (const rows of observed) assertPairs(rows);
});

test('Agent commits active checkpoint with full history atomically and resumes it after reopening SQLite', async t => {
  const root = mkdtempSync(join(tmpdir(), 'my-hermes-compression-'));
  let store = new SessionStore(join(root, 'sessions.db'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const session = store.getOrCreate('session', 'alice');
  store.setSystemPrompt(session.id, 'A fixed system prompt.');
  const raw = history().slice(1, -1);
  store.appendMessages(session.id, raw);
  let summaries = 0;
  const observed: Message[][] = [];
  const main: Provider = { async complete(messages) { observed.push(structuredClone(messages)); return { content: 'verified' }; } };
  const summary: Provider = { async complete() { summaries++; return { content: checkpoint }; } };
  const agent = () => new Agent({ provider: main, summaryProvider: summary, store,
    memory: new LongTermMemory(join(root, 'memory')), skills: new SkillCatalog([]), compression: { ...settings, memoryFlush: false } });
  await agent().run('session', 'alice', 'Verify now.');
  assert.equal(summaries, 1);
  assert.equal(store.loadMessages(session.id).length, raw.length + 2);
  assert.deepEqual(store.loadMessages(session.id).slice(0, raw.length), raw);
  assert.ok(store.loadContextMessages(session.id).some(row => row.contextSummary));
  assert.ok(store.search('Question 5', 'alice').length > 0);
  assert.deepEqual(store.search('Question 5', 'bob'), []);
  store.close(); store = new SessionStore(join(root, 'sessions.db'));
  await agent().run('session', 'alice', 'What was verified?');
  assert.equal(summaries, 1);
  assert.ok(observed.at(-1)!.some(row => row.contextSummary));
  assert.deepEqual(observed[0][0], observed[1][0]);
  assert.equal(store.loadMessages(session.id).length, raw.length + 4);
  // 模拟外部追加：旧 checkpoint 的水位不再匹配，应读取完整历史。
  store.appendMessages(session.id, [{ role: 'user', content: 'external' }, { role: 'assistant', content: 'saved' }]);
  assert.deepEqual(store.loadContextMessages(session.id), store.loadMessages(session.id));
});

test('failed Agent compaction persists only cooldown and preserves original history across restart', async t => {
  const root = mkdtempSync(join(tmpdir(), 'my-hermes-compression-fail-'));
  let store = new SessionStore(join(root, 'sessions.db'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const session = store.getOrCreate('session', 'alice');
  store.setSystemPrompt(session.id, 'A fixed system prompt.');
  const raw = history(30).slice(1, -1); store.appendMessages(session.id, raw);
  let calls = 0;
  const provider: Provider = { async complete() { calls++; throw new ProviderError('denied', 'access'); } };
  const agent = () => new Agent({ provider, store, memory: new LongTermMemory(join(root, 'memory')), skills: new SkillCatalog([]), compression: { ...settings, memoryFlush: false } });
  await assert.rejects(() => agent().run('session', 'alice', 'now'), ContextBudgetExceeded);
  assert.deepEqual(store.loadMessages(session.id), raw);
  assert.deepEqual(store.loadContextMessages(session.id), raw);
  store.close(); store = new SessionStore(join(root, 'sessions.db'));
  await assert.rejects(() => agent().run('session', 'alice', 'again'), ContextBudgetExceeded);
  assert.equal(calls, 1);
  assert.equal(store.loadCompressionState(session.id).lastFailure, 'access');
});

test('checkpoint serialization failure cannot partially commit original messages or overwrite the old snapshot', () => {
  const store = new SessionStore(':memory:');
  try {
    const session = store.getOrCreate('session', 'alice');
    const old: Message[] = [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'answer' }];
    store.appendMessages(session.id, old, { messages: old, state: initialCompressionState() });
    assert.throws(() => store.appendMessages(session.id, [{ role: 'user', content: 'new' }], {
      messages: [{ role: 'user', content: undefined } as unknown as Message], state: initialCompressionState(),
    }), /finite|Invalid/);
    assert.deepEqual(store.loadMessages(session.id), old);
    assert.deepEqual(store.loadContextMessages(session.id), old);
  } finally { store.close(); }
});

test('compression configuration validates nested settings and supports an auxiliary model', t => {
  const root = mkdtempSync(join(tmpdir(), 'my-hermes-compression-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const settings = loadSettings(root, { compression: { threshold: 0.7, summaryModel: 'summary-model' } });
  assert.equal(settings.compression.summaryModel, 'summary-model');
  assert.equal(settings.compression.enabled, true);
  assert.throws(() => compressionSettings({ threshold: 1 }), /threshold/);
  assert.throws(() => compressionSettings({ typo: true }), /Unknown compression/);
  assert.throws(() => compressionSettings({ timeoutMs: Infinity }), /timeoutMs/);
});

test('a SQLite checkpoint write failure rolls back the raw append and retains the prior checkpoint', t => {
  const root = mkdtempSync(join(tmpdir(), 'my-hermes-compression-transaction-'));
  const path = join(root, 'sessions.db'), store = new SessionStore(path), fault = new DatabaseSync(path);
  t.after(() => { fault.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const session = store.getOrCreate('session', 'alice');
  const old: Message[] = [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'answer' }];
  store.appendMessages(session.id, old, { messages: old, state: initialCompressionState() });
  fault.exec(`CREATE TRIGGER reject_checkpoint BEFORE UPDATE OF payload ON context_checkpoints
    BEGIN SELECT RAISE(ABORT, 'simulated checkpoint storage failure'); END;`);
  assert.throws(() => store.appendMessages(session.id, [{ role: 'user', content: 'new' }], {
    messages: [summaryMessage(checkpoint)], state: initialCompressionState(),
  }), /simulated checkpoint/);
  assert.deepEqual(store.loadMessages(session.id), old);
  assert.deepEqual(store.loadContextMessages(session.id), old);
});

test('cancelling an Agent during summarization publishes neither partial checkpoint nor cooldown', async t => {
  const root = mkdtempSync(join(tmpdir(), 'my-hermes-compression-cancel-'));
  const store = new SessionStore(join(root, 'sessions.db'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const session = store.getOrCreate('session', 'alice'), raw = history().slice(1, -1);
  store.setSystemPrompt(session.id, 'fixed'); store.appendMessages(session.id, raw);
  let started!: () => void, finish!: (response: ModelResponse) => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const summary: Provider = { complete() { started(); return new Promise(resolve => { finish = resolve; }); } };
  const main: Provider = { async complete() { throw new Error('main request must not start'); } };
  const agent = new Agent({ provider: main, summaryProvider: summary, store,
    memory: new LongTermMemory(join(root, 'memory')), skills: new SkillCatalog([]), compression: settings });
  const controller = new AbortController(), reason = new Error('cancel pending summary');
  const result = agent.run('session', 'alice', 'continue', controller.signal);
  await waiting; controller.abort(reason);
  await assert.rejects(result, error => error === reason);
  finish({ content: checkpoint }); await nextTurn();
  assert.deepEqual(store.loadMessages(session.id), raw);
  assert.deepEqual(store.loadContextMessages(session.id), raw);
  assert.deepEqual(store.loadCompressionState(session.id), initialCompressionState());
});

test('reactive model overflow never reexecutes an already completed tool', async () => {
  let actions = 0, requests = 0;
  const registry = new ToolRegistry();
  registry.register({ name: 'side_effect', description: 'count executions', parameters: { type: 'object', properties: {} },
    handler: () => { actions++; return 'done'; } });
  const main: Provider = { async complete() {
    requests++;
    if (requests === 1) return { content: '', toolCalls: [{ id: 'once', name: 'side_effect', arguments: {} }] };
    if (requests === 2) throw new ProviderError('provider overflow', 'context_length');
    return { content: 'finished after recovery' };
  } };
  const wrapper = new CompressingProvider(main, new ContextCompressor({ provider: main, summaryProvider,
    maxChars: 30_000, settings: { ...settings, threshold: 0.95 } }), 30_000);
  const delta = await runLoop(wrapper, registry, history(12), 3, () => undefined);
  assert.equal(actions, 1); assert.equal(requests, 3);
  assert.equal(delta.at(-1)?.content, 'finished after recovery');
  assertPairs(delta);
});
