import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createHttpServer } from '../src/connectors/http.js';
import { runJsonl } from '../src/connectors/jsonl.js';
import { Gateway, type GatewayAgent } from '../src/gateway/router.js';

const message = (overrides = {}): Record<string, unknown> => ({
  eventId: 'one', channel: 'test', conversationId: 'room', userId: 'alice', text: '你好', ...overrides,
});

function fixture(t: TestContext, agent?: GatewayAgent) {
  const root = mkdtempSync(join(tmpdir(), 'hermes-connectors-'));
  let calls = 0;
  const gateway = new Gateway(agent ?? {
    async run(_key, _scope, text) { calls += 1; return `reply:${text}`; },
  }, { path: join(root, 'state.db') }, (channel, room, user) => JSON.stringify([channel, room, user]),
  new Set(['alice']));
  t.after(() => { gateway.close(); rmSync(root, { recursive: true, force: true }); });
  return { gateway, calls: () => calls };
}

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  const completion = new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve(); });
  });
  server.closeAllConnections();
  await completion;
}

test('JSONL validates UTF8 and bounds oversized lines, then recovers and deduplicates', async (t) => {
  const { gateway, calls } = fixture(t);
  const chunks: Buffer[] = [];
  const output = new Writable({ write(chunk: Buffer, _encoding, done) { chunks.push(chunk); done(); } });
  const valid = JSON.stringify(message());
  await runJsonl(gateway, Readable.from([
    Buffer.from([0xff, 10]), Buffer.from('x'.repeat(64_001)),
    Buffer.from(`\ninvalid\n${valid}\n${valid}`),
  ]), output);
  const replies = Buffer.concat(chunks).toString('utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(replies[0].error);
  assert.match(replies[1].error.message, /exceeds/u);
  assert.ok(replies[2].error);
  assert.equal(replies[3].text, 'reply:你好');
  assert.equal(replies[4].cached, true);
  assert.equal(calls(), 1);
});

test('HTTP authentication, input bounds, strict UTF8, allowlist and durable cached events', async (t) => {
  const { gateway, calls } = fixture(t);
  const server = createHttpServer(gateway, { token: 'test-secret', maxBodyBytes: 1000 });
  const base = await listen(server);
  t.after(() => close(server));
  const post = async (body: string | Buffer, token = 'test-secret') => {
    const response = await fetch(`${base}/message`, {
      method: 'POST', body: typeof body === 'string' ? body : new Uint8Array(body),
      headers: { Authorization: `Bearer ${token}` },
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { status: 'ok' });
  assert.equal((await post(JSON.stringify(message()), 'wrong')).status, 401);
  assert.equal(calls(), 0);
  assert.equal((await post('not-json')).status, 400);
  assert.equal((await post(Buffer.from([0xff]))).status, 400);
  assert.equal((await post('x'.repeat(1001))).status, 413);
  assert.equal((await post(JSON.stringify(message({ userId: 'mallory' })))).status, 403);
  const good = await post(JSON.stringify(message()));
  assert.equal(good.status, 200);
  assert.equal(good.body.text, 'reply:你好');
  assert.equal((await post(JSON.stringify(message()))).body.cached, true);
  assert.equal((await post(JSON.stringify(message({ text: 'changed' })))).status, 409);
  assert.equal(calls(), 1);
});

test('HTTP timeout aborts the Agent and never caches a timed out response', async (t) => {
  let aborted = false;
  const { gateway } = fixture(t, {
    async run(_key, _scope, _text, signal) {
      try { await delay(10_000, undefined, { signal }); }
      catch (error) { aborted = true; throw error; }
      return 'too late';
    },
  });
  const server = createHttpServer(gateway, { token: 'secret', requestTimeoutMs: 30 });
  const base = await listen(server);
  t.after(() => close(server));
  const response = await fetch(`${base}/message`, {
    method: 'POST', body: JSON.stringify(message()), headers: { Authorization: 'Bearer secret' },
  });
  assert.equal(response.status, 504);
  assert.equal(aborted, true);
});

test('HTTP reports internal TypeError as 500 without echoing sensitive error details', async (t) => {
  const { gateway } = fixture(t, {
    async run() { throw new TypeError('sensitive provider details'); },
  });
  const server = createHttpServer(gateway, { token: 'secret' });
  const base = await listen(server);
  t.after(() => close(server));
  const response = await fetch(`${base}/message`, {
    method: 'POST', body: JSON.stringify(message()), headers: { Authorization: 'Bearer secret' },
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Agent request failed' });
});

test('HTTP aborts in-flight Agent when client disconnects', async (t) => {
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  let observedAbort!: () => void;
  const aborted = new Promise<void>((resolve) => { observedAbort = resolve; });
  const { gateway } = fixture(t, {
    async run(_key, _scope, _text, signal) {
      started();
      try { await delay(10_000, undefined, { signal }); }
      catch (error) { observedAbort(); throw error; }
      return 'late';
    },
  });
  const server = createHttpServer(gateway, { token: 'secret' });
  const base = await listen(server);
  t.after(() => close(server));
  const client = request(`${base}/message`, {
    method: 'POST', headers: { Authorization: 'Bearer secret' },
  });
  client.on('error', () => { /* 主动断开连接后，预期会收到连接挂断错误。 */ });
  client.end(JSON.stringify(message()));
  await entered;
  client.destroy();
  await Promise.race([aborted, delay(1000).then(() => { throw new Error('Abort was not observed'); })]);
});

test('HTTP requires loopback binding, bounded configuration, bearer token and explicit users', (t) => {
  const { gateway } = fixture(t);
  assert.throws(() => createHttpServer(gateway, { token: 'secret', host: '0.0.0.0' }), /loopback/u);
  assert.throws(() => createHttpServer(gateway, { token: '' }), /token/u);
  assert.throws(() => createHttpServer(gateway, { token: 'secret', maxBodyBytes: 2_000_000 }), /maxBody/u);
  const root = mkdtempSync(join(tmpdir(), 'hermes-http-denied-'));
  const other = new Gateway({ async run() { return ''; } }, { path: join(root, 'state.db') }, () => 'key');
  try { assert.throws(() => createHttpServer(other, { token: 'secret' }), /allowlist/u); }
  finally { other.close(); rmSync(root, { recursive: true, force: true }); }
});
