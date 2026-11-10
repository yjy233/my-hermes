import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

function invoke(home: string, args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args, '--home', home, '--provider', 'demo'],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 15_000 });
}

test('curator CLI supports management, previews, slash commands and a detached worker with real reports', async t => {
  const home = mkdtempSync(join(tmpdir(), 'hermes-curator-cli-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const status = invoke(home, ['curator', 'status']); assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).config.consolidate, false);
  mkdirSync(join(home, 'skills', 'old-guide'));
  writeFileSync(join(home, 'skills', 'old-guide', 'SKILL.md'), '---\nname: old-guide\ndescription: Old procedure\n---\nLessons');
  const unmanaged = invoke(home, ['curator', 'list-unmanaged']); assert.equal(unmanaged.status, 0, unmanaged.stderr);
  assert.equal(JSON.parse(unmanaged.stdout)[0].name, 'old-guide');
  assert.equal(invoke(home, ['curator', 'adopt', 'old-guide']).status, 0);
  const run = invoke(home, ['curator', 'run', '--consolidate', '--dry-run']); assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout); assert.equal(report.dry_run, true); assert.ok(existsSync(report.report_path));
  assert.match(readFileSync(report.report_path, 'utf8'), /Demo provider/);
  assert.equal(invoke(home, ['curator', 'lock', 'old-guide']).status, 0);
  assert.equal(invoke(home, ['curator', 'archive', 'old-guide']).status, 1);
  assert.equal(invoke(home, ['curator', 'unlock', 'old-guide']).status, 0);
  const slash = invoke(home, ['chat', '--message', '/curator usage --sort name']); assert.equal(slash.status, 0, slash.stderr);
  assert.ok(JSON.parse(slash.stdout).some((row: { name: string }) => row.name === 'old-guide'));
  const background = invoke(home, ['curator', 'run', '--background']); assert.equal(background.status, 0, background.stderr);
  const worker = JSON.parse(background.stdout); assert.ok(worker.pid > 0);
  let completed = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(worker.log) && readFileSync(worker.log, 'utf8').includes('report_path')) { completed = true; break; }
    await delay(50);
  }
  if (!completed) { try { process.kill(worker.pid, 'SIGTERM'); } catch { /* already exited */ } }
  assert.equal(completed, true, existsSync(worker.log) ? readFileSync(worker.log, 'utf8') : 'No worker log');
});

test('automatic maintenance worker performs real archival while the parent event loop stays available', async t => {
  const { initializeProfile, loadSettings } = await import('../src/config.js');
  const { createCurator, runCuratorWorker } = await import('../src/curator/cli.js');
  const home = mkdtempSync(join(tmpdir(), 'hermes-curator-worker-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const settings = loadSettings(home, { provider: 'demo' }); initializeProfile(settings);
  const curator = createCurator(settings);
  curator.repo.mutate({ action: 'create', name: 'old', description: 'Old lesson', content: 'Useful guidance' });
  curator.repo.update('old', row => { row.created_at = '2020-01-01T00:00:00Z'; });
  let beats = 0; const timer = setInterval(() => beats++, 1);
  try {
    const report = await runCuratorWorker(settings, curator, new AbortController().signal);
    assert.equal(report.error, undefined); assert.equal(report.counts.archived, 1);
    assert.equal(curator.repo.archives()[0].name, 'old'); assert.ok(beats > 0);
  } finally { clearInterval(timer); }
});
