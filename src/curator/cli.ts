import { openSync, closeSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Settings } from '../config.js';
import { createProvider } from '../core/provider-factory.js';
import { Curator, type ReviewReport } from './curator.js';
import { SkillRepository } from './repository.js';
import { pendingEdits, resolvePending } from './tools.js';
import { builtinSkills } from '../lab.js';
import { KIMI_DEFAULT_BASE_URL, KIMI_DEFAULT_MODEL } from '../core/providers/kimi-shared.js';
import { readJson, safePath } from './files.js';
const cliEntrypoint = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../cli.ts' : '../cli.js', import.meta.url));
const workerNodeArgs = () => process.execArgv.filter(arg => !arg.startsWith('--inspect') && !arg.startsWith('--test'));
export interface CuratorFlags { 'dry-run'?: boolean; consolidate?: boolean; background?: boolean; yes?: boolean; days?: string; compact?: boolean;
  sort?: string; provenance?: string; 'all-unmanaged'?: boolean; rollback?: string; limit?: string; }
export function createCurator(settings: Settings): Curator {
  const repo = new SkillRepository(settings.home, settings.curator, settings.skills); repo.syncBuiltins(builtinSkills());
  const route = settings.auxiliary.curator ?? {};
  const preset = route.provider && route.provider !== settings.provider
    ? route.provider === 'kimi' ? { model: KIMI_DEFAULT_MODEL, baseUrl: KIMI_DEFAULT_BASE_URL }
      : { model: 'local-model', baseUrl: 'http://127.0.0.1:11434/v1' } : {};
  const selected = { ...settings, ...preset, ...route };
  // Provider 创建延迟到第一次请求；status/prune 等离线操作不需要 API key。
  return new Curator(repo, { complete: (...args) => createProvider(selected).complete(...args) },
    { model: `${selected.provider}/${selected.model}`, contextChars: Math.max(settings.contextChars, 128_000), timeoutMs: settings.providerTimeoutMs });
}
export async function curatorCommand(curator: Curator, action = 'status', id?: string, flags: CuratorFlags = {}, signal?: AbortSignal): Promise<unknown> {
  const { repo } = curator;
  const required = () => { if (!id) throw new Error('Skill, snapshot or ledger ID required'); return id; };
  const days = (fallback: number) => { const value = flags.days === undefined ? fallback : Number(flags.days); if (!Number.isFinite(value) || value < 0) throw new Error('Invalid --days'); return value; };
  switch (action) {
    case 'status': return { ...curator.state(), config: repo.config, skills: repo.rows(), archived: repo.archives(), backups: curator.backups.list(), pending: pendingEdits(repo) };
    case 'usage': {
      const sort = flags.sort ?? 'activity';
      if (!['activity', 'recent', 'name'].includes(sort)) throw new Error('Usage sort must be activity, recent or name');
      return repo.rows().filter(row => !flags.provenance || row.provenance === (flags.provenance === 'hub' ? 'installed' : flags.provenance)).sort((a, b) =>
        sort === 'name' ? a.name.localeCompare(b.name) : sort === 'recent' ? (b.last_activity_at ?? '').localeCompare(a.last_activity_at ?? '')
          : (b.use_count + b.view_count + b.patch_count) - (a.use_count + a.view_count + a.patch_count));
    }
    case 'run': {
      if (flags.background) throw new Error('Background execution is available from the standalone curator CLI');
      const report = await curator.run({ dryRun: flags['dry-run'], consolidate: flags.consolidate, signal });
      if (report.error) throw new Error(`${report.error}; report: ${report.report_path}`);
      return report;
    }
    case 'pause': curator.pause(true); return curator.state();
    case 'resume': curator.pause(false); return curator.state();
    case 'pin': case 'unpin': repo.protect(required(), 'pinned', action === 'pin'); return repo.get(required());
    case 'lock': case 'unlock': repo.protect(required(), 'locked', action === 'lock'); return repo.get(required());
    case 'adopt': {
      const names = flags['all-unmanaged'] ? repo.rows().filter(row => !row.managed && !['bundled', 'installed', 'external'].includes(row.provenance)).map(row => row.name) : [required()];
      if (flags['dry-run']) return names;
      if (flags['all-unmanaged'] && !flags.yes) throw new Error('Use --dry-run to preview bulk adoption or --yes to adopt');
      for (const name of names) repo.adopt(name); return names;
    }
    case 'unmanaged': case 'list-unmanaged': return repo.rows().filter(row => !row.managed && !['bundled', 'installed', 'external'].includes(row.provenance));
    case 'archive': return repo.archive(required());
    case 'restore': return repo.restore(required());
    case 'archived': case 'list-archived': return repo.archives();
    case 'prune': {
      if (!flags.yes && !flags['dry-run']) throw new Error('Use prune --dry-run to preview or --yes to archive');
      const cutoff = repo.now().getTime() - days(repo.config.archive_after_days) * 86_400_000;
      const names = repo.rows().filter(row => row.managed && !row.pinned && !row.locked && !row.cron
        && Date.parse(row.last_activity_at ?? row.created_at) <= cutoff).map(row => row.name);
      if (!flags['dry-run']) for (const name of names) repo.archive(name, 'user', undefined, true);
      return { dry_run: flags['dry-run'] ?? false, skills: names };
    }
    case 'purge': {
      if (!flags.yes && !flags['dry-run']) throw new Error('Use purge --dry-run to preview or --yes to remove expired archives');
      return repo.purge(days(repo.config.archive_ttl_days), flags['dry-run']);
    }
    case 'backup': return curator.backups.snapshot();
    case 'backups': return curator.backups.list();
    case 'rollback': return curator.backups.rollback(id === 'latest' ? undefined : id);
    case 'ledger': {
      if (flags.rollback) return repo.ledger.undo(flags.rollback);
      if (flags.compact) repo.ledger.compact();
      const limit = Number(flags.limit ?? 50); if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid ledger limit');
      return repo.ledger.entries().slice(-limit);
    }
    case 'undo': return repo.ledger.undo(required());
    case 'pending': return pendingEdits(repo);
    case 'approve': return resolvePending(repo, required(), true);
    case 'reject': return resolvePending(repo, required(), false);
    default: throw new Error(`Unknown curator command: ${action}`);
  }
}
export async function startBackground(settings: Settings, args: string[]): Promise<{ pid: number; log: string }> {
  const log = join(settings.home, 'curator-worker.log'), descriptor = openSync(log, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [...workerNodeArgs(), cliEntrypoint, ...args.filter(arg => arg !== '--background')],
      { detached: true, stdio: ['ignore', descriptor, descriptor], env: process.env });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref(); if (!child.pid) throw new Error('Could not start curator worker'); return { pid: child.pid, log };
  } finally { closeSync(descriptor); }
}

/** 自动维护也在独立进程执行，整库备份/扫描的同步 IO 不占住聊天进程的事件循环。 */
export async function runCuratorWorker(settings: Settings, curator: Curator, signal: AbortSignal): Promise<ReviewReport> {
  signal.throwIfAborted();
  const previous = curator.state().last_report_path;
  const child = spawn(process.execPath, [...workerNodeArgs(), cliEntrypoint, 'curator', 'run', '--home', settings.home,
    '--provider', settings.provider, '--model', settings.model, '--base-url', settings.baseUrl, '--provider-mode', settings.providerMode],
  { stdio: ['ignore', 'ignore', 'pipe'], env: process.env });
  let stderr = '', killTimer: ReturnType<typeof setTimeout> | undefined;
  child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
  const stop = () => { child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 5000); killTimer.unref(); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    if (signal.aborted) stop();
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    signal.throwIfAborted();
    const path = curator.state().last_report_path;
    if (!path || path === previous) throw new Error(`Curator worker exited ${code}: ${stderr.trim()}`);
    const report = safePath(settings.home, relative(settings.home, join(dirname(path), 'run.json')));
    return readJson<ReviewReport>(report, {} as ReviewReport);
  } finally { signal.removeEventListener('abort', stop); clearTimeout(killTimer); }
}
