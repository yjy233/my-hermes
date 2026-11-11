import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { SessionStore } from '../src/memory/store.js';
import { GoalManager } from '../src/goals/manager.js';
import { GoalRuntime, type GoalEvent } from '../src/goals/runtime.js';
import { parseContract, parseJudge, continuationPrompt } from '../src/goals/prompts.js';
import { runGate } from '../src/goals/gates.js';
import type { Provider } from '../src/core/models.js';
import type { GatewayAgent } from '../src/gateway/router.js';
import { Gateway } from '../src/gateway/router.js';
import { goalCommand } from '../src/goals/commands.js';
import { createServer } from 'node:http';
import { loadSettings } from '../src/config.js';
import { createGoalProvider } from '../src/goals/provider.js';

const decisionProvider = (verdict = 'continue'): Provider => ({ complete: async () => ({ content: JSON.stringify({ verdict, reason: `test ${verdict}` }) }) });
function fixture(t: TestContext, provider: Provider = decisionProvider(), options: ConstructorParameters<typeof GoalManager>[2] = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hermes-goals-'))), store = new SessionStore(join(root, 'sessions.db'));
  const session = store.getOrCreate('key', 'scope'), manager = new GoalManager(store, provider, options);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const turn = (content = 'Work in progress') => {
    const state = manager.beginTurn(session.id)!;
    store.appendMessages(session.id, [{ role: 'user', content: 'next' }, { role: 'assistant', content }]);
    return manager.recordTurn(session.id, state.id);
  };
  return { root, store, session, manager, turn };
}
class RecordingAgent implements GatewayAgent {
  calls: string[] = [];
  active = 0; peak = 0;
  constructor(readonly store: SessionStore, readonly answer: (text: string, index: number, signal?: AbortSignal) => Promise<string> = async () => 'Work completed') {}
  async run(key: string, scope: string, text: string, signal?: AbortSignal): Promise<string> {
    this.active++; this.peak = Math.max(this.peak, this.active); this.calls.push(text);
    try {
      const result = await this.answer(text, this.calls.length, signal); signal?.throwIfAborted();
      const session = this.store.getOrCreate(key, scope);
      this.store.appendMessages(session.id, [{ role: 'user', content: text }, { role: 'assistant', content: result }]); return result;
    } finally { this.active--; }
  }
}

test('message watermark and execution identity exclude old answers and pre-resume callbacks', t => {
  const { manager, session, store } = fixture(t);
  store.appendMessages(session.id, [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'old answer' }]);
  manager.set(session, 'New work'); const first = manager.beginTurn(session.id)!;
  manager.recordTurn(session.id, first.id, first.execution_id); assert.equal(manager.load(session.id)?.turns_used, 0);
  manager.pause(session.id); manager.resume(session.id); const second = manager.beginTurn(session.id)!;
  store.appendMessages(session.id, [{ role: 'user', content: 'new' }, { role: 'assistant', content: 'new answer' }]);
  manager.recordTurn(session.id, first.id, first.execution_id); assert.equal(manager.load(session.id)?.turns_used, 0);
  manager.recordTurn(session.id, second.id, second.execution_id); assert.equal(manager.load(session.id)?.turns_used, 1);
  manager.recordTurn(session.id, second.id, second.execution_id); assert.equal(manager.load(session.id)?.turns_used, 1);
});

test('runtime sends failing gate evidence to the next full turn and only judges after the gate passes', async t => {
  let checked = 0, judged = 0;
  const { manager, session, root, store } = fixture(t, { complete: async () => { judged++; return { content: '{"verdict":"done"}' }; } },
    { allowGates: true, gateRunner: async () => (++checked === 1 ? { passed: false, exitCode: 1, output: 'assertion: expected 4' } : { passed: true, exitCode: 0, output: 'passed' }) });
  manager.set(session, 'Fix calculation'); manager.addGate(session.id, 'npm test', root);
  const agent = new RecordingAgent(store), runtime = new GoalRuntime(agent, manager); t.after(() => runtime.close());
  runtime.start(); await runtime.idle();
  assert.equal(agent.calls.length, 2); assert.match(agent.calls[1], /assertion: expected 4/); assert.match(agent.calls[1], /npm test/);
  assert.equal(judged, 1); assert.equal(manager.load(session.id)?.status, 'done'); assert.equal(manager.load(session.id)?.gates[0].attempts, 0);
});

test('restored WAIT stays parked and cannot exceed the remaining turn budget when it wakes', async t => {
  let now = 1000;
  const { manager, session, store, turn } = fixture(t, { complete: async () => ({ content: '{"verdict":"wait","wait_for_seconds":60}' }) }, { environment: { now: () => now } });
  manager.set(session, 'Wait for result', 1); turn(); await manager.evaluateAfterTurn(session.id);
  const agent = new RecordingAgent(store), runtime = new GoalRuntime(agent, new GoalManager(store, decisionProvider(), { environment: { now: () => now } }));
  t.after(() => runtime.close()); runtime.start(); await runtime.idle(); assert.equal(agent.calls.length, 0);
  now += 60_001; runtime.tick(); await runtime.idle();
  assert.equal(agent.calls.length, 0); assert.equal(manager.load(session.id)?.status, 'paused'); assert.equal(manager.load(session.id)?.turns_used, 1);
});

test('shutdown cancels an uncooperative judge and preserves its pending phase for recovery', async t => {
  let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
  const { manager, store, session } = fixture(t, { complete: () => { enter(); return new Promise(() => {}); } });
  const runtime = new GoalRuntime(new RecordingAgent(store), manager); t.after(() => runtime.close());
  await runtime.run('key', 'scope', '/goal set Work'); await entered;
  await runtime.close(); assert.equal(manager.load(session.id)?.status, 'active'); assert.equal(manager.load(session.id)?.phase, 'judge');
  const recovered = new GoalRuntime(new RecordingAgent(store), new GoalManager(store, decisionProvider('done'))); t.after(() => recovered.close());
  recovered.start(); await recovered.idle(); assert.equal(manager.load(session.id)?.status, 'done');
});

test('shutdown drains foreground bookkeeping even when an injected agent never settles', async t => {
  let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
  const { manager } = fixture(t);
  const runtime = new GoalRuntime({ run: () => { enter(); return new Promise(() => {}); } }, manager); t.after(() => runtime.close());
  const pending = runtime.run('key', 'scope', 'ordinary'); const rejected = assert.rejects(pending, /closed/);
  await entered; await runtime.close(); await rejected; await runtime.idle();
});

test('goal settings merge strictly and auxiliary routing sends explicit token budgets to local providers', async t => {
  const { root } = fixture(t);
  writeFileSync(join(root, 'config.json'), JSON.stringify({ goals: { max_turns: 7, poll_interval_ms: 1000 } }));
  const settings = loadSettings(root, { provider: 'demo', goals: { max_turns: 3 } });
  assert.deepEqual(settings.goals, { max_turns: 3, poll_interval_ms: 1000, judge_timeout_ms: 30_000 });
  assert.throws(() => loadSettings(root, { goals: { max_turns: 0 } }), /goals.max_turns/);
  assert.throws(() => loadSettings(root, { auxiliary: { goal_judge: { max_tokens: 0 } } }), /max_tokens/);
  const requests: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"verdict":"done"}' } }] }));
    })().catch(() => { response.writeHead(500); response.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  for (const [provider, providerMode, max_tokens] of [['compatible', 'learner', undefined], ['kimi', 'learner', 5000], ['kimi', 'reference', 6000]] as const) {
    const configured = { ...settings, providerMode, auxiliary: { goal_judge: { provider, model: 'local-judge', baseUrl: `http://127.0.0.1:${address.port}/v1`, max_tokens } } };
    const model = createGoalProvider(configured, { MOONSHOT_API_KEY: 'local-test-key' });
    assert.equal((await model.complete([{ role: 'user', content: 'judge evidence' }], [])).content, '{"verdict":"done"}');
    const request = requests.at(-1)!; assert.equal(request.model, 'local-judge');
    assert.equal(request[provider === 'kimi' ? 'max_completion_tokens' : 'max_tokens'], max_tokens ?? 4096);
    assert.ok(!request.tools || (Array.isArray(request.tools) && request.tools.length === 0));
  }
});

test('ordinary turns have no goal judge; active goals reuse the full Agent loop for continue then done', async t => {
  let judged = 0;
  const { store, manager, session } = fixture(t, { complete: async () => ({ content: JSON.stringify({ verdict: ++judged === 1 ? 'continue' : 'done', reason: 'evidence' }) }) });
  const agent = new RecordingAgent(store), events: GoalEvent[] = [], runtime = new GoalRuntime(agent, manager, { notify: event => events.push(event) });
  t.after(() => runtime.close());
  await runtime.run('key', 'scope', 'ordinary'); await runtime.idle(); assert.equal(judged, 0); assert.equal(manager.load(session.id), null);
  await runtime.run('key', 'scope', '/goal set build the feature'); await runtime.idle();
  assert.equal(judged, 2); assert.equal(agent.calls.length, 3); assert.equal(manager.load(session.id)?.turns_used, 2);
  assert.equal(manager.load(session.id)?.status, 'done'); assert.equal(agent.peak, 1);
  assert.equal(events.filter(event => event.type === 'goal.answer').length, 2);
});

test('state_meta persists JSON per session, with no goal state leaking to another session', t => {
  const { manager, session, store, root } = fixture(t); manager.set(session, 'Persisted objective');
  const other = store.getOrCreate('other', 'other-scope'); assert.equal(manager.load(other.id), null);
  const reopened = new SessionStore(join(root, 'sessions.db'));
  try { assert.equal(new GoalManager(reopened, decisionProvider()).load(session.id)?.goal, 'Persisted objective'); }
  finally { reopened.close(); }
  const db = new DatabaseSync(store.path);
  try { const row = db.prepare('SELECT value FROM state_meta WHERE key=?').get(`goal:${session.id}`); assert.equal(JSON.parse(String(row?.value)).status, 'active'); }
  finally { db.close(); }
});

test('both real and synthetic turns count once; budget pauses and resume replenishes it', async t => {
  const { manager, session, turn } = fixture(t); manager.set(session, 'Continue', 2);
  turn(); const id = manager.load(session.id)!.id; manager.recordTurn(session.id, id);
  assert.equal(manager.load(session.id)?.turns_used, 1); assert.equal((await manager.evaluateAfterTurn(session.id)).shouldContinue, true);
  turn(); const result = await manager.evaluateAfterTurn(session.id);
  assert.equal(result.status, 'paused'); assert.match(result.reason, /budget/);
  manager.resume(session.id); assert.equal(manager.load(session.id)?.turns_used, 0);
  manager.clear(session.id); assert.equal(manager.load(session.id)?.status, 'cleared');
});

test('blocked pauses without marking done; the final budgeted turn can still complete', async t => {
  const { manager, session, turn } = fixture(t, decisionProvider('blocked')); manager.set(session, 'Need user input'); turn();
  assert.equal((await manager.evaluateAfterTurn(session.id)).status, 'paused'); assert.equal(manager.load(session.id)?.last_verdict, 'blocked');
  const done = new GoalManager(manager.store, decisionProvider('done')); done.set(session, 'Done on last turn', 1); turn('Concrete deliverable');
  assert.equal((await done.evaluateAfterTurn(session.id)).status, 'done');
});

test('parse and transport error streaks are independent and pause at three/five respectively', async t => {
  let transport = false;
  const { manager, session, turn } = fixture(t, { complete: async () => { if (transport) throw new Error('private provider details'); return { content: 'not json' }; } });
  manager.set(session, 'Goal');
  for (let i = 0; i < 3; i++) { turn(); await manager.evaluateAfterTurn(session.id); }
  assert.equal(manager.load(session.id)?.status, 'paused'); assert.equal(manager.load(session.id)?.consecutive_parse_failures, 3);
  transport = true; manager.resume(session.id);
  for (let i = 0; i < 5; i++) { turn(); await manager.evaluateAfterTurn(session.id); }
  assert.equal(manager.load(session.id)?.consecutive_transport_failures, 5);
  assert.equal(manager.load(session.id)?.consecutive_parse_failures, 0); assert.equal(manager.load(session.id)?.status, 'paused');
  assert.doesNotMatch(manager.load(session.id)?.last_reason ?? '', /private provider/);
});

test('late judge results cannot undo pause, replacement or changed completion criteria', async t => {
  let finish!: (value: { content: string }) => void;
  const { manager, session, turn } = fixture(t, { complete: () => new Promise(resolve => { finish = resolve; }) });
  manager.set(session, 'Old goal'); turn(); const evaluation = manager.evaluateAfterTurn(session.id);
  await delay(0); manager.pause(session.id); finish({ content: '{"verdict":"done","reason":"late"}' });
  assert.equal((await evaluation).verdict, 'superseded'); assert.equal(manager.load(session.id)?.status, 'paused');
  manager.resume(session.id); turn(); const second = manager.evaluateAfterTurn(session.id);
  await delay(0); manager.set(session, 'New goal'); finish({ content: '{"verdict":"done","reason":"late"}' }); await second;
  assert.equal(manager.load(session.id)?.goal, 'New goal'); assert.equal(manager.load(session.id)?.status, 'active');
});

test('quality gate failures skip judge, carry concrete output and pause after retry exhaustion', async t => {
  let judges = 0;
  const { manager, session, turn, root } = fixture(t, { complete: async () => { judges++; return { content: '{"verdict":"done"}' }; } },
    { allowGates: true, gateRunner: async () => ({ passed: false, exitCode: 1, output: 'Expected 3 but received 4' }) });
  manager.set(session, 'Fix tests'); manager.addGate(session.id, 'npm test', root, 30, 1);
  turn(); const first = await manager.evaluateAfterTurn(session.id);
  assert.equal(first.shouldContinue, true); assert.match(first.prompt!, /Expected 3 but received 4/); assert.equal(judges, 0);
  turn(); assert.equal((await manager.evaluateAfterTurn(session.id)).status, 'paused'); assert.equal(judges, 0);
});

test('gate command runs in its registered directory; timeout and cancellation terminate the shell', async t => {
  const { root } = fixture(t);
  const command = `${JSON.stringify(process.execPath)} -e 'process.stdout.write(process.cwd())'`;
  const gate = { command, cwd: root, timeout_seconds: 2, max_retries: 3, attempts: 0 };
  const result = await runGate(gate); assert.equal(result.passed, true); assert.equal(result.output, root);
  const hanging = { ...gate, command: `${JSON.stringify(process.execPath)} -e 'setTimeout(()=>{},10000)'`, timeout_seconds: 1 };
  assert.equal((await runGate(hanging)).exitCode, -1);
  const controller = new AbortController(), pending = runGate(hanging, controller.signal); controller.abort(new Error('stop gate'));
  await assert.rejects(pending, /stop gate/);
});

test('remote runtime cannot configure or execute shell gates', async t => {
  const { manager, session, root, turn } = fixture(t); manager.set(session, 'Goal');
  assert.throws(() => manager.addGate(session.id, 'echo bad', root), /local CLI/);
  const local = new GoalManager(manager.store, decisionProvider(), { allowGates: true }); local.addGate(session.id, 'echo check', root);
  turn(); assert.equal((await manager.evaluateAfterTurn(session.id)).status, 'paused');
});

test('time WAIT parks without repeated turns and timer wakes it; unavailable PID falls through', async t => {
  let now = 1000, judges = 0;
  const { manager, store, session } = fixture(t, { complete: async () => ({ content: ++judges === 1
    ? '{"verdict":"wait","wait_for_seconds":60,"reason":"cooldown"}' : '{"verdict":"done","reason":"complete"}' }) }, { environment: { now: () => now, pidAlive: () => false } });
  const agent = new RecordingAgent(store), runtime = new GoalRuntime(agent, manager); t.after(() => runtime.close());
  await runtime.run('key', 'scope', '/goal set work'); await runtime.idle();
  assert.equal(manager.load(session.id)?.phase, 'waiting'); assert.equal(agent.calls.length, 1);
  runtime.tick(); await runtime.idle(); assert.equal(agent.calls.length, 1);
  now += 60_001; runtime.tick(); await runtime.idle(); assert.equal(agent.calls.length, 2); assert.equal(manager.load(session.id)?.status, 'done');
  manager.set(session, 'again'); assert.throws(() => manager.wait(session.id, { pid: 123 }), /not observable/);
});

test('session barriers, delegation completion and process barrier expiry use observable environment state', t => {
  let now = 1000, waiting = true, delegations = 2;
  const { manager, session } = fixture(t, decisionProvider(), { environment: { now: () => now, sessionWaiting: () => waiting, pidAlive: () => true, activeDelegations: () => delegations } });
  manager.set(session, 'wait'); manager.wait(session.id, { session_id: 'job' }); assert.equal(manager.refreshWaiting(session.id)?.phase, 'waiting');
  waiting = false; assert.equal(manager.refreshWaiting(session.id)?.phase, 'run');
  manager.wait(session.id, { seconds: 1000 }); delegations = 1; assert.equal(manager.refreshWaiting(session.id)?.phase, 'run');
  manager.wait(session.id, { pid: 123 }); now += 30 * 60_000; assert.equal(manager.refreshWaiting(session.id)?.phase, 'run');
});

test('restart recovers completed unjudged turns without replay, but pauses an uncommitted turn', async t => {
  const { manager, session, store } = fixture(t, decisionProvider('done')); const initial = manager.set(session, 'Goal'); manager.beginTurn(session.id);
  store.appendMessages(session.id, [{ role: 'user', content: 'work' }, { role: 'assistant', content: 'complete' }]);
  const agent = new RecordingAgent(store), restarted = new GoalRuntime(agent, new GoalManager(store, decisionProvider('done')));
  t.after(() => restarted.close()); restarted.start(); await restarted.idle();
  assert.equal(agent.calls.length, 0); assert.equal(manager.load(session.id)?.status, 'done'); assert.equal(manager.load(session.id)?.turns_used, 1);
  manager.set(session, 'Incomplete'); manager.beginTurn(session.id);
  assert.equal(manager.recover(session.id)?.status, 'paused'); assert.match(manager.load(session.id)?.paused_reason ?? '', /interrupted/);
});

test('queued user input takes priority over automatic continuation and same-session turns never overlap', async t => {
  let finish!: (text: string) => void;
  const { manager, store, session } = fixture(t, decisionProvider('done'));
  const agent = new RecordingAgent(store, async (_text, index) => index === 1 ? new Promise(resolve => { finish = resolve; }) : 'User request handled');
  const runtime = new GoalRuntime(agent, manager); t.after(() => runtime.close());
  await runtime.run('key', 'scope', '/goal set work'); await delay(0); await delay(0);
  const user = runtime.run('key', 'scope', 'new user instruction'); finish('First automatic turn finished'); await user; await runtime.idle();
  assert.equal(agent.calls[1], 'new user instruction'); assert.equal(agent.peak, 1); assert.equal(manager.load(session.id)?.turns_used, 2);
});

test('paused goal never restarts from a late automatic response', async t => {
  let finish!: (text: string) => void;
  const { manager, store, session } = fixture(t);
  const agent = new RecordingAgent(store, async () => new Promise(resolve => { finish = resolve; }));
  const runtime = new GoalRuntime(agent, manager); t.after(() => runtime.close());
  await runtime.run('key', 'scope', '/goal set work'); await delay(0); await delay(0);
  await runtime.run('key', 'scope', '/goal pause'); await runtime.idle();
  finish('late'); await delay(0); assert.equal(manager.load(session.id)?.status, 'paused'); assert.equal(agent.calls.length, 1);
});

test('goal commands remain behind Gateway authorization and completed-event deduplication', async t => {
  const { manager, store } = fixture(t, decisionProvider('done'));
  const agent = new RecordingAgent(store), runtime = new GoalRuntime(agent, manager);
  const gateway = new Gateway(runtime, store, (c, r, u) => JSON.stringify([c, r, u]), new Set(['alice']));
  t.after(async () => { await runtime.close(); gateway.close(); });
  const message = { eventId: 'set', channel: 'test', conversationId: 'room', userId: 'alice', text: '/goal set work' };
  await assert.rejects(gateway.handle({ ...message, userId: 'mallory' }), /allowlist/);
  const first = await gateway.handle(message); await runtime.idle(); const again = await gateway.handle(message); await runtime.idle();
  assert.equal(first.cached, false); assert.equal(again.cached, true); assert.equal(agent.calls.length, 1);
});

test('contracts and subgoals reach both prompts; draft, pause, resume and clear commands work', async t => {
  const { manager, session, root, turn } = fixture(t, { complete: async messages => {
    if (messages[0].content.startsWith('PERSISTENT_GOAL_CONTRACT')) return { content: '{"outcome":"Working feature","verification":"Tests pass"}' };
    const data = JSON.parse(messages[1].content); assert.equal(data.contract.verification, 'Tests pass'); assert.ok(data.subgoals.includes('Add docs'));
    return { content: '{"verdict":"done","reason":"all criteria met"}' };
  } });
  await goalCommand(manager, session, '/goal draft build feature', root);
  await goalCommand(manager, session, '/subgoal Add docs', root); assert.match(continuationPrompt(manager.load(session.id)!), /Tests pass/);
  turn('Tests and docs complete'); assert.equal((await manager.evaluateAfterTurn(session.id)).status, 'done');
  assert.deepEqual(parseContract('Build it\nverify: npm test\nscope: parser only').contract, { verification: 'npm test', boundaries: 'parser only' });
  assert.equal(parseJudge('```json\n{"done":true,"reason":"ok"}\n```').verdict, 'done');
  assert.equal(parseJudge('{"verdict":"wait","reason":"no target"}').verdict, 'continue');
});
