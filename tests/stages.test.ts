/** 验收命令必须执行学习者代码、报告有用的失败信息，并保持各阶段独立。 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkStage } from '../src/lab.js';
import { loadAlgorithms } from '../src/learning/index.js';
import { runStageCases } from '../src/stages/runner.js';

for (const stage of [0, 1, 2, 3, 4, 5]) test(`stage ${stage} reference has named passing contracts and trace boundaries`, async () => {
  const events: string[] = [];
  const result = await checkStage(stage, 'reference', { emit: event => { events.push(event); } });
  assert.equal(result.status, 'passed', JSON.stringify(result.cases));
  assert.ok(result.total > 1); assert.equal(result.passed, result.total); assert.equal(result.failed, 0);
  assert.equal(new Set(result.cases.map(item => item.name)).size, result.total);
  assert.equal(events.filter(event => event === 'case.start').length, result.total);
  assert.equal(events.filter(event => event === 'case.passed').length, result.total);
});

for (const stage of [0, 1, 2, 3, 5]) test(`stage ${stage} learner TODO is a named failure and never a reference pass`, async () => {
  const result = await checkStage(stage, 'learner');
  assert.equal(result.status, 'failed');
  assert.ok(result.cases.some(item => item.error?.name === 'ExerciseNotImplemented'));
  assert.ok(result.cases.every(item => item.name));
});

test('stage 4 is independent of unimplemented exercise algorithms', async () => {
  assert.equal((await checkStage(4, 'learner')).status, 'passed');
});

test('Kimi Provider stage 0 selects its own learner implementation independently of L1 through L5', async () => {
  const reference = await checkStage(0, 'reference', {}, loadAlgorithms('learner'));
  assert.equal(reference.status, 'passed', JSON.stringify(reference.cases));
  const learner = await checkStage(0, 'learner', {}, loadAlgorithms('reference'));
  assert.equal(learner.status, 'failed');
  const errors = learner.cases.flatMap(item => item.error ? [item.error] : []);
  assert.ok(errors.some(error => error.name === 'ExerciseNotImplemented' && /\bL0\b/u.test(error.message)));
  assert.ok(errors.every(error => !/\bL[1-5]\b/u.test(error.message)));
});

test('a learner loop that passes the happy path still fails tool/termination contracts', async () => {
  const reference = loadAlgorithms('reference');
  const result = await checkStage(1, 'learner', {}, {
    ...reference,
    // 只覆盖正常路径的循环可能看似可用，却遗漏调用方要求的动作步数上限。
    runLoop: (provider, registry, messages, _steps, emit, signal) =>
      reference.runLoop(provider, registry, messages, 100, emit, signal),
  });
  assert.equal(result.status, 'failed');
  assert.ok(result.passed > 0 && result.failed > 0);
});

test('stage memory contracts reject a subtly wrong relevance policy', async () => {
  const reference = loadAlgorithms('reference');
  const result = await checkStage(2, 'learner', {}, {
    ...reference, selectMemories: (_query, hits, limit) => hits.slice(0, limit),
  });
  assert.equal(result.status, 'failed');
  assert.ok(result.passed > 0 && result.failed > 0);
});

test('runner continues after a failure, contains hanging promises, and ignores observer exceptions', async () => {
  const result = await runStageCases(1, 'learner', [
    { name: 'bad', run() { throw new Error('wrong algorithm'); } },
    { name: 'hang', run: async () => new Promise<void>(() => {}) },
    { name: 'later', run() {} },
  ], { caseTimeoutMs: 10, emit() { throw new Error('observer'); } });
  assert.deepEqual(result.cases.map(item => item.status), ['failed', 'failed', 'passed']);
  assert.equal(result.cases[1].error?.name, 'TimeoutError');
});

test('runner cancellation stops further cases and debug retains useful failure stacks', async () => {
  const controller = new AbortController(); const reason = new Error('stop');
  let later = false;
  await assert.rejects(runStageCases(1, 'learner', [
    { name: 'cancel', run() { controller.abort(reason); } },
    { name: 'later', run() { later = true; } },
  ], { signal: controller.signal }), error => error === reason);
  assert.equal(later, false);
  const debug = await runStageCases(1, 'learner', [{ name: 'debug', run() { throw new Error('debug detail'); } }], { debug: true });
  assert.match(debug.cases[0].error?.stack ?? '', /stages\.test\.ts/);
});

test('CLI --all reports all learner stages, emits trace on stderr and leaves the profile untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'hermes-stage-cli-'));
  try {
    const home = join(root, 'profile');
    const child = spawnSync(process.execPath, [
      '--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
      'check', '--all', '--mode', 'learner', '--trace',
    ], { cwd: root, env: { ...process.env, MY_HERMES_HOME: home }, encoding: 'utf8', timeout: 15_000 });
    assert.equal(child.status, 1, child.stderr);
    const reports = child.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(reports.map(item => item.stage), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(reports.map(item => item.status), ['failed', 'failed', 'failed', 'failed', 'passed', 'failed']);
    assert.match(child.stderr, /case\.start/); assert.match(child.stderr, /case\.failed/);
    assert.match(child.stderr, /L0/); assert.match(child.stderr, /L1/); assert.match(child.stderr, /L2/); assert.match(child.stderr, /L4/); assert.match(child.stderr, /L5/);
    assert.equal(existsSync(home), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unimplemented learner loop cannot pass a rejection contract merely by throwing TODO', async () => {
  const result = await checkStage(1, 'learner');
  assert.equal(result.passed, 0, JSON.stringify(result.cases));
});

test('debug mode stays cancelable even when a learner promise ignores its signal', async () => {
  const controller = new AbortController(); const reason = new Error('debug interrupted');
  const result = runStageCases(1, 'learner', [{ name: 'stalled breakpoint', run() {
    queueMicrotask(() => controller.abort(reason));
    return new Promise<void>(() => {});
  } }], { debug: true, signal: controller.signal });
  await assert.rejects(result, error => error === reason);
});
