import { KeyedMutex, abortable } from '../core/async.js';
import type { GatewayAgent } from '../gateway/router.js';
import type { Session } from '../memory/store.js';
import { GoalManager } from './manager.js';
import { goalCommand, isGoalCommand, isGoalRead } from './commands.js';
import type { GoalDecision, GoalState } from './types.js';

export interface GoalEvent { type: 'goal.answer' | 'goal.decision' | 'goal.error'; sessionKey: string; sessionId: string; text: string; decision?: GoalDecision }
interface Work { controller: AbortController; phase: 'agent' | 'judge'; promise: Promise<void> }
/**
 * 外层循环：一轮 Agent.run 完成并落盘 → gates/judge → 续接普通 Agent.run。
 * 同一个用户回合内的模型/工具小循环仍在 learning.runLoop；Goals 不修改其停止条件。
 * 真实用户输入优先于下一次自动续接，状态读取命令不会中断正在工作的 Agent。
 */
export class GoalRuntime implements GatewayAgent {
  private readonly mutex = new KeyedMutex();
  private readonly work = new Map<string, Work>();
  private readonly queued = new Map<string, ReturnType<typeof setImmediate>>();
  private readonly foreground = new Map<string, number>();
  private readonly sessions = new Map<string, Session>();
  private readonly waiters = new Set<() => void>();
  private readonly shutdown = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private changed(): void { for (const wake of this.waiters) wake(); this.waiters.clear(); }
  constructor(readonly agent: GatewayAgent, readonly manager: GoalManager, readonly options: {
    cwd?: string; notify?: (event: GoalEvent) => void; canRestore?: (session: Session) => boolean;
  } = {}) {}
  private notify(session: Session, type: GoalEvent['type'], text: string, decision?: GoalDecision): void {
    try { this.options.notify?.({ type, sessionKey: session.key, sessionId: session.id, text, ...(decision ? { decision } : {}) }); } catch { /* 输出端错误不能改写目标结果。 */ }
  }
  async run(key: string, scope: string, text: string, signal?: AbortSignal): Promise<string> {
    signal = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
    if (this.closed) throw new Error('Goal runtime is closed'); signal?.throwIfAborted();
    const session = this.manager.store.getOrCreate(key, scope); this.sessions.set(key, session);
    if (isGoalCommand(text)) {
      if (isGoalRead(text)) return (await goalCommand(this.manager, session, text, this.options.cwd ?? process.cwd(), signal)).text;
      const before = this.manager.load(session.id);
      const result = await goalCommand(this.manager, session, text, this.options.cwd ?? process.cwd(), signal);
      const next = this.manager.load(session.id);
      // pause/clear/wait/set/resume 会改变执行阶段；subgoal/gate 只改验收条件。
      if (next?.id !== before?.id || next?.phase !== before?.phase || /^\/goal\s+(?:resume|pause|clear|wait|unwait)(?:\s|$)/u.test(text)) {
        this.work.get(key)?.controller.abort(new Error('Goal command changed the running goal'));
      } else if (this.work.get(key)?.phase === 'judge') this.work.get(key)?.controller.abort(new Error('Goal criteria changed'));
      if (result.kick || next?.status === 'active') this.schedule(session);
      return result.text;
    }
    this.foreground.set(key, (this.foreground.get(key) ?? 0) + 1);
    // 正在判断时可以立即让位；已执行中的主任务先完成当前回合，再优先处理用户输入。
    if (this.work.get(key)?.phase === 'judge') this.work.get(key)?.controller.abort(new Error('User input superseded goal judgment'));
    try {
      return await this.mutex.run(key, async () => {
        const before = this.manager.beginTurn(session.id);
        try {
          const answer = await abortable(this.agent.run(key, scope, text, signal), signal);
          signal?.throwIfAborted();
          if (before?.status === 'active') {
            const recorded = this.manager.recordTurn(session.id, before.id, before.execution_id);
            if (recorded?.phase === 'running' && recorded.execution_id === before.execution_id) throw new Error('Agent returned without a persisted final answer');
          }
          return answer;
        } catch (error) {
          if (!this.closed && this.manager.load(session.id)?.id === before?.id && before?.status === 'active') this.manager.pause(session.id, signal?.aborted ? 'User interrupted the turn' : 'Main agent turn failed; inspect the error before resuming');
          throw error;
        }
      }, signal);
    } finally {
      this.foreground.set(key, Math.max(0, (this.foreground.get(key) ?? 1) - 1)); this.schedule(session); this.changed();
    }
  }
  private schedule(session: Session): void {
    if (this.closed || this.work.has(session.key) || this.queued.has(session.key) || this.foreground.get(session.key)) return;
    const state = this.manager.load(session.id);
    if (state?.status !== 'active' || !['run', 'judge'].includes(state.phase)) return;
    // 让本轮答复和 Gateway 去重缓存先返回，再开始后台判断/下一轮。
    this.queued.set(session.key, setImmediate(() => {
      this.queued.delete(session.key);
      if (this.closed || this.foreground.get(session.key)) { this.changed(); return; }
      const item: Work = { controller: new AbortController(), phase: 'judge', promise: Promise.resolve() };
      this.work.set(session.key, item);
      item.promise = this.mutex.run(session.key, () => this.step(session, item)).catch(error => {
        if (!item.controller.signal.aborted && !this.closed) {
          try { const state = this.manager.load(session.id); if (state?.status === 'active') this.manager.pause(session.id, `Goal runtime failed: ${error instanceof Error ? error.name : 'Error'}`); } catch { /* 保留原始错误 */ }
          this.notify(session, 'goal.error', error instanceof Error ? error.message : String(error));
        }
      }).finally(() => { if (this.work.get(session.key) === item) this.work.delete(session.key); if (!this.closed) this.schedule(session); this.changed(); });
    }));
  }
  private async step(session: Session, work: Work): Promise<void> {
    const signal = work.controller.signal; signal.throwIfAborted();
    let state = this.manager.refreshWaiting(session.id);
    if (state?.status !== 'active' || this.foreground.get(session.key)) return;
    if (state.phase === 'judge') {
      work.phase = 'judge';
      const decision = await this.manager.evaluateAfterTurn(session.id, signal); signal.throwIfAborted();
      this.notify(session, 'goal.decision', decision.reason, decision); return;
    }
    if (state.phase !== 'run') return;
    if (state.turns_used >= state.max_turns) {
      state = this.manager.pause(session.id, `Turn budget exhausted (${state.turns_used}/${state.max_turns})`);
      this.notify(session, 'goal.decision', state.paused_reason!, this.manager.decision(state)); return;
    }
    const prompt = this.manager.nextPrompt(state);
    // 在调用前保存水位。重启能分辨“已经回答但还没判定”和“执行到一半”。
    const execution = this.manager.beginTurn(session.id); work.phase = 'agent';
    const answer = await abortable(this.agent.run(session.key, session.scope, prompt, signal), signal); signal.throwIfAborted();
    const recorded = this.manager.recordTurn(session.id, state.id, execution?.execution_id);
    if (recorded?.phase === 'running' && recorded.execution_id === execution?.execution_id) throw new Error('Agent returned without a persisted final answer');
    this.notify(session, 'goal.answer', answer);
  }
  /** 启动恢复只加载当前入口授权的会话；等待中的目标由五秒轮询唤醒，不请求模型。 */
  start(restore = true): void {
    if (this.timer || this.closed) return;
    for (const session of restore ? this.manager.store.listSessions() : []) {
      if (this.options.canRestore && !this.options.canRestore(session)) continue;
      try {
        const state = this.manager.recover(session.id);
        if (state?.status === 'active') { this.sessions.set(session.key, session); this.schedule(session); }
      } catch (error) { this.notify(session, 'goal.error', String(error)); }
    }
    this.timer = setInterval(() => this.tick(), this.manager.settings.poll_interval_ms); this.timer.unref();
  }
  tick(): void {
    if (this.closed) return;
    for (const session of this.sessions.values()) {
      if (this.work.has(session.key) || this.foreground.get(session.key)) continue;
      try { this.manager.refreshWaiting(session.id); this.schedule(session); }
      catch (error) { this.notify(session, 'goal.error', String(error)); }
    }
  }
  /** 单次 CLI/JSONL EOF 等待可立即执行的工作；WAIT 会落盘并返回，不阻塞数小时。 */
  async idle(signal?: AbortSignal): Promise<void> {
    while (this.queued.size || this.work.size || [...this.foreground.values()].some(Boolean)) {
      signal?.throwIfAborted(); let wake!: () => void;
      try { await abortable(new Promise<void>(resolve => { wake = resolve; this.waiters.add(wake); }), signal); }
      finally { this.waiters.delete(wake); }
    }
  }
  async close(pauseActive = false): Promise<void> {
    this.closed = true; clearInterval(this.timer);
    for (const handle of this.queued.values()) clearImmediate(handle); this.queued.clear();
    for (const session of this.sessions.values()) {
      if (pauseActive && this.manager.load(session.id)?.status === 'active') this.manager.pause(session.id, 'User interrupted the runtime');
    }
    for (const item of this.work.values()) item.controller.abort(new Error('Goal runtime closed'));
    this.shutdown.abort(new Error('Goal runtime closed')); this.changed();
    await Promise.all([...this.work.values()].map(item => item.promise));
    await this.idle();
  }
}
