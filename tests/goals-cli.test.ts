import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { SessionStore } from '../src/memory/store.js';
import { GoalManager } from '../src/goals/manager.js';
import { DemoProvider } from '../src/core/providers.js';
import { loadAlgorithms } from '../src/learning/index.js';
import { Gateway } from '../src/gateway/router.js';

function invoke(home: string, args: string[], input?: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args, '--home', home, '--provider', 'demo'],
    { encoding: 'utf8', cwd: process.cwd(), timeout: 15_000, input });
}

test('CLI goal set runs a real calculator turn, persists completion, and status is read-only across restart', t => {
  const home = mkdtempSync(join(tmpdir(), 'hermes-goals-cli-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const run = invoke(home, ['goal', 'set', '/calc (2+3)*4', '--max-turns', '3']);
  assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /"result":20/); assert.match(run.stderr, /calculator returned/);
  const status = invoke(home, ['goal', 'status']); assert.equal(status.status, 0, status.stderr);
  const state = JSON.parse(status.stdout); assert.equal(state.status, 'done'); assert.equal(state.turns_used, 1); assert.equal(state.max_turns, 3);
  const store = new SessionStore(join(home, 'sessions.db')); const manager = new GoalManager(store, new DemoProvider());
  const session = store.listSessions()[0]; manager.resume(session.id); store.close();
  const activeStatus = invoke(home, ['goal', 'status']); assert.equal(JSON.parse(activeStatus.stdout).turns_used, 0); assert.doesNotMatch(activeStatus.stdout, /\[goal /);
  const pause = invoke(home, ['goal', 'pause']); assert.equal(JSON.parse(pause.stdout).status, 'paused');
  const resume = invoke(home, ['goal', 'resume']); assert.equal(resume.status, 0, resume.stderr); assert.match(resume.stdout, /"result":20/);
  const invalid = invoke(home, ['goal', 'set', '/calc 1/0']); assert.equal(invalid.status, 0, invalid.stderr);
  const failedStatus = invoke(home, ['goal', 'status']); assert.equal(JSON.parse(failedStatus.stdout).status, 'paused');
  assert.equal(JSON.parse(failedStatus.stdout).last_verdict, 'blocked');
});

test('JSONL receives goal answers separately, preserves deduplication and permits status polling', t => {
  const home = mkdtempSync(join(tmpdir(), 'hermes-goals-jsonl-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const event = { eventId: 'set', channel: 'jsonl', conversationId: 'room', userId: 'alice', text: '/goal set /calc 3*7' };
  const result = invoke(home, ['gateway', '--connector', 'jsonl', '--allow-user', 'alice'], JSON.stringify(event) + '\n' + JSON.stringify(event) + '\n');
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.filter(line => line.type === 'goal.answer').length, 1);
  assert.equal(lines.filter(line => line.cached === true).length, 1);
  assert.ok(lines.some(line => line.type === 'goal.decision' && line.decision.status === 'done'));
});

test('restart does not resume a goal whose user is no longer authorized by the Gateway', t => {
  const home = mkdtempSync(join(tmpdir(), 'hermes-goals-restore-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SessionStore(join(home, 'sessions.db')), manager = new GoalManager(store, new DemoProvider());
  const key = loadAlgorithms('reference').sessionKey('jsonl', 'room', 'alice');
  manager.set(store.getOrCreate(key, Gateway.scopeFor('jsonl', 'alice')), '/calc 9*9'); store.close();
  const run = invoke(home, ['gateway', '--connector', 'jsonl', '--allow-user', 'bob'], '');
  assert.equal(run.status, 0, run.stderr); assert.equal(run.stdout.trim(), '');
  const reopened = new SessionStore(join(home, 'sessions.db'));
  try { assert.equal(reopened.loadMessages(reopened.listSessions()[0].id).length, 0); } finally { reopened.close(); }
});
