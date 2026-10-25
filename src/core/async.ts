import { TimeoutError } from './errors.js';

export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Operation aborted', 'AbortError');
}

/** 取消时及时停止等待；处理器也需要响应 signal，才能停止实际执行和后续副作用。 */
export function abortable<T>(work: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve(work);
  if (signal.aborted) { void Promise.resolve(work).catch(() => {}); return Promise.reject(abortReason(signal)); }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(abortReason(signal)); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(work).then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); },
    );
  });
}

export async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  signal.throwIfAborted();
  const timer = setTimeout(() => controller.abort(new TimeoutError(`Operation timed out after ${timeoutMs}ms`)), timeoutMs);
  try { return await abortable(Promise.resolve().then(() => work(signal)), signal); }
  finally { clearTimeout(timer); }
}

/** 按键串行排队，空闲后释放对应键；调用方可以在等待期间取消任务。 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();
  async run<T>(key: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);
    try {
      await abortable(previous, signal);
      signal?.throwIfAborted();
      return await task();
    } finally {
      release();
      void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    }
  }
}
