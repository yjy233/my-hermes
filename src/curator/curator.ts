import { join } from 'node:path';
import { ContextCompressor } from '../core/compression/compressor.js';
import { withTimeout } from '../core/async.js';
import { requestSize, validateModelResponse, type Message, type Provider, type ToolCall } from '../core/models.js';
import { acquireFileLock, identifier, locked, readJson, safePath, writeJson } from './files.js';
import { atomicWrite } from '../memory/files.js';
import { SkillRepository, type SkillRow, type SkillOperation } from './repository.js';
import { SkillBackups } from './backup.js';
import { curatorTools } from './tools.js';
import { CURATOR_DRY_RUN, CURATOR_PROMPT } from './prompt.js';
import { CuratorLoopGuard } from './loop-guard.js';

export interface CuratorState {
  paused: boolean; run_count: number; last_run_at?: string; last_run_duration_seconds?: number;
  last_run_summary?: string; last_run_summary_shown_at?: string; last_report_path?: string;
}
export interface TransitionCounts { checked: number; seeded: number; marked_stale: number; archived: number; reactivated: number }
export interface ReviewOptions { dryRun?: boolean; consolidate?: boolean; signal?: AbortSignal; trigger?: string; maxIterations?: number }
export interface ReviewReport {
  id: string; started_at: string; duration_seconds: number; trigger: string; dry_run: boolean;
  counts: TransitionCounts; before: SkillRow[]; after: SkillRow[];
  consolidations: { from: string; into: string }[]; prunings: string[]; added: string[];
  model: string; summary: string; error?: string; warnings: string[];
  tool_calls: { call: ToolCall; result: unknown }[]; report_path: string;
}
/** Curator 整理整库技能；持续推进用户任务的外层循环在 goals/runtime.ts，两个调度器相互独立。 */
export class Curator {
  readonly backups: SkillBackups;
  constructor(readonly repo: SkillRepository, readonly provider?: Provider, readonly runtime: { contextChars?: number; timeoutMs?: number; model?: string } = {}) {
    this.backups = new SkillBackups(repo);
  }
  state(): CuratorState {
    const value = readJson<CuratorState>(safePath(this.repo.root, '.curator_state'), { paused: false, run_count: 0 });
    if (typeof value.paused !== 'boolean' || !Number.isSafeInteger(value.run_count) || value.run_count < 0) throw new Error('Invalid curator state');
    return value;
  }
  private save(patch: Partial<CuratorState>): void {
    locked(this.repo.root, 'curator-state', () => writeJson(safePath(this.repo.root, '.curator_state'), { ...this.state(), ...patch }));
  }
  pause(paused: boolean): void { this.save({ paused }); }
  takeNotification(): string | null {
    const state = this.state();
    if (!state.last_run_summary || (state.last_run_summary_shown_at && state.last_run_summary_shown_at >= (state.last_run_at ?? ''))) return null;
    this.save({ last_run_summary_shown_at: this.repo.now().toISOString() }); return state.last_run_summary;
  }
  /** 首次接入只开始计时；用户启用功能不会立即清理已有技能。 */
  due(idleSeconds?: number): boolean {
    if (!this.repo.config.enabled) return false;
    const state = this.state(); if (state.paused) return false;
    if (!state.last_run_at) { this.save({ last_run_at: this.repo.now().toISOString() }); return false; }
    if (!Number.isFinite(Date.parse(state.last_run_at))) throw new Error('Invalid curator schedule timestamp');
    return this.repo.now().getTime() - Date.parse(state.last_run_at) >= this.repo.config.interval_hours * 3_600_000
      && (idleSeconds === undefined || idleSeconds >= this.repo.config.min_idle_hours * 3600);
  }
  transitions(dryRun = false, archiveDays = this.repo.config.archive_after_days): TransitionCounts {
    const counts: TransitionCounts = { checked: 0, seeded: 0, marked_stale: 0, archived: 0, reactivated: 0 };
    const now = this.repo.now().getTime(), stale = now - this.repo.config.stale_after_days * 86_400_000, archive = now - archiveDays * 86_400_000;
    for (const row of this.repo.rows().filter(row => row.managed)) {
      counts.checked++;
      if (row.pinned || row.locked || row.cron) continue;
      if (!row.persisted || (row.provenance === 'bundled' && !row.use_count && !row.last_activity_at && !row.first_seen_at)) {
        counts.seeded++;
        if (!dryRun) this.repo.update(row.name, record => { record.first_seen_at = this.repo.now().toISOString(); record.created_at = record.first_seen_at; });
        continue;
      }
      const anchor = Date.parse(row.last_activity_at ?? row.created_at);
      if (!Number.isFinite(anchor)) throw new Error(`Invalid activity clock: ${row.name}`);
      if (anchor <= archive && row.state !== 'archived') {
        counts.archived++; if (!dryRun) this.repo.archive(row.name, 'curator', undefined, true);
      } else if (anchor <= stale && row.state === 'active') {
        counts.marked_stale++; if (!dryRun) this.repo.update(row.name, record => { record.state = 'stale'; });
      } else if (anchor > stale && row.state === 'stale') {
        counts.reactivated++; if (!dryRun) this.repo.update(row.name, record => { record.state = 'active'; });
      }
    }
    return counts;
  }
  async maybeRun(idleSeconds?: number, signal?: AbortSignal): Promise<ReviewReport | null> {
    if (!this.due(idleSeconds)) return null;
    try { return await this.run({ signal, trigger: 'idle' }); }
    catch (error) { if (error instanceof Error && error.message === 'Curator is already running') return null; throw error; }
  }
  async run(options: ReviewOptions = {}): Promise<ReviewReport> {
    const release = acquireFileLock(this.repo.root, 'curator-run');
    if (!release) throw new Error('Curator is already running');
    try { return await this.review(options); } finally { release(); }
  }
  private async review(options: ReviewOptions): Promise<ReviewReport> {
    const start = this.repo.now(), id = identifier(), dryRun = options.dryRun ?? false, consolidate = options.consolidate ?? this.repo.config.consolidate;
    const report: ReviewReport = {
      id, started_at: start.toISOString(), duration_seconds: 0, trigger: options.trigger ?? 'manual', dry_run: dryRun,
      counts: { checked: 0, seeded: 0, marked_stale: 0, archived: 0, reactivated: 0 }, before: this.repo.rows(), after: [],
      consolidations: [], prunings: [], added: [], model: this.runtime.model ?? 'configured', summary: '', warnings: [], tool_calls: [], report_path: join(this.repo.home, 'logs', 'curator', id, 'REPORT.md'),
    };
    try {
      options.signal?.throwIfAborted();
      if (!dryRun) {
        try { if (consolidate) this.backups.snapshot('pre-curator-run'); else this.backups.prune(); }
        catch (error) { report.warnings.push(`Backup: ${String(error)}`); }
        // 在模型开始之前保存时钟，崩溃不能导致不停重跑。
        this.save({ last_run_at: start.toISOString(), run_count: this.state().run_count + 1 });
        report.counts = this.transitions();
      } else report.counts.checked = report.before.filter(row => row.managed).length;
      const candidates = this.repo.rows().filter(row => row.managed && !row.pinned && !row.locked && !row.disabled && row.provenance !== 'bundled');
      if (consolidate && candidates.length) {
        if (!this.provider) throw new Error('A model provider is required for consolidation');
        report.summary = await this.modelReview(report, options, candidates);
      } else report.summary = consolidate ? 'No eligible consolidation candidates.' : 'Consolidation disabled; deterministic lifecycle pass only.';
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
      report.summary ||= 'Review interrupted; inspect successful tool results and ledger for partial changes.';
    } finally {
      report.duration_seconds = (this.repo.now().getTime() - start.getTime()) / 1000;
      try { report.after = this.repo.rows(); } catch (error) { report.warnings.push(`Final inventory: ${String(error)}`); }
      const remaining = new Set(report.after.map(row => row.name));
      const before = new Set(report.before.map(row => row.name));
      report.added = [...remaining].filter(name => !before.has(name));
      const mapping = new Map<string, string>();
      for (const { call, result } of report.tool_calls) {
        const response = result as { ok?: boolean; result?: { status?: string } };
        if (call.name === 'skill_manage' && response.ok && response.result?.status === 'applied') {
          const operations = (call.arguments.operations ?? [call.arguments]) as SkillOperation[];
          for (const op of operations) if (op.action === 'delete' && op.absorbed_into) mapping.set(op.name, op.absorbed_into);
        }
      }
      for (const name of before) if (!remaining.has(name)) {
        let target = mapping.get(name); const visited = new Set([name]);
        while (target && mapping.has(target) && !visited.has(target)) { visited.add(target); target = mapping.get(target); }
        if (target && remaining.has(target)) report.consolidations.push({ from: name, into: target }); else report.prunings.push(name);
      }
      report.warnings.push(...this.repo.ledger.warnings.splice(0));
      writeJson(join(this.repo.home, 'logs', 'curator', id, 'run.json'), report);
      const text = `# Curator ${dryRun ? 'preview' : 'review'}\n\n${report.summary}\n\n`
        + (report.error ? `Error: ${report.error}\n\n` : '')
        + `Lifecycle: ${JSON.stringify(report.counts)}\n\n`
        + `Consolidated: ${report.consolidations.map(item => `${item.from} → ${item.into}`).join(', ') || 'none'}\n\n`
        + `Archived: ${report.prunings.join(', ') || 'none'}\n\nAdded: ${report.added.join(', ') || 'none'}\n\n`
        + report.warnings.map(warning => `- ${warning}`).join('\n') + '\n';
      atomicWrite(report.report_path, text);
      this.save({ last_report_path: report.report_path, last_run_duration_seconds: report.duration_seconds,
        last_run_summary: `${dryRun ? 'Preview: ' : ''}${report.summary}${report.error ? ` Error: ${report.error}` : ''}` });
    }
    return report;
  }
  private async modelReview(report: ReviewReport, options: ReviewOptions, candidates: SkillRow[]): Promise<string> {
    const { registry, nextStep, invalidateReads } = curatorTools(this.repo, report.dry_run), schemas = registry.schemas();
    const maxChars = this.runtime.contextChars ?? 128_000;
    let messages: Message[] = [
      { role: 'system', content: CURATOR_PROMPT + (report.dry_run ? CURATOR_DRY_RUN : '') },
      { role: 'user', content: `Review the library. ${candidates.length} eligible skills. Use skills_list to enumerate them. Write approval: ${this.repo.options.write_approval}.\n` +
        JSON.stringify(candidates.slice(0, 100).map(({ name, last_activity_at, created_at, use_count, cron }) => ({ name, last_activity_at, created_at, use_count, cron }))) },
    ];
    const compressor = new ContextCompressor({ provider: this.provider!, maxChars, settings: { enabled: true },
      focus: 'Preserve curator scope, read-before-write requirements, pending approvals, actual merges and unresolved package dependencies.' });
    const ids = new Set<string>(), maximum = options.maxIterations ?? 9999;
    const guard = new CuratorLoopGuard();
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 9999) throw new Error('Invalid curator iteration limit');
    for (let iteration = 0; iteration < maximum; iteration++) {
      options.signal?.throwIfAborted(); nextStep();
      const compressed = await compressor.compress(messages, schemas, options.signal);
      messages = compressed.messages;
      if (compressed.changed) invalidateReads();
      if (requestSize(messages, schemas) > maxChars) throw new Error('Curator context budget exceeded after compression');
      const response = await withTimeout(signal => this.provider!.complete(structuredClone(messages), schemas, signal), this.runtime.timeoutMs ?? 120_000, options.signal);
      options.signal?.throwIfAborted(); validateModelResponse(response);
      if (!response.toolCalls?.length) return response.content;
      messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls,
        ...(response.reasoningContent !== undefined ? { reasoningContent: response.reasoningContent } : {}) });
      for (const call of response.toolCalls) {
        if (ids.has(call.id)) throw new Error('Repeated curator tool call ID'); ids.add(call.id);
        guard.before(call);
        const result = await registry.execute(call, options.signal); messages.push(result);
        // 报告保留操作与结果，正文只留摘录；完整变更字节在 ledger blobs，避免报告随大技能失控增长。
        const excerpt = (value: unknown): unknown => typeof value === 'string' ? value.length > 400 ? value.slice(0, 400) + '…' : value
          : Array.isArray(value) ? value.map(excerpt) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, excerpt(item)])) : value;
        report.tool_calls.push({ call: { ...call, arguments: excerpt(call.arguments) as Record<string, unknown> }, result: excerpt(JSON.parse(result.content)) });
        const warning = guard.after(call, result.content);
        if (warning) result.content = JSON.stringify({ ...JSON.parse(result.content), curator_warning: warning });
      }
    }
    throw new Error('Curator iteration limit reached');
  }
}

/** CLI 可在启动时立即检查，Gateway 首次 90 秒后检查；之后每小时检查，有前台请求时跳过。 */
export class CuratorScheduler {
  private active = 0;
  private lastActivity: number;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private readonly controller = new AbortController();
  constructor(readonly curator: Curator, readonly notify: (message: string) => void = () => {},
    readonly worker?: (signal: AbortSignal) => Promise<ReviewReport | null>) { this.lastActivity = curator.repo.now().getTime(); }
  beginTurn(): void { this.active++; this.lastActivity = this.curator.repo.now().getTime(); }
  endTurn(): void { this.active = Math.max(0, this.active - 1); this.lastActivity = this.curator.repo.now().getTime(); }
  async tick(startupIdle = false): Promise<void> {
    if (this.active || this.controller.signal.aborted || this.running) return;
    this.running = (async () => {
      try {
        const idle = startupIdle ? Infinity : (this.curator.repo.now().getTime() - this.lastActivity) / 1000;
        const report = this.worker ? this.curator.due(idle) ? await this.worker(this.controller.signal) : null
          : await this.curator.maybeRun(idle, this.controller.signal);
        if (report) this.notify(`Curator: ${report.error ?? report.summary}\n${report.report_path}`);
      } catch (error) { if (!this.controller.signal.aborted) this.notify(`Curator: ${String(error)}`); }
    })();
    try { await this.running; } finally { this.running = undefined; }
  }
  start(startupIdle = false): void {
    if (this.timer) return;
    // 立即 seed 调度时钟，但实际维护仍等待空闲检查。
    try { this.curator.due(0); } catch (error) { this.notify(`Curator: ${String(error)}`); }
    const schedule = (delay: number, initial = false) => {
      this.timer = setTimeout(() => { void this.tick(initial && startupIdle).finally(() => { if (!this.controller.signal.aborted) schedule(3_600_000); }); }, delay);
      this.timer.unref();
    };
    schedule(startupIdle ? 0 : 90_000, true);
  }
  async close(): Promise<void> { clearTimeout(this.timer); this.controller.abort(new Error('Curator runtime closed')); await this.running; }
}
