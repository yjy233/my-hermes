/** 通过可移植的子进程调用入口，隔离个人配置目录和在线模型服务。 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ProfileLock } from '../src/profile-lock.js';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const loader = import.meta.resolve('tsx');
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'hermes-cli-'));
  const home = join(root, 'profile');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const invoke = (args: string[], input?: string) => spawnSync(
    process.execPath, ['--import', loader, join(project, 'src', 'cli.ts'), ...args],
    { input, cwd: root, encoding: 'utf-8', timeout: 15_000,
      env: { ...process.env, MY_HERMES_HOME: home } },
  );
  return { home, invoke };
}

test('CLI init, one-shot chat, trace, session/history inspection and idempotent initialization', (t) => {
  const { home, invoke } = fixture(t);
  const version = invoke(['--version']);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), '0.2.0');
  const initialized = invoke(['init']);
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(existsSync(join(home, 'config.json')), true);
  assert.equal(existsSync(join(home, 'sessions.db')), true);
  const chat = invoke(['chat', '--provider', 'demo', '--message', '/calc (2+3)*4', '--trace']);
  assert.equal(chat.status, 0, chat.stderr);
  const result = JSON.parse(chat.stdout.slice(chat.stdout.indexOf('{')));
  assert.deepEqual(result, { ok: true, result: 20 });
  const events = readFileSync(join(home, 'traces.jsonl'), 'utf8').trim().split('\n')
    .map(line => JSON.parse(line).event);
  assert.ok(events.includes('tool.start') && events.includes('turn.persisted'));
  const sessions = invoke(['sessions']);
  assert.equal(sessions.status, 0, sessions.stderr);
  const rows = JSON.parse(sessions.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].messageCount, 4);
  const history = invoke(['history', rows[0].id]);
  assert.equal(history.status, 0, history.stderr);
  const messages = JSON.parse(history.stdout);
  assert.deepEqual(messages.map((message: { role: string }) => message.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(messages[1].toolCalls[0].id, messages[2].toolCallId);
  const configPath = join(home, 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.mode = 'learner';
  const custom = JSON.stringify(config, null, 2) + '\n';
  writeFileSync(configPath, custom);
  assert.equal(invoke(['init']).status, 0);
  assert.equal(readFileSync(configPath, 'utf8'), custom);
});

test('CLI offline checks pass stages 0 through 5 and never create a persistent profile', (t) => {
  const { home, invoke } = fixture(t);
  const result = invoke(['check', '--all']);
  assert.equal(result.status, 0, result.stderr);
  const stages = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(stages.map(stage => stage.stage), [0, 1, 2, 3, 4, 5]);
  assert.ok(stages.every(stage => stage.status === 'passed'));
  assert.equal(existsSync(home), false);
});

test('CLI Kimi learner stage reports L0 independently of unimplemented Agent algorithms', (t) => {
  const { home, invoke } = fixture(t);
  const result = invoke(['check', '--stage', '0', '--mode', 'learner', '--trace']);
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.stage, 0);
  assert.equal(report.status, 'failed');
  assert.ok(report.cases.some((item: { error?: { name: string; message: string } }) =>
    item.error?.name === 'ExerciseNotImplemented' && item.error.message.includes('L0')));
  assert.match(result.stderr, /L0/u);
  assert.doesNotMatch(result.stderr, /\bL[1-5]\b/u);
  assert.equal(existsSync(home), false);
});

test('CLI JSONL recovers malformed lines, enforces users and returns cached replies', (t) => {
  const { invoke } = fixture(t);
  const message = { eventId: 'stable', channel: 'jsonl', conversationId: 'room', userId: 'alice', text: '/calc 6*7' };
  const input = `bad-json\n${[message, message, { ...message, userId: 'bob' }].map(item => JSON.stringify(item)).join('\n')}\n`;
  const result = invoke(['gateway', '--connector', 'jsonl', '--allow-user', 'alice'], input);
  assert.equal(result.status, 0, result.stderr);
  const replies = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(replies[0].error);
  assert.equal(JSON.parse(replies[1].text.slice(replies[1].text.indexOf('{'))).result, 42);
  assert.equal(replies[1].cached, false);
  assert.equal(replies[2].cached, true);
  assert.equal(replies[3].error.type, 'PermissionDeniedError');
});

test('CLI honors configured learner mode and explicit override without falling back to answers', (t) => {
  const { home, invoke } = fixture(t);
  assert.equal(invoke(['init']).status, 0);
  const configPath = join(home, 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.mode = 'learner';
  config.provider = 'compatible';
  config.baseUrl = 'http://127.0.0.1:1/v1';
  writeFileSync(configPath, JSON.stringify(config));
  const stage = invoke(['check', '--stage', '1', '--mode', 'learner']);
  assert.notEqual(stage.status, 0);
  assert.match(stage.stderr, /L1/u);
  const chat = invoke(['chat', '--message', 'hello']);
  assert.notEqual(chat.status, 0);
  assert.match(chat.stderr, /ExerciseNotImplemented/u);
  assert.equal(chat.stdout.includes('[demo]'), false);
  const configured = invoke(['check', '--stage', '1']);
  assert.notEqual(configured.status, 0);
  assert.match(configured.stderr, /L1/u);
  const override = invoke(['check', '--all', '--mode', 'reference']);
  assert.equal(override.status, 0, override.stderr);
  const retained = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(retained.mode, 'learner');
});

test('CLI chat respects profile ownership and releases its lock after finishing', (t) => {
  const { home, invoke } = fixture(t);
  const lock = new ProfileLock(home).acquire();
  try {
    const busy = invoke(['chat', '--message', 'hello']);
    assert.notEqual(busy.status, 0);
    assert.match(busy.stderr, /Profile already in use/u);
  } finally { lock.release(); }
  const finished = invoke(['chat', '--message', 'hello']);
  assert.equal(finished.status, 0, finished.stderr);
  assert.equal(existsSync(join(home, '.runtime.lock')), false);
});
