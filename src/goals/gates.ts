import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import type { GoalGate } from './types.js';
export interface GateResult { passed: boolean; exitCode: number; output: string }
export type GateRunner = (gate: GoalGate, signal?: AbortSignal) => Promise<GateResult>;

/** 只有本地用户显式配置的 gate 才会执行 shell；裁判模型不能添加命令。 */
export const runGate: GateRunner = async (gate, signal) => {
  signal?.throwIfAborted();
  if (!statSync(gate.cwd).isDirectory() || realpathSync(gate.cwd) !== gate.cwd) throw new Error('Gate workspace is missing or has changed');
  return new Promise((resolve, reject) => {
    let output = '', timedOut = false, settled = false;
    const child = spawn(gate.command, { cwd: gate.cwd, shell: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const append = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-3000); };
    child.stdout?.on('data', append); child.stderr?.on('data', append);
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (sig: NodeJS.Signals) => {
      if (!child.pid) return;
      try { if (process.platform !== 'win32') process.kill(-child.pid, sig); else child.kill(sig); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(sig); }
    };
    const stop = () => { kill('SIGTERM'); killTimer ??= setTimeout(() => kill('SIGKILL'), 250); };
    const timeout = setTimeout(() => { timedOut = true; stop(); }, gate.timeout_seconds * 1000);
    const finish = (code: number | null, error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timeout); clearTimeout(killTimer);
      signal?.removeEventListener('abort', stop);
      // shell 退出不代表它启动的子进程退出；取消/超时后清理整组。
      if (timedOut || signal?.aborted) kill('SIGKILL');
      if (signal?.aborted) { reject(signal.reason); return; }
      resolve({ passed: !timedOut && !error && code === 0, exitCode: timedOut || error ? -1 : code ?? -1,
        output: (output + (timedOut ? '\n[gate timed out]' : error ? `\n[gate failed: ${error.message}]` : '')).slice(-3000) });
    };
    child.once('error', error => finish(null, error)); child.once('close', code => finish(code));
    signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop();
  });
};
