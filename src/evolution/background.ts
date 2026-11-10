import { abortable } from '../core/async.js';

interface Job { key: string; controller: AbortController; work: (signal: AbortSignal) => Promise<void> }

/** 一个 Agent 同时只复盘一个会话；前台请求优先，新轮次替换同会话旧候选任务。 */
export class BackgroundReviews {
  private readonly pending = new Map<string, Job>();
  private active?: Job;
  private scheduled?: ReturnType<typeof setImmediate>;
  private foreground = 0;
  private closed = false;
  private readonly waiters = new Set<() => void>();

  beginTurn(key: string): void {
    if (this.closed) throw new Error('Agent is closed');
    this.foreground++;
    this.pending.delete(key);
    this.active?.controller.abort(new Error('Foreground turn superseded background review'));
  }
  endTurn(): void { this.foreground--; this.schedule(); }

  enqueue(key: string, work: Job['work']): void {
    if (this.closed) return;
    this.pending.delete(key);
    // 有界队列：繁忙 Gateway 的后台任务不能无限积压，较新的上下文优先。
    if (this.pending.size >= 32) this.pending.delete(this.pending.keys().next().value!);
    this.pending.set(key, { key, work, controller: new AbortController() });
    this.schedule();
  }

  private schedule(): void {
    if (this.closed || this.foreground || this.active || this.scheduled) { this.settle(); return; }
    if (!this.pending.size) { this.settle(); return; }
    // 留出一个事件循环周期，让 run()/Gateway 的答复和缓存先完成。
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined;
      if (this.closed || this.foreground) { this.settle(); return; }
      const job = this.pending.values().next().value;
      if (!job) { this.settle(); return; }
      this.pending.delete(job.key);
      this.active = job;
      void abortable(Promise.resolve().then(() => {
        job.controller.signal.throwIfAborted();
        return job.work(job.controller.signal);
      }), job.controller.signal).catch(() => {
        // 业务错误由 Agent 记录；队列本身必须释放取消/失败的任务。
      }).finally(() => {
        if (this.active === job) this.active = undefined;
        this.schedule();
      });
    });
  }

  private settle(): void {
    if (this.active || this.pending.size || this.scheduled || this.foreground) return;
    for (const done of this.waiters) done();
    this.waiters.clear();
  }

  async idle(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.active && !this.pending.size && !this.scheduled && !this.foreground) return;
    let done!: () => void;
    const pending = new Promise<void>(resolve => { done = resolve; this.waiters.add(done); });
    try { await abortable(pending, signal); }
    finally { this.waiters.delete(done); }
  }

  close(): void {
    this.closed = true;
    this.pending.clear();
    if (this.scheduled) clearImmediate(this.scheduled);
    this.scheduled = undefined;
    this.active?.controller.abort(new Error('Agent closed'));
    this.settle();
  }
}
