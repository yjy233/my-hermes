import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { KeyedMutex } from '../src/core/async.js';
import { calculate } from '../src/core/builtin-tools.js';
import { ContextBudgetExceeded, ExerciseNotImplemented, ProviderError, StepLimitExceeded } from '../src/core/errors.js';
import { fromWireMessage, messageSize, toWireMessage, validateModelResponse,
  type Message, type ModelResponse, type Provider, type ToolSchema } from '../src/core/models.js';
import { OpenAICompatibleProvider } from '../src/core/providers.js';
import { ToolRegistry, validate, validateSchema } from '../src/core/tools.js';
import { loadAlgorithms } from '../src/learning/index.js';
import { compactHistory, reflect, runLoop, selectMemories, sessionKey } from '../src/learning/reference.js';

const noop = () => undefined;
const objectSchema = { type: 'object' };

function scripted(responses: ModelResponse[], observed: Message[][] = []): Provider {
  let index = 0;
  return { async complete(messages) {
    observed.push(structuredClone(messages));
    const response = responses[index++];
    if (!response) throw new Error('Unexpected extra model request');
    return structuredClone(response);
  } };
}

function toolReply(content = '{"ok":true,"result":2}', id = 'call-1'): Message {
  return { role: 'tool', content, toolCallId: id };
}

function successfulTrace(): Message[] {
  return [
    { role: 'user', content: 'Please calculate with private input' },
    { role: 'assistant', content: '', toolCalls: [
      { id: 'call-1', name: 'calculator', arguments: { secret: 'do-not-copy-this-value' } },
    ] },
    toolReply(),
    { role: 'assistant', content: '2' },
  ];
}

test('loop preserves ordered multi-tool IDs, observations, events and original input', async () => {
  const registry = new ToolRegistry();
  for (const name of ['first', 'second']) registry.register({
    name, description: name, parameters: {
      type: 'object', properties: { value: { type: 'integer' } }, required: ['value'],
    }, handler: args => args.value,
  });
  const input: Message[] = [{ role: 'system', content: 'identity' }, { role: 'user', content: 'do both' }];
  const original = structuredClone(input), observed: Message[][] = [], events: string[] = [];
  const provider = scripted([
    { content: '', toolCalls: [
      { id: 'one', name: 'first', arguments: { value: 1 } },
      { id: 'two', name: 'second', arguments: { value: 2 } },
    ] },
    { content: 'Both verified.' },
  ], observed);
  const delta = await runLoop(provider, registry, input, 3, event => events.push(event));
  assert.deepEqual(input, original);
  assert.deepEqual(delta.map(message => message.role), ['assistant', 'tool', 'tool', 'assistant']);
  assert.equal(delta[1].toolCallId, 'one');
  assert.equal(delta[2].toolCallId, 'two');
  assert.deepEqual(JSON.parse(delta[1].content), { ok: true, result: 1 });
  assert.deepEqual(JSON.parse(delta[2].content), { ok: true, result: 2 });
  assert.deepEqual(observed[1], [...input, ...delta.slice(0, 3)]);
  assert.deepEqual(events, ['model.start', 'tool.start', 'tool.end', 'tool.start', 'tool.end', 'model.start', 'turn.final']);
});

test('last allowed model step cannot start fresh tool side effects', async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register({ name: 'counter', description: 'Counter', parameters: objectSchema, handler: () => ++executions });
  const ask: ModelResponse = { content: '', toolCalls: [{ id: 'one', name: 'counter', arguments: {} }] };
  await assert.rejects(() => runLoop(scripted([ask]), registry, [{ role: 'user', content: 'go' }], 1, noop), StepLimitExceeded);
  assert.equal(executions, 0);
  await assert.rejects(() => runLoop(scripted([ask, ask]), registry, [{ role: 'user', content: 'go' }], 2, noop), StepLimitExceeded);
  assert.equal(executions, 1);
});

const invalidResponses: Array<[string, unknown]> = [
  ['empty', { content: '', toolCalls: [] }],
  ['malformed', { content: 123 }],
  ['duplicate IDs', { content: '', toolCalls: [
    { id: 'same', name: 'counter', arguments: {} }, { id: 'same', name: 'counter', arguments: {} },
  ] }],
  ['too many calls', { content: '', toolCalls: Array.from({ length: 9 }, (_, index) => ({ id: String(index), name: 'counter', arguments: {} })) }],
  ['oversized content', { content: 'x'.repeat(16_001) }],
  ['oversized arguments', { content: '', toolCalls: [{ id: 'one', name: 'counter', arguments: { value: 'x'.repeat(16_001) } }] }],
  ['non-finite arguments', { content: '', toolCalls: [{ id: 'one', name: 'counter', arguments: { value: Number.NaN } }] }],
  ['invalid name', { content: '', toolCalls: [{ id: 'one', name: '../unsafe', arguments: {} }] }],
];
for (const [name, response] of invalidResponses) {
  test(`malformed model response is rejected before actions: ${name}`, async () => {
    let actions = 0;
    const registry = new ToolRegistry();
    registry.register({ name: 'counter', description: 'Counter', parameters: objectSchema, handler: () => ++actions });
    await assert.rejects(() => runLoop(scripted([response as ModelResponse]), registry,
      [{ role: 'user', content: 'go' }], 3, noop));
    assert.equal(actions, 0);
  });
}

test('wire messages round-trip tool metadata and reject non-object argument JSON', () => {
  const message = successfulTrace()[1];
  assert.deepEqual(fromWireMessage(toWireMessage(message)), message);
  assert.throws(() => fromWireMessage({ role: 'assistant', content: null, tool_calls: [{
    id: 'one', function: { name: 'counter', arguments: '[]' },
  }] }), /object/);
  assert.throws(() => validateModelResponse({ content: '', toolCalls: [{ id: '', name: 'counter', arguments: {} }] }), /ID/);
});

test('history compaction retains a whole newest turn and never mutates SQLite-shaped input', () => {
  const system: Message = { role: 'system', content: 'fixed identity' };
  const old: Message[] = [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'x'.repeat(1000) }];
  const latest = successfulTrace();
  const input = [system, ...old, ...latest];
  const original = structuredClone(input);
  const budget = [system, ...latest].reduce((sum, message) => sum + messageSize(message), 0);
  const compacted = compactHistory(input, budget);
  assert.deepEqual(compacted, [system, ...latest]);
  assert.deepEqual(input, original);
  assert.equal(compacted[3].toolCallId, compacted[2].toolCalls?.[0].id);
});

test('history keeps a contiguous suffix instead of cherry-picking older small turns', () => {
  const system: Message = { role: 'system', content: 'identity' };
  const oldest: Message = { role: 'user', content: 'oldest' };
  const large: Message = { role: 'user', content: 'x'.repeat(1000) };
  const newest: Message = { role: 'user', content: 'newest' };
  const budget = [system, oldest, newest].reduce((sum, message) => sum + messageSize(message), 0);
  assert.deepEqual(compactHistory([system, oldest, large, newest], budget), [system, newest]);
});

test('system-only and oversized newest contexts have explicit budget behavior', () => {
  const system: Message = { role: 'system', content: 'identity' };
  assert.deepEqual(compactHistory([system], messageSize(system)), [system]);
  assert.throws(() => compactHistory([system], messageSize(system) - 1), ContextBudgetExceeded);
  assert.throws(() => compactHistory([system, { role: 'user', content: 'x'.repeat(500) }], 100), ContextBudgetExceeded);
  assert.throws(() => compactHistory([system, toolReply()], 1000), /user/);
  assert.throws(() => compactHistory([{ role: 'user', content: 'no system' }], 1000), /system/);
});

test('memory ranking is stable, bounded and leaves scoped candidates unchanged', () => {
  const hits = [
    { sessionId: 'a', content: 'gardening', score: 1 },
    { sessionId: 'b', content: 'TypeScript tooling', score: 1 },
    { sessionId: 'c', content: 'TypeScript tooling again', score: 1 },
  ];
  const original = structuredClone(hits);
  assert.deepEqual(selectMemories('typescript', hits, 2).map(hit => hit.sessionId), ['b', 'c']);
  assert.deepEqual(selectMemories('typescript', hits, 0), []);
  assert.deepEqual(hits, original);
  assert.notEqual(sessionKey('a:b', 'c', 'd'), sessionKey('a', 'b:c', 'd'));
  assert.notEqual(sessionKey('chat', 'room', 'alice'), sessionKey('chat', 'room', 'bob'));
  assert.equal(sessionKey('chat', 'room', 'alice'), sessionKey('chat', 'room', 'alice'));
});

test('tool schemas reject unsupported constraints and numeric values remain finite', async () => {
  assert.throws(() => validateSchema({ type: 'object', properties: { n: { type: 'number', minimum: 0 } } }), /Unsupported/);
  assert.throws(() => validateSchema({ type: 'array' }), /supported JSON type/);
  assert.throws(() => validateSchema({ type: 'number', enum: [Number.NaN] }), /finite/);
  for (const value of [true, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => validate(value, { type: 'number' }), /number/);
  }
  assert.throws(() => validate(2 ** 53, { type: 'integer' }), /integer/);
  assert.throws(() => validate({ other: 'unexpected' }, { type: 'object', properties: {} }), /unexpected/);
  const registry = new ToolRegistry();
  registry.register({ name: 'number_tool', description: 'Finite number', parameters: {
    type: 'object', properties: { n: { type: 'number' } }, required: ['n'],
  }, handler: args => args.n });
  const result = await registry.execute({ id: 'one', name: 'number_tool', arguments: { n: Number.NaN } });
  assert.equal(JSON.parse(result.content).ok, false);
});

for (const [label, value] of [
  ['undefined', undefined], ['NaN', Number.NaN], ['Infinity', Number.POSITIVE_INFINITY], ['Date', new Date()],
] as const) {
  test(`non-JSON tool result becomes a structured failure: ${label}`, async () => {
    const registry = new ToolRegistry();
    registry.register({ name: 'bad_result', description: 'Bad JSON', parameters: objectSchema, handler: () => value });
    const result = await registry.execute({ id: 'one', name: 'bad_result', arguments: {} });
    assert.equal(JSON.parse(result.content).ok, false);
    assert.equal(result.toolCallId, 'one');
  });
}

test('escaped success/error JSON stays within strict output bounds and remains parseable', async () => {
  const registry = new ToolRegistry(200);
  const escaped = '\u0000"\\\n'.repeat(1000);
  registry.register({ name: 'large_result', description: 'Large result', parameters: objectSchema, handler: () => escaped });
  registry.register({ name: 'large_error', description: 'Large error', parameters: objectSchema,
    handler: () => { throw new Error(escaped); } });
  registry.register({ name: 'encoded_name', description: 'Encoded error class', parameters: objectSchema,
    handler: () => { const error = new Error(escaped); error.name = '\u0000'.repeat(64); throw error; } });
  for (const name of ['large_result', 'large_error', 'encoded_name']) {
    const result = await registry.execute({ id: 'one', name, arguments: {} });
    assert.ok(result.content.length <= 200, `oversized ${name} output`);
    assert.equal(JSON.parse(result.content).truncated, true);
    if (name === 'encoded_name') assert.match(JSON.parse(result.content).error, /^_+$/);
  }
  assert.throws(() => new ToolRegistry(199), /budget/);
});

test('calculator respects arithmetic precedence, floor semantics and explicit complexity limits', () => {
  assert.equal(calculate('(2+3)*4'), 20);
  assert.equal(calculate('2 + 3 * 4'), 14);
  assert.equal(calculate('-(-2) + .5'), 2.5);
  assert.equal(calculate('-7 // 3'), -3);
  assert.equal(calculate('-7 % 3'), 2);
  assert.equal(calculate('7 % -3'), -2);
  assert.equal(calculate('1e2 / 4'), 25);
  for (const expression of ['', '1/0', '1//0', '1%0', '2**3', '1e309', '1e10*1e10',
    '(1+2', '1 2', 'globalThis.process.exit()', '1; process.exit()', 'x'.repeat(201),
    '-'.repeat(41) + '1', Array(42).fill('1').join('+')]) {
    assert.throws(() => calculate(expression), `Expected rejection: ${expression.slice(0, 30)}`);
  }
});

test('unknown tools and invalid arguments return structured errors without running handlers', async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register({ name: 'echo', description: 'Echo', parameters: {
    type: 'object', properties: { text: { type: 'string', maxLength: 3 } }, required: ['text'],
  }, handler: args => { executions++; return args.text; } });
  for (const call of [
    { id: 'one', name: 'missing', arguments: {} },
    { id: 'two', name: 'echo', arguments: { text: 'too long' } },
    { id: 'three', name: 'echo', arguments: {} },
  ]) assert.equal(JSON.parse((await registry.execute(call)).content).ok, false);
  assert.equal(executions, 0);
});

test('tool timeout is an observation while parent cancellation propagates as cancellation', async () => {
  const registry = new ToolRegistry();
  let timeoutObserved = false;
  registry.register({ name: 'wait', description: 'Cooperative wait', parameters: objectSchema, timeoutMs: 10,
    handler: (_args, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { timeoutObserved = true; reject(signal.reason); }, { once: true });
    }),
  });
  const timed = await registry.execute({ id: 'one', name: 'wait', arguments: {} });
  assert.equal(JSON.parse(timed.content).ok, false);
  assert.equal(JSON.parse(timed.content).error, 'TimeoutError');
  assert.equal(timeoutObserved, true);
  const controller = new AbortController();
  const reason = new Error('User canceled the turn');
  const running = registry.execute({ id: 'two', name: 'wait', arguments: {} }, controller.signal);
  controller.abort(reason);
  await assert.rejects(running, error => error === reason);
});

async function localServer(t: TestContext, handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>): Promise<string> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}/v1`;
}
function jsonResponse(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}
async function requestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

test('compatible provider sends wire messages and parses tool calls against local HTTP', async t => {
  let received: Record<string, unknown> | undefined;
  let route: string | undefined, authorization: string | undefined;
  const baseUrl = await localServer(t, async (request, response) => {
    received = await requestJson(request); route = request.url; authorization = request.headers.authorization;
    jsonResponse(response, { choices: [{ finish_reason: 'tool_calls', message: {
      role: 'assistant', content: null, tool_calls: [{ id: 'new-call', type: 'function',
        function: { name: 'calculator', arguments: '{"expression":"2+2"}' } }],
    } }] });
  });
  const provider = new OpenAICompatibleProvider({ baseUrl, model: 'local-test', apiKey: 'test-key' });
  const messages = successfulTrace();
  const tools: ToolSchema[] = [{ type: 'function', function: { name: 'calculator', description: 'Calculate', parameters: objectSchema } }];
  const result = await provider.complete(messages, tools);
  assert.equal(route, '/v1/chat/completions');
  assert.equal(authorization, 'Bearer test-key');
  assert.ok(received);
  assert.equal(received.model, 'local-test');
  assert.equal(received.tool_choice, 'auto');
  assert.deepEqual(received.messages, messages.map(toWireMessage));
  assert.deepEqual(received.tools, tools);
  assert.deepEqual(result, { content: '', toolCalls: [{ id: 'new-call', name: 'calculator', arguments: { expression: '2+2' } }] });
});

test('provider HTTP failures omit private response bodies', async t => {
  const baseUrl = await localServer(t, (_request, response) => {
    response.writeHead(401); response.end('private-token-in-provider-error');
  });
  const provider = new OpenAICompatibleProvider({ baseUrl, model: 'test' });
  await assert.rejects(() => provider.complete([{ role: 'user', content: 'hello' }], []), error => {
    assert.ok(error instanceof ProviderError);
    assert.match(error.message, /HTTP 401/);
    assert.doesNotMatch(error.message, /private-token/);
    return true;
  });
});

for (const [name, body] of [
  ['unfinished', { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'partial' } }] }],
  ['wrong role', { choices: [{ message: { role: 'user', content: 'bad' } }] }],
  ['bad tool arguments', { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
    { id: 'one', function: { name: 'calculator', arguments: '[]' } },
  ] } }] }],
  ['empty envelope', { choices: [] }],
] as const) {
  test(`provider rejects invalid successful HTTP envelopes: ${name}`, async t => {
    const baseUrl = await localServer(t, (_request, response) => jsonResponse(response, body));
    const provider = new OpenAICompatibleProvider({ baseUrl, model: 'test' });
    await assert.rejects(() => provider.complete([{ role: 'user', content: 'hello' }], []), ProviderError);
  });
}

test('provider limits response bytes before parsing oversized bodies', async t => {
  const baseUrl = await localServer(t, (_request, response) => jsonResponse(response, {
    choices: [{ message: { role: 'assistant', content: 'x'.repeat(1000) } }],
  }));
  const provider = new OpenAICompatibleProvider({ baseUrl, model: 'test', maxResponseBytes: 100 });
  await assert.rejects(() => provider.complete([{ role: 'user', content: 'hello' }], []), /byte limit/);
});

test('provider honors active request cancellation without wrapping the parent reason', { timeout: 3000 }, async t => {
  let requestStarted!: () => void;
  const started = new Promise<void>(resolve => { requestStarted = resolve; });
  const baseUrl = await localServer(t, () => { requestStarted(); });
  const provider = new OpenAICompatibleProvider({ baseUrl, model: 'test', timeoutMs: 2000 });
  const controller = new AbortController(), reason = new Error('cancel local request');
  const running = provider.complete([{ role: 'user', content: 'hello' }], [], controller.signal);
  await started;
  controller.abort(reason);
  await assert.rejects(running, error => error === reason);
});

test('provider transport timeout terminates a stalled response', { timeout: 3000 }, async t => {
  const baseUrl = await localServer(t, () => undefined);
  const provider = new OpenAICompatibleProvider({ baseUrl, model: 'test', timeoutMs: 20 });
  await assert.rejects(() => provider.complete([{ role: 'user', content: 'hello' }], []), /TimeoutError/);
});

test('reflection proposes only successful, complete, tool-assisted trajectories and avoids raw arguments', () => {
  const trace = successfulTrace();
  const candidate = reflect(trace);
  assert.ok(candidate);
  assert.match(candidate, /calculator/);
  assert.doesNotMatch(candidate, /do-not-copy-this-value|private input/);
  assert.equal(reflect([{ role: 'assistant', content: 'pure chat' }]), null);
  assert.equal(reflect(trace.slice(0, 2)), null);
  assert.equal(reflect([trace[0], trace[1], toolReply('{"ok":false}'), trace[3]]), null);
  assert.equal(reflect([trace[0], trace[1], toolReply('not-json'), trace[3]]), null);
});

test('reflection rejects orphaned and incomplete tool observations', () => {
  assert.equal(reflect([toolReply(), { role: 'assistant', content: 'done' }]), null);
  const trace = successfulTrace();
  const declared = structuredClone(trace[1]);
  declared.toolCalls!.push({ id: 'missing-result', name: 'other_tool', arguments: {} });
  assert.equal(reflect([trace[0], declared, trace[2], trace[3]]), null);
  assert.equal(reflect([trace[0], trace[1], toolReply('{"ok":true}', 'wrong-id'), trace[3]]), null);
});

test('learner mode runs completed L1 while remaining exercises still reject without a fallback', async () => {
  const learner = loadAlgorithms('learner');
  const completed = await learner.runLoop(scripted([{ content: 'learner works' }]),
    new ToolRegistry(), [{ role: 'user', content: 'hello' }], 2, noop);
  assert.deepEqual(completed, [{ role: 'assistant', content: 'learner works' }]);
  assert.throws(() => learner.compactHistory([{ role: 'system', content: 'x' }], 1000),
    error => error instanceof ExerciseNotImplemented && /L2/.test(error.message));
  assert.throws(() => learner.selectMemories('query', [], 1), /L3/);
  assert.throws(() => learner.sessionKey('a', 'b', 'c'), /L4/);
  assert.throws(() => learner.reflect([]), /L5/);
  const reference = await loadAlgorithms('reference').runLoop(scripted([{ content: 'reference works' }]),
    new ToolRegistry(), [{ role: 'user', content: 'hello' }], 2, noop);
  assert.equal(reference[0].content, 'reference works');
});

test('a canceled mutex waiter cannot let later work bypass an active same-session turn', async () => {
  const mutex = new KeyedMutex(), events: string[] = [];
  let release!: () => void, activeStarted!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { activeStarted = resolve; });
  const active = mutex.run('session', async () => {
    events.push('active'); activeStarted(); await held; events.push('active-end');
  });
  await started;
  const controller = new AbortController(), reason = new Error('cancel queued turn');
  const canceled = mutex.run('session', async () => { events.push('canceled-ran'); }, controller.signal);
  controller.abort(reason);
  await assert.rejects(canceled, error => error === reason);
  const later = mutex.run('session', async () => { events.push('later'); });
  await mutex.run('independent-session', async () => { events.push('independent'); });
  await nextTurn();
  assert.deepEqual(events, ['active', 'independent']);
  release();
  await Promise.all([active, later]);
  assert.deepEqual(events, ['active', 'independent', 'active-end', 'later']);
});
