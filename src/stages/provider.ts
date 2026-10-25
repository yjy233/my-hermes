/** L0 Kimi 协议契约；所有请求都发往临时创建的本机回环模拟服务。 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { abortable } from '../core/async.js';
import { calculate } from '../core/builtin-tools.js';
import { ExerciseNotImplemented } from '../core/errors.js';
import { toWireMessage, type Message, type Provider, type ToolSchema } from '../core/models.js';
import { KimiProvider } from '../core/providers/kimi.js';
import { ReferenceKimiProvider } from '../core/providers/kimi-reference.js';
import type { KimiProviderOptions } from '../core/providers/kimi-shared.js';
import { ToolRegistry } from '../core/tools.js';
import type { Mode } from '../learning/types.js';
import { runLoop } from '../learning/reference.js';
import type { StageCase } from './contracts.js';

const MOCK_KEY = 'stage-kimi-sentinel-not-a-real-secret';
const REMOTE_PRIVATE_MARKER = 'mock-remote-private-error-body';
const MOCK_MODEL = 'kimi-k3.1-pro';
const MOCK_REASONING = 'mock-kimi-reasoning-must-survive-roundtrip';
const input: Message[] = [{ role: 'system', content: 'Be careful.' }, { role: 'user', content: 'Hello, Kimi.' }];
const noTools: ToolSchema[] = [];

type MockHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

function selectedProvider(mode: Mode, options: KimiProviderOptions): Provider {
  if (mode === 'reference') return new ReferenceKimiProvider(options);
  if (mode === 'learner') return new KimiProvider(options);
  throw new Error('Provider mode must be reference or learner');
}

function contract(name: string, run: (signal?: AbortSignal) => Promise<void>): StageCase {
  return { name, async run(signal) {
    signal?.throwIfAborted();
    try { await run(signal); }
    catch (error) {
      // 学习者的错误实现可能回显模拟凭证；验收输出必须避免泄露。
      const text = error instanceof Error ? error.message : String(error);
      const sanitized = text.replaceAll(MOCK_KEY, '[redacted]').replaceAll(REMOTE_PRIVATE_MARKER, '[redacted remote body]').replaceAll(MOCK_REASONING, '[redacted reasoning]');
      if (sanitized !== text) throw new Error(sanitized);
      throw error;
    }
  } };
}

async function withServer(signal: AbortSignal | undefined, handler: MockHandler,
  run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer((request, response) => {
    void Promise.resolve().then(() => handler(request, response)).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  try {
    signal?.throwIfAborted();
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await abortable(run(`http://127.0.0.1:${address.port}/v1`), signal);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function requestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}
function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}
function finalPayload(content = 'Kimi mock final answer.'): unknown {
  return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] };
}
function options(baseUrl: string, extra: Partial<KimiProviderOptions> = {}): KimiProviderOptions {
  return { baseUrl, model: MOCK_MODEL, apiKey: MOCK_KEY, ...extra };
}

/** TODO 导致的拒绝代表练习未完成，不能算作异常场景验收通过。 */
async function expectedFailure(work: () => Promise<unknown>): Promise<Error> {
  let failure: unknown;
  try { await work(); } catch (error) { failure = error; }
  assert.ok(failure instanceof Error, 'Expected the provider to reject this unsuccessful request');
  assert.ok(!(failure instanceof ExerciseNotImplemented) && failure.name !== 'ExerciseNotImplemented',
    'L0 is not implemented; a TODO rejection does not satisfy an error-handling contract');
  assert.ok(!failure.message.includes(MOCK_KEY), 'Provider errors must not expose the configured credential');
  assert.ok(!failure.message.includes(REMOTE_PRIVATE_MARKER), 'Provider errors must not expose remote error bodies');
  return failure;
}

function assertKimiRequestOptions(body: Record<string, unknown>): void {
  assert.equal(body.reasoning_effort, 'low', 'Use the documented Kimi reasoning effort');
  assert.equal(body.max_completion_tokens, 8192, 'Use the completion budget expected by this exercise');
  assert.equal(body.stream, false, 'This provider exercise uses complete JSON responses');
  assert.ok(!Object.hasOwn(body, 'thinking'), 'Do not send the retired thinking-disable option');
  assert.ok(!Object.hasOwn(body, 'max_tokens'), 'Do not send the deprecated max_tokens option');
}

function malformedCase(mode: Mode, name: string, payload: unknown, raw = false): StageCase {
  return contract(name, async signal => {
    let requests = 0;
    await withServer(signal, (_request, response) => {
      requests++;
      if (raw) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(String(payload)); }
      else json(response, payload);
    }, async baseUrl => {
      await expectedFailure(() => selectedProvider(mode, options(baseUrl)).complete(structuredClone(input), noTools, signal));
      assert.equal(requests, 1, 'Malformed responses must fail after exactly one request');
    });
  });
}

export function providerCases(mode: Mode): StageCase[] {
  if (mode !== 'reference' && mode !== 'learner') throw new Error('Provider mode must be reference or learner');
  return [
    contract('L0/validate-api-key-before-request', async signal => {
      let requests = 0;
      await withServer(signal, (_request, response) => { requests++; json(response, finalPayload()); }, async baseUrl => {
        let failure: unknown;
        try { selectedProvider(mode, options(baseUrl, { apiKey: '' })); } catch (error) { failure = error; }
        assert.ok(failure instanceof Error, 'An empty API key must be rejected by the constructor');
        assert.ok(!(failure instanceof ExerciseNotImplemented), 'Constructor validation is not the L0 TODO');
        assert.equal(requests, 0);
      });
    }),
    contract('L0/post-auth-options-and-final', async signal => {
      let captured: Record<string, unknown> | undefined;
      let route: string | undefined, method: string | undefined, authorized = false, jsonContent = false;
      await withServer(signal, async (request, response) => {
        route = request.url; method = request.method;
        authorized = request.headers.authorization === `Bearer ${MOCK_KEY}`;
        jsonContent = request.headers['content-type']?.split(';')[0] === 'application/json';
        captured = await requestJson(request);
        json(response, finalPayload());
      }, async baseUrl => {
        const defaults = options(baseUrl);
        delete defaults.model;
        const response = await selectedProvider(mode, defaults).complete(structuredClone(input), noTools, signal);
        assert.equal(method, 'POST');
        assert.equal(route, '/v1/chat/completions');
        assert.ok(authorized, 'Use the configured Bearer credential');
        assert.ok(jsonContent, 'Set the JSON request Content-Type');
        assert.ok(captured);
        assert.equal(captured.model, MOCK_MODEL);
        assert.ok(isDeepStrictEqual(captured.messages, input.map(toWireMessage)), 'Convert internal messages to the Chat Completions wire shape');
        assertKimiRequestOptions(captured);
        assert.equal(response.content, 'Kimi mock final answer.');
        assert.ok(!response.toolCalls?.length);
      });
    }),
    contract('L0/tool-call-and-history-roundtrip', async signal => {
      const messages: Message[] = [
        ...structuredClone(input),
        { role: 'assistant', content: '', reasoningContent: MOCK_REASONING, toolCalls: [{ id: 'old-call', name: 'calculator', arguments: { expression: '1+1' } }] },
        { role: 'tool', content: '{"ok":true,"result":2}', toolCallId: 'old-call' },
        { role: 'user', content: 'Now compute 2+2.' },
      ];
      const tools: ToolSchema[] = [{ type: 'function', function: {
        name: 'calculator', description: 'Arithmetic', parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
      } }];
      let captured: Record<string, unknown> | undefined;
      await withServer(signal, async (request, response) => {
        captured = await requestJson(request);
        json(response, { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, reasoning_content: MOCK_REASONING,
          tool_calls: [{ id: 'new-call', type: 'function', function: { name: 'calculator', arguments: '{"expression":"2+2"}' } }],
        } }] });
      }, async baseUrl => {
        const response = await selectedProvider(mode, options(baseUrl, { model: 'mock-kimi-custom-model' })).complete(messages, tools, signal);
        assert.ok(captured);
        assert.equal(captured.model, 'mock-kimi-custom-model', 'Respect an explicitly configured model');
        assert.ok(isDeepStrictEqual(captured.messages, messages.map(toWireMessage)), 'Preserve assistant tool_calls and tool_call_id in history');
        assert.ok(isDeepStrictEqual(captured.tools, tools), 'Send supplied tool schemas');
        assertKimiRequestOptions(captured);
        assert.ok(isDeepStrictEqual(response, { content: '', reasoningContent: MOCK_REASONING, toolCalls: [{ id: 'new-call', name: 'calculator', arguments: { expression: '2+2' } }] }),
          'Parse JSON-string arguments into an internal ToolCall');
      });
    }),
    contract('L0/two-step-calculator-loop', async signal => {
      const bodies: Record<string, unknown>[] = [];
      await withServer(signal, async (request, response) => {
        bodies.push(await requestJson(request));
        if (bodies.length === 1) json(response, { choices: [{ finish_reason: 'tool_calls', message: {
          role: 'assistant', content: null, reasoning_content: MOCK_REASONING, tool_calls: [{ id: 'calculate-20', type: 'function',
            function: { name: 'calculator', arguments: '{"expression":"(2+3)*4"}' } }],
        } }] });
        else json(response, finalPayload('20'));
      }, async baseUrl => {
        const registry = new ToolRegistry();
        registry.register({ name: 'calculator', description: 'Arithmetic', parameters: {
          type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'],
        }, handler: args => calculate(args.expression as string) });
        // 仅用于 L0：使用已知可用的循环，使 Provider 验收不依赖尚未完成的 L1。
        const delta = await runLoop(selectedProvider(mode, options(baseUrl)), registry,
          [{ role: 'user', content: 'Calculate (2+3)*4.' }], 3, () => undefined, signal);
        assert.equal(bodies.length, 2);
        assert.equal(delta[1].toolCallId, 'calculate-20');
        assert.ok(delta[0].reasoningContent === MOCK_REASONING, 'Preserve reasoning returned alongside a tool call');
        assert.ok(isDeepStrictEqual(JSON.parse(delta[1].content), { ok: true, result: 20 }));
        assert.equal(delta.at(-1)?.content, '20');
        const history = bodies[1].messages as Record<string, unknown>[];
        const observation = history.at(-1);
        assert.ok(history.at(-2)?.reasoning_content === MOCK_REASONING, 'Resend reasoning_content on the next assistant history message');
        assert.equal(observation?.role, 'tool');
        assert.equal(observation?.tool_call_id, 'calculate-20');
        assert.ok(isDeepStrictEqual(JSON.parse(String(observation?.content)), { ok: true, result: 20 }));
        for (const body of bodies) assertKimiRequestOptions(body);
      });
    }),
    malformedCase(mode, 'L0/reject-malformed-json', 'not valid JSON', true),
    malformedCase(mode, 'L0/reject-malformed-envelope', { choices: [] }),
    malformedCase(mode, 'L0/reject-nonobject-tool-arguments', { choices: [{ message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'one', type: 'function', function: { name: 'calculator', arguments: '[]' } }],
    } }] }),
    malformedCase(mode, 'L0/reject-length-finish', { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'partial output' } }] }),
    malformedCase(mode, 'L0/reject-incomplete-finish', { choices: [{ finish_reason: null, message: { role: 'assistant', content: 'not a completed response' } }] }),
    ...[401, 429].map(status => contract(`L0/http-${status}-redacted-no-retry`, async signal => {
      let requests = 0;
      await withServer(signal, (_request, response) => {
        requests++;
        json(response, { error: { message: REMOTE_PRIVATE_MARKER, credential: MOCK_KEY } }, status);
      }, async baseUrl => {
        await expectedFailure(() => selectedProvider(mode, options(baseUrl)).complete(structuredClone(input), noTools, signal));
        assert.equal(requests, 1, `HTTP ${status} must not trigger automatic retries`);
      });
    })),
    contract('L0/bounded-response-bytes', async signal => {
      let requests = 0;
      await withServer(signal, (_request, response) => { requests++; json(response, finalPayload('x'.repeat(1000))); }, async baseUrl => {
        await expectedFailure(() => selectedProvider(mode, options(baseUrl, { maxResponseBytes: 128 }))
          .complete(structuredClone(input), noTools, signal));
        assert.equal(requests, 1);
      });
    }),
    contract('L0/caller-cancellation-reason', async parent => {
      const controller = new AbortController(), reason = new Error('Cancel the Kimi contract request');
      const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
      let markStarted!: () => void;
      const started = new Promise<void>(resolve => { markStarted = resolve; });
      let reply: ServerResponse | undefined;
      await withServer(parent, (_request, response) => { reply = response; markStarted(); }, async baseUrl => {
        const outcome = selectedProvider(mode, options(baseUrl)).complete(structuredClone(input), noTools, signal)
          .then(value => ({ kind: 'resolved' as const, value }), error => ({ kind: 'rejected' as const, error: error as unknown }));
        const first = await Promise.race([started.then(() => ({ kind: 'started' as const })), outcome]);
        if (first.kind === 'rejected') {
          if (first.error instanceof ExerciseNotImplemented) throw first.error;
          assert.fail('The provider rejected before reaching the local cancellation mock');
        }
        assert.equal(first.kind, 'started', 'Cancellation contract requires an active request');
        controller.abort(reason);
        const timer = setTimeout(() => { if (reply && !reply.writableEnded) json(reply, finalPayload('late output')); }, 20);
        try {
          const result = await outcome;
          assert.equal(result.kind, 'rejected', 'An aborted request must not return a late response');
          assert.ok(result.kind === 'rejected' && result.error === reason, 'Propagate the original caller cancellation reason');
        } finally { clearTimeout(timer); }
      });
    }),
    contract('L0/request-timeout', async signal => {
      let requests = 0, timer: ReturnType<typeof setTimeout> | undefined;
      await withServer(signal, (_request, response) => {
        requests++;
        // 即使学习者未实现超时，也在 25ms 后返回有效数据，避免本用例一直等待。
        timer = setTimeout(() => { if (!response.writableEnded) json(response, finalPayload('late output')); }, 25);
      }, async baseUrl => {
        try {
          await expectedFailure(() => selectedProvider(mode, options(baseUrl, { timeoutMs: 10 }))
            .complete(structuredClone(input), noTools, signal));
          // 超时预算也涵盖建立连接。在 CPU 繁忙时，超时可能早于
          // 本机回环服务收到请求；这两种情况都不允许重试。
          assert.ok(requests <= 1, 'A timed out request must not trigger automatic retries');
        } finally { if (timer) clearTimeout(timer); }
      });
    }),
  ];
}
