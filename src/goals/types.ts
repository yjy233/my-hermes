import { isRecord } from '../core/models.js';
export interface GoalSettings { max_turns: number; judge_timeout_ms: number; poll_interval_ms: number }
export const DEFAULT_GOALS: GoalSettings = { max_turns: 20, judge_timeout_ms: 30_000, poll_interval_ms: 5000 };
export function goalSettings(input: unknown = {}): GoalSettings {
  if (!isRecord(input) || Object.keys(input).some(key => !Object.hasOwn(DEFAULT_GOALS, key))) throw new Error('Invalid goals config');
  const result = { ...DEFAULT_GOALS, ...input };
  for (const [key, value] of Object.entries(result)) if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error(`Invalid goals.${key}`);
  return result;
}
export interface GoalContract { outcome?: string; verification?: string; constraints?: string; boundaries?: string; stop_when?: string }
export interface GoalGate { command: string; cwd: string; timeout_seconds: number; max_retries: number; attempts: number; last_exit_code?: number; last_output_tail?: string }
export interface WaitBarrier { kind: 'time' | 'pid' | 'session'; since: number; until?: number; pid?: number; session_id?: string; delegations?: number; reason: string }
export interface BackgroundProcess { id?: string; pid?: number; description: string }
/** 可由真实进程工具/委派框架注入；没有该框架时不能假装存在一个可等待的任务。 */
export interface GoalEnvironment {
  now(): number;
  pidAlive(pid: number): boolean;
  sessionWaiting(id: string, ownerSessionId: string): boolean | undefined;
  processes(sessionId: string): BackgroundProcess[];
  activeDelegations(sessionId: string): number;
}
export const defaultGoalEnvironment: GoalEnvironment = {
  now: Date.now,
  pidAlive: pid => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } },
  sessionWaiting: () => undefined, processes: () => [], activeDelegations: () => 0,
};
export type Verdict = 'continue' | 'done' | 'blocked' | 'wait';
export interface JudgeResult { verdict: Verdict; reason: string; parseFailed?: boolean; transportFailed?: boolean; wait?: { seconds?: number; pid?: number; session_id?: string } }
export interface GoalState {
  id: string; session_id: string; session_key: string; scope: string; revision: number;
  goal: string; status: 'active' | 'paused' | 'done' | 'cleared';
  turns_used: number; max_turns: number; created_at: number; last_turn_at?: number;
  last_verdict?: Verdict | 'gate_failed'; last_reason?: string; paused_reason?: string;
  consecutive_parse_failures: number; consecutive_transport_failures: number;
  contract: GoalContract; subgoals: string[]; gates: GoalGate[]; waiting?: WaitBarrier;
  // phase 是本项目的恢复游标：一轮结束与裁判完成之间也可能发生进程退出。
  phase: 'run' | 'running' | 'judge' | 'waiting' | 'idle';
  baseline_message_id?: number; last_counted_message_id?: number; pending_response?: string;
}
export interface GoalDecision { status: GoalState['status'] | null; verdict: string; shouldContinue: boolean; reason: string; prompt?: string }
