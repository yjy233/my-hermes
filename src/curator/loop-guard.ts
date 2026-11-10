import { digest } from './files.js';
import type { ToolCall } from '../core/models.js';
/** Curator 是无人值守循环：给模型纠错机会，同时阻止相同失败/相同结果耗尽 9999 次预算。 */
export class CuratorLoopGuard {
  private failures = new Map<string, number>();
  private tools = new Map<string, number>();
  private unchanged = new Map<string, { hash: string; count: number }>();
  private signature(call: ToolCall): string {
    const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
      : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
    return call.name + ':' + JSON.stringify(stable(call.arguments));
  }
  before(call: ToolCall): void {
    const key = this.signature(call);
    if ((this.failures.get(key) ?? 0) >= 5) throw new Error(`Curator stopped: ${call.name} failed five times with unchanged arguments`);
    if ((this.unchanged.get(key)?.count ?? 0) >= 5) throw new Error(`Curator stopped: ${call.name} returned the same result five times`);
  }
  after(call: ToolCall, content: string): string | undefined {
    const key = this.signature(call), result = JSON.parse(content) as { ok: boolean; result?: { status?: string } };
    if (!result.ok) {
      const exact = (this.failures.get(key) ?? 0) + 1, same = (this.tools.get(call.name) ?? 0) + 1;
      this.failures.set(key, exact); this.tools.set(call.name, same); this.unchanged.delete(key);
      if (same >= 8) throw new Error(`Curator stopped: ${call.name} failed eight times without progress`);
      if (exact >= 2 || same >= 3) return 'Repeated tool failure: inspect the error and obtain fresh evidence before trying a different, justified action.';
    } else {
      this.failures.delete(key); this.tools.delete(call.name);
      if (call.name === 'skill_manage' && result.result?.status === 'applied') {
        this.failures.clear(); this.tools.clear(); this.unchanged.clear(); return;
      }
      if (call.name === 'skill_view' || call.name === 'skills_list') {
        const hash = digest(content), old = this.unchanged.get(key), count = old?.hash === hash ? old.count + 1 : 1;
        this.unchanged.set(key, { hash, count });
        if (count >= 2) return 'This read repeated unchanged information. Use the observed result to advance the review.';
      }
    }
  }
}
