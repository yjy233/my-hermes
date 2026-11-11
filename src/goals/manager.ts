import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { Session, SessionStore } from '../memory/store.js';
import { isRecord, validateModelResponse, type Provider } from '../core/models.js';
import { abortable, withTimeout } from '../core/async.js';
import { continuationPrompt, judgeMessages, parseContract, parseDraft, parseJudge, validateContract, GOAL_DRAFT_TASK, GOAL_CONTINUATION } from './prompts.js';
import { runGate, type GateRunner } from './gates.js';
import { defaultGoalEnvironment, goalSettings, type GoalContract, type GoalDecision, type GoalEnvironment, type GoalSettings, type GoalState, type JudgeResult, type WaitBarrier } from './types.js';

/** SQLite 保存 JSON；revision + CAS 使迟到裁判无法覆盖用户刚刚暂停/替换的目标。 */
export class GoalManager {
  readonly environment: GoalEnvironment;
  readonly settings: GoalSettings;
  constructor(readonly store: SessionStore, readonly provider: Provider, readonly options: {
    settings?: Partial<GoalSettings>; environment?: Partial<GoalEnvironment>; gateRunner?: GateRunner; allowGates?: boolean;
  } = {}) {
    this.settings = goalSettings(options.settings);
    this.environment = { ...defaultGoalEnvironment, ...options.environment };
  }
  load(sessionId: string): GoalState | null {
    const raw = this.store.getMeta(`goal:${sessionId}`); if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.session_id !== sessionId || typeof value.id !== 'string' || typeof value.session_key !== 'string' || typeof value.scope !== 'string'
      || typeof value.goal !== 'string' || !value.goal.trim() || value.goal.length > 4000
      || !['active', 'paused', 'done', 'cleared'].includes(String(value.status)) || !['run', 'running', 'judge', 'waiting', 'idle'].includes(String(value.phase))
      || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1
      || !Number.isSafeInteger(value.turns_used) || (value.turns_used as number) < 0
      || !Number.isSafeInteger(value.max_turns) || (value.max_turns as number) < 1
      || !Array.isArray(value.subgoals) || value.subgoals.some(s => typeof s !== 'string') || !Array.isArray(value.gates)) throw new Error('Invalid persisted goal state');
    validateContract(value.contract);
    for (const count of [value.consecutive_parse_failures, value.consecutive_transport_failures]) if (!Number.isSafeInteger(count) || (count as number) < 0) throw new Error('Invalid judge failure counter');
    for (const gate of value.gates) {
      if (!isRecord(gate) || typeof gate.command !== 'string' || !gate.command.trim() || gate.command.length > 4000 || typeof gate.cwd !== 'string'
        || !Number.isSafeInteger(gate.timeout_seconds) || (gate.timeout_seconds as number) < 1 || (gate.timeout_seconds as number) > 3600
        || !Number.isSafeInteger(gate.max_retries) || (gate.max_retries as number) < 0 || !Number.isSafeInteger(gate.attempts) || (gate.attempts as number) < 0) throw new Error('Invalid persisted gate');
    }
    if (value.waiting !== undefined) {
      const wait = value.waiting;
      if (!isRecord(wait) || !['time', 'pid', 'session'].includes(String(wait.kind)) || !Number.isFinite(wait.since)
        || typeof wait.reason !== 'string'
        || (wait.kind === 'time' && (!Number.isFinite(wait.until) || (wait.until as number) < (wait.since as number)))
        || (wait.kind === 'pid' && (!Number.isSafeInteger(wait.pid) || (wait.pid as number) < 1))
        || (wait.kind === 'session' && (typeof wait.session_id !== 'string' || !wait.session_id))
        || (wait.delegations !== undefined && (!Number.isSafeInteger(wait.delegations) || (wait.delegations as number) < 0))) throw new Error('Invalid wait barrier');
    }
    for (const watermark of [value.baseline_message_id, value.last_counted_message_id]) {
      if (watermark !== undefined && (!Number.isSafeInteger(watermark) || (watermark as number) < 0)) throw new Error('Invalid goal message watermark');
    }
    return value as unknown as GoalState;
  }
  private save(state: GoalState, expected: GoalState | null): GoalState {
    if (continuationPrompt(state).length > 16_000) throw new Error('Goal and completion criteria exceed the input budget');
    const next = { ...state, revision: (expected?.revision ?? 0) + 1 };
    if (!this.store.compareAndSetMeta(`goal:${state.session_id}`, expected ? JSON.stringify(expected) : null, JSON.stringify(next))) throw new Error('Goal changed while this operation was running');
    return next;
  }
  change(sessionId: string, work: (state: GoalState) => void): GoalState {
    const before = this.load(sessionId); if (!before) throw new Error('No goal in this session');
    const next = structuredClone(before); work(next); return this.save(next, before);
  }
  set(session: Session, text: string, maxTurns = this.settings.max_turns, contract?: GoalContract): GoalState {
    const parsed = parseContract(text);
    if (!parsed.goal.trim() || parsed.goal.length > 4000 || !Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new Error('Goal needs 1..4000 characters and a positive turn budget');
    const before = this.load(session.id);
    return this.save({ id: randomUUID(), session_id: session.id, session_key: session.key, scope: session.scope, revision: 0,
      goal: parsed.goal, status: 'active', turns_used: 0, max_turns: maxTurns, created_at: this.environment.now(),
      consecutive_parse_failures: 0, consecutive_transport_failures: 0, contract: validateContract(contract ?? parsed.contract), subgoals: [], gates: [], phase: 'run' }, before);
  }
  pause(id: string, reason = 'user-paused'): GoalState {
    return this.change(id, state => { state.status = 'paused'; state.phase = 'idle'; state.paused_reason = reason; delete state.waiting; });
  }
  resume(id: string): GoalState {
    return this.change(id, state => { state.status = 'active'; state.phase = 'run'; state.turns_used = 0; state.consecutive_parse_failures = 0; state.consecutive_transport_failures = 0;
      delete state.waiting; delete state.paused_reason; delete state.pending_response; delete state.execution_id; });
  }
  clear(id: string): GoalState { return this.change(id, state => { state.status = 'cleared'; state.phase = 'idle'; delete state.waiting; }); }
  subgoal(id: string, action: 'add' | 'remove' | 'clear', value = ''): GoalState {
    return this.change(id, state => {
      if (action === 'clear') state.subgoals = [];
      else if (action === 'remove') { const index = Number(value) - 1; if (!Number.isInteger(index) || index < 0 || index >= state.subgoals.length) throw new Error('Invalid subgoal number'); state.subgoals.splice(index, 1); }
      else { if (!value.trim() || value.length > 1000 || state.subgoals.length >= 20) throw new Error('Subgoal limit exceeded'); state.subgoals.push(value.trim()); }
    });
  }
  addGate(id: string, command: string, cwd: string, timeoutSeconds = 300, maxRetries = 3): GoalState {
    if (!this.options.allowGates) throw new Error('Configure shell quality gates from the local CLI');
    if (!command.trim() || command.length > 4000 || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600
      || !Number.isSafeInteger(maxRetries) || maxRetries < 0) throw new Error('Invalid quality gate');
    const directory = realpathSync(cwd);
    return this.change(id, state => { if (state.gates.length >= 20) throw new Error('Too many quality gates'); state.gates.push({ command, cwd: directory, timeout_seconds: timeoutSeconds, max_retries: maxRetries, attempts: 0 }); });
  }
  removeGate(id: string, number?: number): GoalState {
    return this.change(id, state => { if (number === undefined) state.gates = []; else {
      if (!Number.isInteger(number) || number < 1 || number > state.gates.length) throw new Error('Invalid gate number'); state.gates.splice(number - 1, 1);
    } });
  }
  private barrier(state: GoalState, target: JudgeResult['wait'], reason: string): WaitBarrier | null {
    if (target?.session_id) {
      if (this.environment.sessionWaiting(target.session_id, state.session_id) !== true) return null;
      return { kind: 'session', since: this.environment.now(), session_id: target.session_id, reason };
    }
    if (target?.pid && Number.isSafeInteger(target.pid) && target.pid > 0 && this.environment.pidAlive(target.pid)) return { kind: 'pid', since: this.environment.now(), pid: target.pid, reason };
    if (target?.seconds && Number.isSafeInteger(target.seconds) && target.seconds > 0 && target.seconds <= 2_147_483_647) return { kind: 'time', since: this.environment.now(), until: this.environment.now() + target.seconds * 1000,
      delegations: this.environment.activeDelegations(state.session_id), reason };
    return null;
  }
  wait(id: string, target: NonNullable<JudgeResult['wait']>, reason = 'user-requested wait'): GoalState {
    return this.change(id, state => { if (state.status !== 'active') throw new Error('An active goal is required');
      const barrier = this.barrier(state, target, reason); if (!barrier) throw new Error('Wait target is not observable or already finished'); state.waiting = barrier; state.phase = 'waiting'; });
  }
  unwait(id: string): GoalState { return this.change(id, state => { delete state.waiting; if (state.status === 'active') state.phase = 'run'; }); }
  private stillWaiting(state: GoalState): boolean {
    const wait = state.waiting; if (!wait) return false;
    const now = this.environment.now();
    if (wait.kind === 'time') return now < (wait.until ?? 0) && (!wait.delegations || this.environment.activeDelegations(state.session_id) >= wait.delegations);
    // 进程/session 等待最多 30 分钟；时间等待有自己的明确截止时间。
    if (now - wait.since >= 30 * 60_000) return false;
    return wait.kind === 'pid' ? this.environment.pidAlive(wait.pid!) : this.environment.sessionWaiting(wait.session_id!, state.session_id) === true;
  }
  refreshWaiting(id: string): GoalState | null {
    const state = this.load(id); if (state?.status === 'active' && state.waiting && !this.stillWaiting(state)) return this.unwait(id); return state;
  }
  beginTurn(id: string): GoalState | null {
    const state = this.load(id); if (!state || state.status !== 'active') return state;
    // baseline 排除旧回答；execution_id 区分同一目标暂停/恢复前后的不同执行。
    return this.change(id, next => { next.phase = 'running'; next.execution_id = randomUUID(); next.baseline_message_id = this.store.latestMessage(id)?.id ?? 0; });
  }
  /** 只在完整回答已持久化后计一次；自动续接和真实用户回合都消耗 turns_used。 */
  recordTurn(id: string, goalId: string, executionId?: string): GoalState | null {
    const state = this.load(id), last = this.store.latestMessage(id);
    if (!state || state.status !== 'active' || state.phase !== 'running' || state.id !== goalId || (executionId !== undefined && state.execution_id !== executionId)
      || !last || last.message.role !== 'assistant' || last.message.toolCalls?.length || !last.message.content.trim()) return state;
    if (last.id <= Math.max(state.last_counted_message_id ?? 0, state.baseline_message_id ?? 0)) return state;
    return this.change(id, next => {
      if (this.stillWaiting(next)) { next.phase = 'waiting'; return; }
      delete next.waiting;
      next.last_counted_message_id = last.id; next.turns_used++; next.last_turn_at = this.environment.now();
      next.pending_response = last.message.content.slice(0, 4000); next.phase = 'judge';
    });
  }
  /** 重启后先核对消息水位：已保存的回合继续判定，未提交的半轮暂停，避免重复执行工具。 */
  recover(id: string): GoalState | null {
    const state = this.load(id); if (state?.status !== 'active' || state.phase !== 'running') return state;
    const last = this.store.latestMessage(id);
    if (last && last.id > (state.baseline_message_id ?? 0) && last.message.role === 'assistant' && !last.message.toolCalls?.length) return this.recordTurn(id, state.id);
    return this.pause(id, 'Previous turn was interrupted before it was committed; inspect side effects and resume explicitly');
  }
  decision(state: GoalState | null, reason = (state?.status === 'paused' ? state.paused_reason : state?.last_reason) ?? ''): GoalDecision {
    return { status: state?.status ?? null, verdict: state?.last_verdict ?? 'inactive', shouldContinue: state?.status === 'active' && state.phase === 'run', reason,
      ...(state?.status === 'active' && state.phase === 'run' ? { prompt: continuationPrompt(state) } : {}) };
  }
  private finish(before: GoalState, next: GoalState): GoalDecision {
    // 命令在 await 期间可能修改状态；这里只丢弃过期结论，不把它当成新的失败回合。
    if (this.load(before.session_id)?.revision !== before.revision) return { ...this.decision(this.load(before.session_id)), shouldContinue: false, verdict: 'superseded' };
    return this.decision(this.save(next, before));
  }
  async evaluateAfterTurn(id: string, signal?: AbortSignal): Promise<GoalDecision> {
    const before = this.load(id);
    if (!before || before.status !== 'active' || before.phase !== 'judge') return this.decision(before);
    const next = structuredClone(before);
    const pause = (reason: string) => { next.status = 'paused'; next.phase = 'idle'; next.paused_reason = reason; next.last_reason = reason; };
    for (const gate of next.gates) {
      if (!this.options.allowGates) { pause('Quality gates require the local CLI runtime'); return this.finish(before, next); }
      let result;
      try { result = await abortable((this.options.gateRunner ?? runGate)(gate, signal), signal); }
      catch (error) { signal?.throwIfAborted(); pause(`Gate workspace or execution unavailable: ${error instanceof Error ? error.message : 'unknown error'}`); return this.finish(before, next); }
      signal?.throwIfAborted(); gate.last_exit_code = result.exitCode; gate.last_output_tail = result.output.slice(-3000);
      if (result.passed) { gate.attempts = 0; continue; }
      gate.attempts++; next.last_verdict = 'gate_failed'; next.last_reason = `Quality gate failed: ${gate.command}`;
      if (gate.attempts > gate.max_retries) pause(`Quality gate exhausted ${gate.max_retries} retries: ${gate.command}`);
      else if (next.turns_used >= next.max_turns) pause('Turn budget exhausted while quality gate is failing');
      else { next.phase = 'run'; next.pending_response = undefined; }
      const decision = this.finish(before, next);
      if (decision.shouldContinue) decision.prompt = this.nextPrompt(next);
      return decision;
    }
    // Gate 是确定性验收；全部通过才调用裁判。裁判没有工具，只返回四种结论。
    let judgment: JudgeResult;
    try {
      const response = await withTimeout(inner => this.provider.complete(judgeMessages(next, this.environment), [], inner), this.settings.judge_timeout_ms, signal);
      signal?.throwIfAborted();
      judgment = response.toolCalls?.length ? { verdict: 'continue', reason: 'Judge requested tools instead of returning JSON', parseFailed: true } : parseJudge(response.content);
    } catch (error) {
      signal?.throwIfAborted(); judgment = { verdict: 'continue', reason: `Judge request failed (${error instanceof Error ? error.name : 'Error'})`, transportFailed: true };
    }
    next.last_verdict = judgment.verdict; next.last_reason = judgment.reason;
    // 单次裁判故障不能误判任务完成；先继续工作，连续失败才暂停让用户检查。
    next.consecutive_parse_failures = judgment.parseFailed ? next.consecutive_parse_failures + 1 : 0;
    next.consecutive_transport_failures = judgment.transportFailed ? next.consecutive_transport_failures + 1 : 0;
    if (judgment.verdict === 'wait') {
      const barrier = this.barrier(next, judgment.wait, judgment.reason);
      if (barrier) { next.waiting = barrier; next.phase = 'waiting'; return this.finish(before, next); }
      next.last_verdict = 'continue'; next.last_reason += ' (wait target unavailable; continuing)';
    }
    if (judgment.verdict === 'done') { next.status = 'done'; next.phase = 'idle'; }
    else if (judgment.verdict === 'blocked') pause(judgment.reason);
    else if (next.consecutive_parse_failures >= 3) pause('Judge returned unusable JSON for 3 consecutive turns; check auxiliary.goal_judge');
    else if (next.consecutive_transport_failures >= 5) pause('Judge requests failed for 5 consecutive turns; check auxiliary.goal_judge provider and credentials');
    else if (next.turns_used >= next.max_turns) pause(`Turn budget exhausted (${next.turns_used}/${next.max_turns})`);
    else next.phase = 'run';
    return this.finish(before, next);
  }
  nextPrompt(state: GoalState): string {
    const gate = state.last_verdict === 'gate_failed' ? state.gates.find(gate => gate.last_exit_code !== undefined && gate.last_exit_code !== 0) : undefined;
    // 失败续接优先容纳完整命令和有界错误尾部；不用长 contract 把修复证据挤出上下文。
    return gate ? `${GOAL_CONTINUATION}\nGoal: ${state.goal}\nQuality gate failed (${gate.attempts}/${gate.max_retries} retries): ${gate.command}\nExit: ${gate.last_exit_code}\nOutput tail:\n${gate.last_output_tail ?? ''}\nFix the underlying failure; preserve the existing scope and do not claim completion while this gate fails.` : continuationPrompt(state);
  }
  async draft(objective: string, signal?: AbortSignal): Promise<GoalContract> {
    const response = await withTimeout(inner => this.provider.complete([
      { role: 'system', content: `${GOAL_DRAFT_TASK}\nTranslate the objective into a practical completion contract. Return only JSON fields outcome, verification, constraints, boundaries, stop_when. Do not invent authorization or external facts. Each field must be at most 2000 characters. This is a draft, not proof of completion.` },
      { role: 'user', content: objective.slice(0, 4000) },
    ], [], inner), this.settings.judge_timeout_ms, signal);
    signal?.throwIfAborted(); validateModelResponse(response); if (response.toolCalls?.length) throw new Error('Contract draft cannot call tools');
    return parseDraft(response.content);
  }
}
