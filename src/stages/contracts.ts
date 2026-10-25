/** 具名验收契约直接运行所选算法，不回退到参考实现。 */
import assert from 'node:assert/strict';
import { calculate } from '../core/builtin-tools.js';
import { ContextBudgetExceeded, ExerciseNotImplemented, StepLimitExceeded } from '../core/errors.js';
import { messageSize, type Emit, type Message, type ModelResponse, type Provider } from '../core/models.js';
import { ToolRegistry } from '../core/tools.js';
import type { Algorithms } from '../learning/types.js';
import type { MemoryHit } from '../memory/store.js';

export interface StageCase {
  name: string;
  run: (signal?: AbortSignal) => void | Promise<void>;
}

const noop: Emit = () => undefined;
const user: Message = { role: 'user', content: 'Run the contract example.' };
const system: Message = { role: 'system', content: 'Fixed identity.' };

function providerFor(responses: ModelResponse[], observed: Message[][] = []): Provider {
  let calls = 0;
  return { async complete(messages, _tools, signal) {
    signal?.throwIfAborted();
    observed.push(structuredClone(messages));
    const response = responses[calls++];
    if (!response) throw new Error('Contract provider received an unexpected extra request');
    return structuredClone(response);
  } };
}

function successfulTrace(): Message[] {
  return [
    { role: 'user', content: 'Calculate using a private example.' },
    { role: 'assistant', content: '', toolCalls: [
      { id: 'call-1', name: 'calculator', arguments: { expression: '2+2', privateNote: 'never-copy-this-private-value' } },
    ] },
    { role: 'tool', content: '{"ok":true,"result":4}', toolCallId: 'call-1' },
    { role: 'assistant', content: '4' },
  ];
}

function size(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + messageSize(message), 0);
}

function coreCases(algorithms: Algorithms, emit: Emit): StageCase[] {
  return [
    { name: 'L1/plain-final', async run(signal) {
      const input = [structuredClone(system), structuredClone(user)];
      const original = structuredClone(input);
      const delta = await algorithms.runLoop(providerFor([{ content: 'A final answer.' }]),
        new ToolRegistry(), input, 2, emit, signal);
      assert.deepEqual(delta, [{ role: 'assistant', content: 'A final answer.' }], 'Return only new messages');
      assert.deepEqual(input, original, 'Do not mutate the caller history');
    } },
    { name: 'L1/multi-tool-observations', async run(signal) {
      const registry = new ToolRegistry();
      registry.register({ name: 'calculator', description: 'Bounded arithmetic', parameters: {
        type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'],
      }, handler: args => calculate(args.expression as string) });
      const input = [structuredClone(system), structuredClone(user)], original = structuredClone(input);
      const observed: Message[][] = [];
      const response: ModelResponse = { content: '', toolCalls: [
        { id: 'sum-call', name: 'calculator', arguments: { expression: '2+3' } },
        { id: 'product-call', name: 'calculator', arguments: { expression: '(2+3)*4' } },
      ] };
      const delta = await algorithms.runLoop(providerFor([response, { content: 'Verified 5 and 20.' }], observed),
        registry, input, 3, emit, signal);
      assert.deepEqual(delta.map(message => message.role), ['assistant', 'tool', 'tool', 'assistant']);
      assert.deepEqual(delta[0].toolCalls?.map(call => call.id), ['sum-call', 'product-call']);
      assert.equal(delta[1].toolCallId, 'sum-call');
      assert.equal(delta[2].toolCallId, 'product-call');
      assert.deepEqual(JSON.parse(delta[1].content), { ok: true, result: 5 });
      assert.deepEqual(JSON.parse(delta[2].content), { ok: true, result: 20 });
      assert.deepEqual(observed[1], [...input, ...delta.slice(0, 3)], 'The next model request must observe both tool results');
      assert.equal(delta[3].content, 'Verified 5 and 20.');
      assert.deepEqual(input, original, 'Tool execution must not mutate input messages');
    } },
    { name: 'L1/preserve-provider-reasoning', async run(signal) {
      const registry = new ToolRegistry();
      registry.register({ name: 'calculator', description: 'Example', parameters: { type: 'object' }, handler: () => 4 });
      const observed: Message[][] = [];
      const delta = await algorithms.runLoop(providerFor([
        { content: '', reasoningContent: 'provider-tool-metadata', toolCalls: [
          { id: 'reasoned-call', name: 'calculator', arguments: {} },
        ] },
        { content: '4', reasoningContent: 'provider-final-metadata' },
      ], observed), registry, [structuredClone(user)], 3, emit, signal);
      assert.equal(observed[1].at(-2)?.reasoningContent, 'provider-tool-metadata',
        'The next tool request must retain provider reasoning metadata');
      assert.equal(delta[0].reasoningContent, 'provider-tool-metadata');
      assert.equal(delta.at(-1)?.reasoningContent, 'provider-final-metadata');
      assert.equal(delta.at(-1)?.content, '4', 'Metadata is not the final user-facing text');
    } },
    { name: 'L1/unknown-tool-error-observation', async run(signal) {
      const response: ModelResponse = { content: '', toolCalls: [{ id: 'missing-call', name: 'not_registered', arguments: {} }] };
      const observed: Message[][] = [];
      const delta = await algorithms.runLoop(providerFor([response, { content: 'Observed the unavailable tool.' }], observed),
        new ToolRegistry(), [structuredClone(user)], 3, emit, signal);
      assert.equal(delta[1].role, 'tool');
      assert.equal(delta[1].toolCallId, 'missing-call');
      assert.equal(JSON.parse(delta[1].content).ok, false, 'Tool errors are model observations, not fabricated success');
      assert.deepEqual(observed[1].at(-1), delta[1]);
      assert.equal(delta.at(-1)?.content, 'Observed the unavailable tool.');
    } },
    { name: 'L1/step-limit-no-final-side-effect', async run(signal) {
      const registry = new ToolRegistry();
      let actions = 0;
      registry.register({ name: 'counter', description: 'Count actions', parameters: { type: 'object' }, handler: () => ++actions });
      const requests: ModelResponse[] = Array.from({ length: 3 }, (_, index) => ({
        content: '', toolCalls: [{ id: `counter-${index}`, name: 'counter', arguments: {} }],
      }));
      await assert.rejects(() => algorithms.runLoop(providerFor(requests), registry,
        [structuredClone(user)], 1, emit, signal), StepLimitExceeded);
      assert.equal(actions, 0, 'The last model step cannot begin a new side effect');
      await assert.rejects(() => algorithms.runLoop(providerFor(requests), registry,
        [structuredClone(user)], 2, emit, signal), StepLimitExceeded);
      assert.equal(actions, 1, 'Only the earlier step can execute a tool');
    } },
    { name: 'L1/cancel-before-model', async run(parent) {
      parent?.throwIfAborted();
      const controller = new AbortController(), reason = new Error('Contract canceled before model');
      controller.abort(reason);
      const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
      let calls = 0;
      const provider: Provider = { async complete() { calls++; return { content: 'must not run' }; } };
      await assert.rejects(() => algorithms.runLoop(provider, new ToolRegistry(),
        [structuredClone(user)], 2, emit, signal), error => error === reason);
      assert.equal(calls, 0, 'An already canceled turn must not request the model');
    } },
    { name: 'L1/cancel-pending-model', async run(parent) {
      parent?.throwIfAborted();
      const controller = new AbortController(), reason = new Error('Contract canceled pending model');
      const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
      let release!: (response: ModelResponse) => void;
      const pending = new Promise<ModelResponse>(resolve => { release = resolve; });
      let calls = 0;
      const provider: Provider = { complete() {
        if (++calls > 1) throw new Error('Canceled turn attempted another model request');
        queueMicrotask(() => controller.abort(reason));
        return pending;
      } };
      // 即使学习者忽略取消，也让本契约在 20ms 内结束等待。
      const timer = setTimeout(() => release({ content: 'late response' }), 20);
      try {
        await assert.rejects(() => algorithms.runLoop(provider, new ToolRegistry(),
          [structuredClone(user)], 2, emit, signal), error => error === reason);
      } finally { clearTimeout(timer); release({ content: 'late response' }); }
    } },
    { name: 'L1/reject-duplicate-call-ids', async run(signal) {
      const registry = new ToolRegistry();
      let actions = 0;
      registry.register({ name: 'counter', description: 'Counter', parameters: { type: 'object' }, handler: () => ++actions });
      const response: ModelResponse = { content: '', toolCalls: [
        { id: 'duplicate', name: 'counter', arguments: {} },
        { id: 'duplicate', name: 'counter', arguments: {} },
      ] };
      await assert.rejects(() => algorithms.runLoop(providerFor([response]), registry,
        [structuredClone(user)], 3, emit, signal), error => !(error instanceof ExerciseNotImplemented));
      assert.equal(actions, 0, 'Reject duplicate IDs before executing either action');
    } },
  ];
}

function memoryCases(algorithms: Algorithms): StageCase[] {
  return [
    { name: 'L2/exact-budget-whole-tool-turn', run() {
      const identity = structuredClone(system);
      const latest = successfulTrace();
      const input: Message[] = [identity, { role: 'user', content: 'old question' },
        { role: 'assistant', content: 'x'.repeat(1000) }, ...latest];
      const original = structuredClone(input), expected = structuredClone([identity, ...latest]);
      assert.deepEqual(algorithms.compactHistory(input, size(expected)), expected);
      assert.deepEqual(input, original, 'Context selection cannot mutate full persisted history');
    } },
    { name: 'L2/system-only-and-overflow', run() {
      const identity = structuredClone(system), original = structuredClone(identity);
      assert.deepEqual(algorithms.compactHistory([identity], messageSize(identity)), [original]);
      assert.throws(() => algorithms.compactHistory([identity], messageSize(original) - 1), ContextBudgetExceeded);
    } },
    { name: 'L2/latest-turn-overflow', run() {
      const input = [structuredClone(system), ...successfulTrace()];
      assert.throws(() => algorithms.compactHistory(input, size(input) - 1), ContextBudgetExceeded);
    } },
    { name: 'L2/contiguous-immutable-suffix', run() {
      const identity = structuredClone(system);
      const oldest: Message = { role: 'user', content: 'old small turn' };
      const middle: Message = { role: 'user', content: 'x'.repeat(1000) };
      const newest: Message = { role: 'user', content: 'new small turn' };
      const input = [identity, oldest, middle, newest], original = structuredClone(input);
      const expected = structuredClone([identity, newest]);
      assert.deepEqual(algorithms.compactHistory(input, size([identity, oldest, newest])), expected,
        'Keep a contiguous suffix rather than skipping a large middle turn');
      assert.deepEqual(input, original);
    } },
    { name: 'L3/stable-relevance-without-mutation', run() {
      const hits: MemoryHit[] = [
        { sessionId: 'unrelated', content: 'gardening', score: 1 },
        { sessionId: 'first', content: 'TypeScript tooling', score: 1 },
        { sessionId: 'second', content: 'TypeScript tooling again', score: 1 },
      ];
      const original = structuredClone(hits);
      assert.deepEqual(algorithms.selectMemories('TYPESCRIPT', hits, 2).map(hit => hit.sessionId), ['first', 'second']);
      assert.deepEqual(algorithms.selectMemories('TYPESCRIPT', hits, 1).map(hit => hit.sessionId), ['first']);
      assert.deepEqual(hits, original, 'Ranking cannot reorder or mutate candidates in place');
    } },
    { name: 'L3/nonpositive-limit', run() {
      const hits: MemoryHit[] = [{ sessionId: 'one', content: 'TypeScript', score: 1 }];
      assert.deepEqual(algorithms.selectMemories('TypeScript', hits, 0), []);
      assert.deepEqual(algorithms.selectMemories('TypeScript', hits, -1), []);
      assert.deepEqual(algorithms.selectMemories('TypeScript', [], 5), []);
    } },
  ];
}

function routingCases(algorithms: Algorithms): StageCase[] {
  return [
    { name: 'L4/stable-nonempty-key', run() {
      const first = algorithms.sessionKey('chat', 'room', 'alice');
      assert.equal(typeof first, 'string');
      assert.ok(first.trim(), 'Session keys cannot be empty or whitespace');
      assert.equal(algorithms.sessionKey('chat', 'room', 'alice'), first);
    } },
    { name: 'L4/all-routing-dimensions', run() {
      const keys = [
        algorithms.sessionKey('chat', 'room', 'alice'),
        algorithms.sessionKey('other-chat', 'room', 'alice'),
        algorithms.sessionKey('chat', 'other-room', 'alice'),
        algorithms.sessionKey('chat', 'room', 'bob'),
      ];
      assert.equal(new Set(keys).size, keys.length, 'Channel, conversation and user each contribute to isolation');
    } },
    { name: 'L4/delimiter-control-tuple-collisions', run() {
      for (const separator of [':', '|', '/', '\u0000', '\n', '\t']) {
        assert.notEqual(algorithms.sessionKey(`a${separator}b`, 'c', 'd'),
          algorithms.sessionKey('a', `b${separator}c`, 'd'),
          `Route tuple encoding must disambiguate ${JSON.stringify(separator)}`);
      }
    } },
  ];
}

function evolutionCases(algorithms: Algorithms): StageCase[] {
  return [
    { name: 'L5/successful-procedure', run() {
      const body = algorithms.reflect(successfulTrace());
      assert.equal(typeof body, 'string');
      assert.ok(body, 'A successful complete tool trace produces a reviewable candidate');
      assert.ok(body.trim(), 'Candidate body cannot contain only whitespace');
      assert.ok(!body.includes('never-copy-this-private-value'), 'Do not copy raw private arguments into a reusable Skill');
    } },
    { name: 'L5/pure-chat', run() {
      assert.equal(algorithms.reflect([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]), null);
    } },
    { name: 'L5/failed-tool', run() {
      const trace = successfulTrace();
      trace[2].content = '{"ok":false,"error":"Failure"}';
      assert.equal(algorithms.reflect(trace), null);
    } },
    { name: 'L5/malformed-tool-result', run() {
      const trace = successfulTrace();
      trace[2].content = 'not-json';
      assert.equal(algorithms.reflect(trace), null);
    } },
    { name: 'L5/pending-tool-turn', run() {
      assert.equal(algorithms.reflect(successfulTrace().slice(0, 2)), null);
    } },
    { name: 'L5/orphan-tool-result', run() {
      const trace = successfulTrace();
      assert.equal(algorithms.reflect([trace[2], trace[3]]), null);
    } },
    { name: 'L5/missing-tool-result', run() {
      const trace = successfulTrace();
      trace[1].toolCalls!.push({ id: 'missing', name: 'second_tool', arguments: {} });
      assert.equal(algorithms.reflect(trace), null);
    } },
    { name: 'L5/wrong-tool-result-id', run() {
      const trace = successfulTrace();
      trace[2].toolCallId = 'wrong';
      assert.equal(algorithms.reflect(trace), null);
    } },
  ];
}

export function algorithmCases(stage: number, algorithms: Algorithms, emit: Emit = noop): StageCase[] {
  switch (stage) {
    case 1: return coreCases(algorithms, emit);
    case 2: return memoryCases(algorithms);
    case 3: return routingCases(algorithms);
    case 4: return [];
    case 5: return evolutionCases(algorithms);
    default: throw new RangeError('Stage must be an integer from 1 to 5');
  }
}
