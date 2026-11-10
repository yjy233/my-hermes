import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { SkillRepository } from '../src/curator/repository.js';
import { Curator, CuratorScheduler } from '../src/curator/curator.js';
import { SkillBackups, pack, unpack } from '../src/curator/backup.js';
import { curatorSettings, skillSettings } from '../src/curator/settings.js';
import { curatorTools, pendingEdits, resolvePending } from '../src/curator/tools.js';
import { digest, readJson, safePath, writeJson } from '../src/curator/files.js';
import { DemoProvider } from '../src/core/providers.js';
import type { Message, ModelResponse, Provider } from '../src/core/models.js';
import { EvolutionManager } from '../src/evolution/manager.js';

function setup(t: TestContext, config: object = {}, skills: object = {}) {
  const home = mkdtempSync(join(tmpdir(), 'hermes-curator-'));
  t.after(() => rmSync(home, { force: true, recursive: true }));
  let time = new Date('2026-10-01T00:00:00Z');
  const repo = new SkillRepository(home, curatorSettings(config), skillSettings(skills), () => time);
  const curator = new Curator(repo, new DemoProvider());
  return { home, repo, curator, setTime: (value: string) => { time = new Date(value); } };
}
function create(repo: SkillRepository, name: string, content = 'Unique lesson'): void {
  repo.mutate({ action: 'create', name, description: 'Reusable guidance', content });
}
function age(repo: SkillRepository, name: string, date = '2026-08-01T00:00:00Z'): void {
  repo.update(name, row => { row.created_at = date; row.last_patched_at = date; row.last_viewed_at = undefined; row.last_used_at = undefined; });
}
function scripted(steps: ((messages: Message[]) => ModelResponse)[]): Provider {
  let index = 0;
  return { complete: async messages => { assert.ok(index < steps.length, 'unexpected model step'); return steps[index++](messages); } };
}
const call = (id: string, name: string, args: object): ModelResponse => ({ content: '', reasoningContent: `reason-${id}`, toolCalls: [{ id, name, arguments: args as Record<string, unknown> }] });

test('curator defaults match Hermes; first sight seeds scheduling clock, pause and idle gate automatic runs', async t => {
  const { curator, setTime, repo } = setup(t);
  assert.equal(repo.config.interval_hours, 168); assert.equal(repo.config.min_idle_hours, 2);
  assert.equal(repo.config.stale_after_days, 14); assert.equal(repo.config.archive_after_days, 30);
  assert.equal(repo.config.consolidate, false); assert.equal(repo.config.archive_ttl_days, 0);
  assert.equal(curator.due(999999), false);
  setTime('2026-10-09T00:00:00Z'); assert.equal(curator.due(7199), false); assert.equal(curator.due(7200), true);
  curator.pause(true); assert.equal(curator.due(99999), false); curator.pause(false);
  const result = await curator.maybeRun(7200); assert.equal(result?.error, undefined); assert.equal(curator.state().run_count, 1);
});

test('lifecycle uses latest use/view/patch; pin, lock, unmanaged and paused cron references protect skills', t => {
  const { repo, curator, home } = setup(t);
  for (const name of ['old', 'viewed', 'patched', 'pinned', 'locked', 'cron', 'unmanaged', 'stale']) { create(repo, name); age(repo, name); }
  repo.activity('viewed', 'view'); repo.activity('patched', 'patch');
  repo.protect('pinned', 'pinned', true); repo.protect('locked', 'locked', true);
  repo.update('unmanaged', row => { row.created_by = 'learn'; });
  repo.update('stale', row => { row.created_at = '2026-09-10T00:00:00Z'; row.last_patched_at = row.created_at; });
  writeJson(join(home, 'cron/jobs.json'), { jobs: [{ id: 'job', enabled: false, skills: ['cron'] }] });
  const result = curator.transitions();
  assert.equal(result.archived, 1); assert.equal(result.marked_stale, 1);
  assert.equal(repo.archives()[0].name, 'old'); assert.equal(repo.get('stale').state, 'stale');
  repo.activity('stale', 'use'); assert.equal(curator.transitions().reactivated, 1);
  assert.equal(repo.rows().length, 7);
});

test('bundled skills are mirrored and suppressed after archival; hub and external skills remain protected', t => {
  const { home, repo, curator, setTime } = setup(t, { prune_builtins: true });
  const source = join(home, 'distribution'); mkdirSync(join(source, 'built'), { recursive: true });
  const text = '---\nname: built\ndescription: Builtin\n---\nRules'; writeFileSync(join(source, 'built/SKILL.md'), text);
  repo.syncBuiltins(source); assert.equal(curator.transitions().seeded, 1);
  setTime('2026-11-01T00:00:00Z'); assert.equal(curator.transitions().archived, 1);
  repo.syncBuiltins(source); assert.equal(repo.rows().length, 0); assert.equal(readFileSync(join(source, 'built/SKILL.md'), 'utf8'), text);
  repo.restore('built'); assert.equal(repo.get('built').provenance, 'bundled');
  assert.throws(() => repo.mutate({ action: 'patch', name: 'built', content: text }), /scope/);
  create(repo, 'installed'); writeJson(join(repo.root, '.hub/lock.json'), { installed: { package: { install_path: 'installed' } } });
  assert.equal(repo.get('installed').managed, false); assert.throws(() => repo.archive('installed'), /eligible/);
  const external = new SkillRepository(home, repo.config, skillSettings({ external_dirs: [source], disabled: ['built'] }));
  // 本地和外部同名不能静默覆盖。
  assert.throws(() => external.rows(), /Duplicate/);
});

test('archive/restore preserve a nested complete package including binary bytes and executable modes', t => {
  const { repo } = setup(t);
  repo.mutate({ action: 'create', name: 'nested', category: 'ops/network', description: 'Nested guide', content: 'See scripts/check.sh and assets/data.bin' });
  repo.mutate({ action: 'write_file', name: 'nested', file_path: 'scripts/check.sh', file_content: '#!/bin/sh\nexit 0\n' });
  repo.mutate({ action: 'write_file', name: 'nested', file_path: 'assets/data.bin', file_content: Buffer.from([0, 255, 5]).toString('base64'), encoding: 'base64' });
  chmodSync(join(repo.root, 'ops/network/nested/scripts/check.sh'), 0o755);
  repo.archive('nested'); assert.equal(repo.archives()[0].id, 'nested'); repo.restore('nested');
  assert.deepEqual(readFileSync(join(repo.root, 'nested/assets/data.bin')), Buffer.from([0, 255, 5]));
  assert.equal(statSync(join(repo.root, 'nested/scripts/check.sh')).mode & 0o777, 0o755);
  assert.equal(repo.read('nested', 'assets/data.bin').encoding, 'base64');
});

test('archive collisions restore exact names without confusing name prefixes; TTL starts at archive time', t => {
  const { repo, setTime } = setup(t);
  create(repo, 'git'); age(repo, 'git'); repo.archive('git');
  assert.deepEqual(repo.purge(7, true), []);
  create(repo, 'git'); repo.archive('git'); create(repo, 'git-helpers'); repo.archive('git-helpers');
  assert.equal(repo.archives().length, 3); repo.restore('git'); assert.equal(repo.get('git').name, 'git');
  assert.equal(repo.archives().length, 2); assert.deepEqual(repo.purge(0), []);
  setTime('2026-10-09T00:00:00Z'); assert.equal(repo.purge(7, true).length, 2); assert.equal(repo.purge(7).length, 2);
  assert.equal(repo.archives().length, 0); assert.equal(repo.ledger.entries().filter(e => e.action === 'purge').length, 2);
});

test('dry-run records a report but changes no skills, telemetry or real-run clock', async t => {
  const { repo, curator } = setup(t); create(repo, 'ancient'); age(repo, 'ancient');
  const usage = readFileSync(join(repo.root, '.usage.json')); curator.due(0); const before = curator.state();
  const report = await curator.run({ dryRun: true, consolidate: true });
  assert.equal(report.error, undefined); assert.equal(repo.get('ancient').state, 'active');
  assert.deepEqual(readFileSync(join(repo.root, '.usage.json')), usage);
  assert.equal(curator.state().last_run_at, before.last_run_at); assert.equal(curator.state().run_count, before.run_count);
  assert.ok(existsSync(report.report_path)); assert.equal(curator.backups.list().length, 0);
});

test('tool gate enforces observed prior-step reads, stale hashes, per-file reads, and dry-run writes', async t => {
  const { repo } = setup(t); create(repo, 'guide');
  repo.mutate({ action: 'write_file', name: 'guide', file_path: 'references/note.md', content: 'old' });
  const tools = curatorTools(repo, false); let id = 0;
  const exec = async (name: string, args: object) => JSON.parse((await tools.registry.execute({ id: String(++id), name, arguments: args as Record<string, unknown> })).content);
  tools.nextStep(); await exec('skill_view', { name: 'guide' });
  assert.equal((await exec('skill_manage', { action: 'patch', name: 'guide', old_string: 'Unique', new_string: 'Shared' })).ok, false);
  tools.nextStep();
  assert.equal((await exec('skill_manage', { action: 'write_file', name: 'guide', file_path: 'references/note.md', content: 'new' })).ok, false);
  repo.mutate({ action: 'patch', name: 'guide', old_string: 'Unique', new_string: 'Another' });
  assert.equal((await exec('skill_manage', { action: 'patch', name: 'guide', old_string: 'Unique', new_string: 'Shared' })).ok, false);
  const preview = curatorTools(repo, true);
  const result = await preview.registry.execute({ id: 'preview', name: 'skill_manage', arguments: { action: 'delete', name: 'guide' } });
  assert.match(result.content, /Dry-run/);
});

test('atomic batch rolls back earlier writes and usage if later operation fails; clobbering is rejected', t => {
  const { repo } = setup(t); create(repo, 'guide'); const before = repo.read('guide'), usage = repo.usage(), entries = repo.ledger.entries().length;
  assert.throws(() => repo.batch([
    { action: 'patch', name: 'guide', old_string: 'Unique', new_string: 'Shared' },
    { action: 'patch', name: 'guide', old_string: 'NO_MATCH', new_string: 'bad' },
  ]), /match/);
  assert.equal(repo.read('guide').hash, before.hash); assert.deepEqual(repo.usage(), usage); assert.equal(repo.ledger.entries().length, entries);
  assert.throws(() => repo.batch([
    { action: 'write_file', name: 'guide', file_path: 'references/a.md', content: 'first' },
    { action: 'write_file', name: 'guide', file_path: 'references/a.md', content: 'second' },
  ]), /clobber/);
  repo.batch([
    { action: 'create', name: 'umbrella', description: 'Class guide', content: 'Workflow' },
    { action: 'write_file', name: 'umbrella', file_path: 'references/notes.md', file_content: 'Reusable depth' },
  ]);
  assert.equal(repo.read('umbrella', 'references/notes.md').content, 'Reusable depth');
});

test('model loop actually merges, preserves reasoning continuation, archives packages and rewrites cron', async t => {
  const { repo, home } = setup(t); create(repo, 'narrow', 'Rule A'); create(repo, 'broad', 'Rule B');
  writeJson(join(home, 'cron/jobs.json'), { jobs: [{ id: 'j', skill: 'narrow', skills: ['narrow', 'broad'], enabled: false, prompt: 'keep' }] });
  const provider = scripted([
    () => call('list', 'skills_list', {}),
    () => ({ content: '', reasoningContent: 'read-context', toolCalls: [
      { id: 'source', name: 'skill_view', arguments: { name: 'narrow' } }, { id: 'target', name: 'skill_view', arguments: { name: 'broad' } },
    ] }),
    messages => { assert.equal(messages.find(m => m.toolCalls?.[0].id === 'source')?.reasoningContent, 'read-context'); return call('merge', 'skill_manage', { operations: [{ action: 'patch', name: 'broad', old_string: 'Rule B', new_string: 'Rule A\nRule B' }] }); },
    () => call('verify', 'skill_view', { name: 'broad' }),
    () => call('archive', 'skill_manage', { operations: [{ action: 'delete', name: 'narrow', absorbed_into: 'broad' }] }),
    () => ({ content: 'Merged narrow into broad.\n```yaml\nconsolidations:\n  - from: narrow\n    into: broad\n    reason: shared domain\nprunings: []\n```' }),
  ]);
  const curator = new Curator(repo, provider); const report = await curator.run({ consolidate: true });
  assert.equal(report.error, undefined); assert.match(repo.read('broad').content, /Rule A\nRule B/);
  assert.deepEqual(report.consolidations, [{ from: 'narrow', into: 'broad' }]); assert.equal(repo.archives()[0].name, 'narrow');
  const jobs = readJson<{ jobs: { skills: string[]; enabled: boolean; prompt: string }[] }>(join(home, 'cron/jobs.json'), { jobs: [] });
  assert.deepEqual(jobs.jobs[0].skills, ['broad']); assert.equal(jobs.jobs[0].prompt, 'keep'); assert.equal(jobs.jobs[0].enabled, false);
  assert.equal(curator.backups.list().length, 1);
});

test('model errors keep completed changes auditable and advance schedule; duplicate concurrent run refused', async t => {
  const { repo } = setup(t); create(repo, 'guide');
  const provider = scripted([
    () => call('read', 'skill_view', { name: 'guide' }),
    () => call('patch', 'skill_manage', { action: 'patch', name: 'guide', old_string: 'Unique', new_string: 'Shared' }),
    () => { throw new Error('network offline'); },
  ]);
  const curator = new Curator(repo, provider); const report = await curator.run({ consolidate: true });
  assert.match(report.error!, /network offline/); assert.match(repo.read('guide').content, /Shared/); assert.equal(curator.state().run_count, 1);
  assert.ok(existsSync(report.report_path));
  let release!: () => void;
  const slow = new Curator(repo, { complete: () => new Promise(resolve => { release = () => resolve({ content: 'done' }); }) });
  const first = slow.run({ consolidate: true });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(slow.run(), /already running/); release(); await first;
});

test('pending write approval is replayable but detects stale reads and respects lock changes', async t => {
  const { repo } = setup(t, {}, { write_approval: true }); create(repo, 'guide');
  const tools = curatorTools(repo, false); tools.nextStep();
  await tools.registry.execute({ id: 'read', name: 'skill_view', arguments: { name: 'guide' } }); tools.nextStep();
  const result = await tools.registry.execute({ id: 'stage', name: 'skill_manage', arguments: { action: 'patch', name: 'guide', old_string: 'Unique', new_string: 'Shared' } });
  assert.match(result.content, /pending/); assert.match(repo.read('guide').content, /Unique/);
  const pending = pendingEdits(repo)[0]; repo.protect('guide', 'locked', true);
  assert.throws(() => resolvePending(repo, pending.id, true), /locked/); repo.protect('guide', 'locked', false);
  resolvePending(repo, pending.id, true); assert.match(repo.read('guide').content, /Shared/); assert.equal(pendingEdits(repo).length, 0);
});

test('whole-tree rollback preserves excluded directories, binary modes and unrelated cron state', t => {
  const { repo, curator, home } = setup(t, { backup: { keep: 2 } }); create(repo, 'guide');
  writeJson(join(home, 'cron/jobs.json'), { jobs: [{ id: 'j', skills: ['guide'], prompt: 'before' }, { id: 'gone', skills: ['guide'] }] });
  const snapshot = curator.backups.snapshot()!;
  repo.mutate({ action: 'patch', name: 'guide', old_string: 'Unique', new_string: 'Changed' }); create(repo, 'new'); repo.archive('new');
  mkdirSync(join(repo.root, 'guide/.git'), { recursive: true }); writeFileSync(join(repo.root, 'guide/.git/HEAD'), 'keep');
  writeJson(join(home, 'cron/jobs.json'), { jobs: [{ id: 'j', skills: ['other'], prompt: 'changed independently' }] });
  const safety = curator.backups.rollback(snapshot.id);
  assert.match(repo.read('guide').content, /Unique/); assert.equal(readFileSync(join(repo.root, 'guide/.git/HEAD'), 'utf8'), 'keep');
  assert.equal(repo.archives().length, 1); assert.ok(curator.backups.list().some(item => item.id === safety.id));
  const cron = readJson<{ jobs: Record<string, unknown>[] }>(join(home, 'cron/jobs.json'), { jobs: [] });
  assert.equal(cron.jobs.length, 1); assert.deepEqual(cron.jobs[0].skills, ['guide']); assert.equal(cron.jobs[0].prompt, 'changed independently');
  curator.backups.rollback(safety.id); assert.match(repo.read('guide').content, /Changed/);
});

test('ledger undo is reversible and blob validation precedes any mutation', t => {
  const { repo } = setup(t); create(repo, 'guide');
  repo.mutate({ action: 'patch', name: 'guide', old_string: 'Unique', new_string: 'Shared' });
  const entry = repo.ledger.entries().at(-1)!; const safety = repo.ledger.undo(entry.id);
  assert.match(repo.read('guide').content, /Unique/); repo.ledger.undo(safety); assert.match(repo.read('guide').content, /Shared/);
  rmSync(join(repo.ledger.blobs, entry.before[0].sha256));
  assert.throws(() => repo.ledger.undo(entry.id), /Missing or corrupt/); assert.match(repo.read('guide').content, /Shared/);
});

test('ledger compaction retains latest entry, collects old unreferenced blobs and honors unlimited setting', t => {
  const { repo } = setup(t, {}, { ledger_max_bytes: 500 }); create(repo, 'guide');
  for (let i = 0; i < 6; i++) repo.mutate({ action: 'patch', name: 'guide', content: `---\nname: guide\ndescription: Guide\n---\nRevision ${i}` });
  const latest = repo.ledger.entries().at(-1)!;
  assert.ok(latest); assert.ok(repo.ledger.entries().length <= 2);
  const dead = '0'.repeat(64); writeFileSync(join(repo.ledger.blobs, dead), 'orphan'); utimesSync(join(repo.ledger.blobs, dead), 1, 1);
  repo.ledger.compact(); assert.equal(existsSync(join(repo.ledger.blobs, dead)), false); assert.equal(repo.ledger.entries().at(-1)?.id, latest.id);
});

test('corrupt protection metadata and dangling symlinks fail closed', t => {
  const { repo } = setup(t); create(repo, 'guide');
  writeFileSync(join(repo.root, '.usage.json'), '{bad');
  assert.throws(() => repo.archive('guide')); assert.ok(existsSync(join(repo.root, 'guide/SKILL.md')));
  assert.throws(() => safePath(repo.root, '../outside'));
  symlinkSync(join(repo.home, 'missing'), join(repo.root, 'escape'));
  assert.throws(() => safePath(repo.root, 'escape/new.md'), /Symlink/);
});

test('backup reader rejects traversal/checksum/link entries and disabled backup cannot pretend rollback safety', t => {
  const { repo } = setup(t, { backup: { enabled: false } });
  const backup = new SkillBackups(repo); assert.equal(backup.snapshot(), null); assert.throws(() => backup.rollback(), /Enable/);
  assert.throws(() => unpack(pack([{ path: '../escape', data: Buffer.from('bad'), mode: 0o600 }]), repo.root), /path|escapes/);
  assert.throws(() => unpack(pack([{ path: '.archive/a', data: Buffer.from('bad'), mode: 0o600 }]), repo.root), /Excluded/);
});

test('L5 approvals produce usage and ledger entries; locked skills cannot be proposed or approved', t => {
  const { repo, home } = setup(t); const manager = new EvolutionManager(join(home, 'proposals'), repo.root, repo);
  const proposal = manager.propose('session', 'Reusable procedure'); manager.approve(proposal, 'learned', 'Workflow');
  assert.equal(repo.get('learned').created_by, 'agent'); assert.equal(repo.ledger.entries().at(-1)?.session_id, 'session');
  const snapshot = manager.library().read('learned');
  const update = manager.propose('session', { action: 'update', name: 'learned', content: 'Updated procedure', baseHash: snapshot.hash });
  repo.protect('learned', 'locked', true); assert.throws(() => manager.approve(update), /locked/);
  assert.equal(manager.library().list().length, 0);
});

test('scheduler measures idle time, skips foreground turns and closes a hung provider', async t => {
  const { repo, curator, setTime } = setup(t); curator.due(0); setTime('2026-10-09T00:00:00Z');
  const scheduler = new CuratorScheduler(curator); scheduler.beginTurn(); setTime('2026-10-10T00:00:00Z');
  await scheduler.tick(); assert.equal(curator.state().run_count, 0); scheduler.endTurn();
  setTime('2026-10-10T03:00:00Z'); await scheduler.tick(); assert.equal(curator.state().run_count, 1); await scheduler.close();
});

test('archive ledger fills re-homed supporting files from pre-run snapshot; undo restores a complete package', t => {
  const { repo, curator } = setup(t); create(repo, 'source'); create(repo, 'target');
  repo.mutate({ action: 'write_file', name: 'source', file_path: 'references/depth.md', content: 'Essential detail' });
  curator.backups.snapshot();
  repo.mutate({ action: 'write_file', name: 'target', file_path: 'references/depth.md', content: 'Essential detail' });
  repo.mutate({ action: 'remove_file', name: 'source', file_path: 'references/depth.md' });
  repo.archive('source', 'curator', 'target');
  const archive = repo.ledger.entries().at(-1)!;
  assert.ok(archive.before.some(file => file.path === 'source/references/depth.md'));
  repo.ledger.undo(archive.id);
  assert.equal(repo.read('source', 'references/depth.md').content, 'Essential detail');
  assert.equal(repo.archives().length, 0);
});

test('repeated failed tool calls stop early with a persisted error report', async t => {
  const { repo } = setup(t); create(repo, 'guide'); let calls = 0;
  const curator = new Curator(repo, { complete: async () => call(`bad-${++calls}`, 'skill_view', { name: 'missing' }) });
  const report = await curator.run({ consolidate: true });
  assert.match(report.error!, /failed five times/); assert.equal(calls, 6); assert.ok(existsSync(report.report_path));
});

test('canceling an isolated model that ignores abort saves a report without late writes', async t => {
  const { repo } = setup(t); create(repo, 'guide'); let finish!: (value: ModelResponse) => void;
  const curator = new Curator(repo, { complete: () => new Promise(resolve => { finish = resolve; }) });
  const controller = new AbortController(), run = curator.run({ consolidate: true, signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort(new Error('user shutdown'));
  const report = await run; assert.match(report.error!, /user shutdown/);
  finish(call('late', 'skill_manage', { action: 'delete', name: 'guide', absorbed_into: 'other' }));
  await new Promise(resolve => setImmediate(resolve)); assert.ok(repo.get('guide')); assert.equal(repo.archives().length, 0);
});

test('ledger-disabled undo refuses before changing files; corrupt snapshot refuses before safety replacement', t => {
  const { repo, curator } = setup(t); create(repo, 'guide'); const entry = repo.ledger.entries().at(-1)!;
  repo.options.ledger = false; assert.throws(() => repo.ledger.undo(entry.id), /Enable/); assert.ok(repo.get('guide'));
  const snapshot = curator.backups.snapshot()!;
  writeFileSync(join(repo.root, '.curator_backups', snapshot.id, 'skills.tar.gz'), 'bad');
  assert.throws(() => curator.backups.rollback(snapshot.id), /checksum/); assert.ok(repo.get('guide'));
});

test('whole-tree rollback restores staged current files when cron restoration fails', t => {
  const { repo, curator } = setup(t); create(repo, 'guide'); const snapshot = curator.backups.snapshot()!;
  repo.mutate({ action: 'patch', name: 'guide', old_string: 'Unique', new_string: 'Current' });
  const original = repo.references.restore.bind(repo.references); let fail = true;
  repo.references.restore = value => { if (fail) { fail = false; throw new Error('injected cron write failure'); } original(value); };
  assert.throws(() => curator.backups.rollback(snapshot.id), /injected/);
  assert.match(repo.read('guide').content, /Current/);
  assert.ok(curator.backups.list().some(item => item.reason.startsWith('pre-rollback')));
});

test('pending absorption refuses if the destination changed after staging', async t => {
  const { repo } = setup(t, {}, { write_approval: true }); create(repo, 'source'); create(repo, 'target');
  const tools = curatorTools(repo, false); tools.nextStep();
  for (const name of ['source', 'target']) await tools.registry.execute({ id: name, name: 'skill_view', arguments: { name } });
  tools.nextStep(); const result = await tools.registry.execute({ id: 'delete', name: 'skill_manage', arguments: { action: 'delete', name: 'source', absorbed_into: 'target' } });
  assert.match(result.content, /pending/); repo.mutate({ action: 'patch', name: 'target', old_string: 'Unique', new_string: 'Replaced' });
  assert.throws(() => resolvePending(repo, pendingEdits(repo)[0].id, true), /changed/); assert.ok(repo.get('source'));
});

test('batch clobber guard canonicalizes file paths and rollback permits recreating a removed skill', t => {
  const { repo, curator } = setup(t); create(repo, 'guide');
  assert.throws(() => repo.batch([
    { action: 'write_file', name: 'guide', file_path: 'references/a.md', content: 'one' },
    { action: 'write_file', name: 'guide', file_path: 'references//a.md', content: 'two' },
  ]), /clobber/);
  const snapshot = curator.backups.snapshot()!; create(repo, 'later'); curator.backups.rollback(snapshot.id);
  create(repo, 'later'); assert.ok(repo.get('later'));
});

test('a malformed unterminated ledger tail is preserved without swallowing the next valid entry', t => {
  const { repo } = setup(t); create(repo, 'guide');
  writeFileSync(repo.ledger.path, '{damaged tail', { flag: 'a' });
  repo.mutate({ action: 'patch', name: 'guide', old_string: 'Unique', new_string: 'Shared' });
  assert.equal(repo.ledger.entries().at(-1)?.action, 'patch'); assert.match(readFileSync(repo.ledger.path, 'utf8'), /\{damaged tail\n\{/);
});

test('nested curator overrides preserve file configuration and reject malformed settings', async t => {
  const { loadSettings } = await import('../src/config.js');
  const { home } = setup(t);
  writeJson(join(home, 'config.json'), { curator: { min_idle_hours: 4, backup: { keep: 7 } }, skills: { disabled: ['guide'] }, auxiliary: { curator: { provider: 'demo' } } });
  const settings = loadSettings(home, { curator: { consolidate: true, backup: { enabled: false } }, skills: { ledger: false } });
  assert.equal(settings.curator.min_idle_hours, 4); assert.equal(settings.curator.backup.keep, 7); assert.equal(settings.curator.backup.enabled, false);
  assert.equal(settings.curator.consolidate, true); assert.deepEqual(settings.skills.disabled, ['guide']); assert.equal(settings.skills.ledger, false);
  writeJson(join(home, 'config.json'), { curator: { imaginary: true } }); assert.throws(() => loadSettings(home), /Unknown curator/);
  writeJson(join(home, 'config.json'), { auxiliary: { curator: { provider: 'imaginary' } } }); assert.throws(() => loadSettings(home), /auxiliary.curator.provider/);
});
