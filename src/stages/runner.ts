/** 可复用的验收执行器：运行所选学习者代码，不回退到参考实现。 */
import { abortable, withTimeout } from '../core/async.js';
import type { Emit } from '../core/models.js';
import type { Mode } from '../learning/types.js';
import type { StageCase } from './contracts.js';

export interface StageRunOptions {
  emit?: Emit;
  signal?: AbortSignal;
  debug?: boolean;
  /** 设为 0 时关闭异步超时，便于断点暂停调试。 */
  caseTimeoutMs?: number;
}
export interface StageCaseResult {
  name: string;
  status: 'passed' | 'failed';
  error?: { name: string; message: string; stack?: string };
}
export interface StageResult {
  stage: number;
  mode: Mode;
  status: 'passed' | 'failed';
  total: number;
  passed: number;
  failed: number;
  cases: StageCaseResult[];
}

export async function runStageCases(stage: number, mode: Mode, cases: StageCase[],
  options: StageRunOptions = {}): Promise<StageResult> {
  const timeoutMs = options.caseTimeoutMs ?? (options.debug ? 0 : 3000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
    throw new Error('caseTimeoutMs must be a nonnegative timer-range integer');
  }
  if (!cases.length || new Set(cases.map(item => item.name)).size !== cases.length) {
    throw new Error('Acceptance requires nonempty cases with unique names');
  }
  const results: StageCaseResult[] = [];
  for (const item of cases) {
    options.signal?.throwIfAborted();
    const emit: Emit = (event, payload) => {
      try { options.emit?.(event, { stage, mode, caseName: item.name, ...payload }); }
      catch { /* 观察器不能改变验收结果。 */ }
    };
    emit('case.start', {});
    try {
      if (timeoutMs) await withTimeout(async signal => item.run(signal), timeoutMs, options.signal);
      else await abortable(Promise.resolve().then(() => item.run(options.signal)), options.signal);
      options.signal?.throwIfAborted();
      results.push({ name: item.name, status: 'passed' });
      emit('case.passed', {});
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      const failure = {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
        ...(options.debug && error instanceof Error && error.stack ? { stack: error.stack } : {}),
      };
      results.push({ name: item.name, status: 'failed', error: failure });
      emit('case.failed', { error: failure.name, message: failure.message });
    }
  }
  const failed = results.filter(item => item.status === 'failed').length;
  return { stage, mode, status: failed ? 'failed' : 'passed', total: results.length,
    passed: results.length - failed, failed, cases: results };
}
