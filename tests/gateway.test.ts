import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  EventConflictError, Gateway, PermissionDeniedError, parseInbound,
  type GatewayAgent, type InboundMessage,
} from '../src/gateway/router.js';

const route = (channel: string, conversation: string, user: string): string =>
  JSON.stringify([channel, conversation, user]);
const message = (overrides: Partial<InboundMessage> = {}): InboundMessage => ({
  eventId: '1', channel: 'test', conversationId: 'room', userId: 'alice', text: 'hello', ...overrides,
});

class EchoAgent implements GatewayAgent {
  calls: Array<[string, string, string]> = [];
  active = 0;
  peak = 0;
  failOnce = false;
  async run(key: string, scope: string, text: string, signal?: AbortSignal): Promise<string> {
    this.calls.push([key, scope, text]);
    if (this.failOnce) { this.failOnce = false; throw new Error('transient'); }
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    try { await delay(15, undefined, { signal }); }
    finally { this.active -= 1; }
    return `reply:${text}`;
  }
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'hermes-gateway-'));
  const agent = new EchoAgent();
  const store = { path: join(root, 'events.db') };
  const gateway = new Gateway(agent, store, route, new Set(['alice', 'bob']));
  t.after(() => { gateway.close(); rmSync(root, { recursive: true, force: true }); });
  return { gateway, agent, store };
}

test('durable completed dedupe, changed payload conflict and restart', async (t) => {
  const { gateway, agent, store } = fixture(t);
  const replies = await Promise.all(Array.from({ length: 8 }, () => gateway.handle(message())));
  assert.equal(replies.filter((reply) => !reply.cached).length, 1);
  assert.equal(agent.calls.length, 1);
  await assert.rejects(gateway.handle(message({ text: 'changed' })), EventConflictError);
  gateway.close();
  const restored = new Gateway(agent, store, route);
  try {
    assert.equal((await restored.handle(message())).cached, true);
    assert.equal(agent.calls.length, 1);
  } finally { restored.close(); }
});

test('authorization, session isolation, concurrent sessions and serial same-session turns', async (t) => {
  const { gateway, agent } = fixture(t);
  await assert.rejects(gateway.handle(message({ userId: 'mallory' })), PermissionDeniedError);
  assert.equal(agent.calls.length, 0);
  const [alice, bob] = await Promise.all([
    gateway.handle(message()), gateway.handle(message({ userId: 'bob' })),
  ]);
  assert.notEqual(alice!.sessionKey, bob!.sessionKey);
  assert.notEqual(agent.calls[0]![1], agent.calls[1]![1]);
  assert.equal(agent.peak, 2);
  agent.peak = 0;
  await Promise.all([
    gateway.handle(message({ eventId: 'a' })), gateway.handle(message({ eventId: 'b' })),
  ]);
  assert.equal(agent.peak, 1);
});

test('failed requests retry and aborted queued requests never execute', async (t) => {
  const { gateway, agent } = fixture(t);
  agent.failOnce = true;
  await assert.rejects(gateway.handle(message()), /transient/u);
  assert.equal((await gateway.handle(message())).cached, false);
  assert.equal((await gateway.handle(message())).cached, true);
  const first = gateway.handle(message({ eventId: 'blocking' }));
  const controller = new AbortController();
  const cancelled = gateway.handle(message({ eventId: 'cancelled' }), controller.signal);
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  const next = gateway.handle(message({ eventId: 'next' }));
  await Promise.all([first, next]);
  assert.equal(agent.calls.length, 4);
  assert.equal(agent.peak, 1);
});

test('strict inbound fields and collision-free scope', () => {
  for (const invalid of [
    null, [], {}, { text: 'hi' }, { ...message(), extra: true },
    { ...message(), userId: 42 }, { ...message(), text: ' ' },
    { ...message(), eventId: 'a\nb' }, { ...message(), text: 'x'.repeat(16_001) },
  ]) assert.throws(() => parseInbound(invalid), TypeError);
  assert.deepEqual(parseInbound(message()), message());
  assert.notEqual(Gateway.scopeFor('a:b', 'c'), Gateway.scopeFor('a', 'b:c'));
});
