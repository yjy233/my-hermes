import { withTimeout } from '../async.js';
import { ProviderError, TimeoutError } from '../errors.js';
import { requestSize, validateModelResponse, type Emit, type Message, type Provider, type ToolSchema } from '../models.js';
import { compressionSettings, initialCompressionState, type CompressionSettings, type CompressionState, type SummaryFailure } from './settings.js';
import { redact } from './text.js';
import type { CompactHistory, CompressionResult, CompressionRuntime } from './types.js';
import { compactHistory as referenceCompactHistory } from '../../learning/reference.js';
export type { CompressionResult } from './types.js';

export interface CompressorOptions {
  provider: Provider;
  summaryProvider?: Provider;
  maxChars: number;
  settings?: Partial<CompressionSettings>;
  state?: CompressionState;
  memory?: string;
  focus?: string;
  emit?: Emit;
  algorithm?: CompactHistory;
  /** 摘要前仅开放记忆工具整理长期事实；不参与主业务工具循环。 */
  beforeSummary?: (messages: Message[], signal: AbortSignal) => Promise<void>;
}
/** 一个实例只处理一个串行回合；跨回合只传递已持久化的状态，迟到响应无法改写下一回合。 */
export class ContextCompressor implements CompressionRuntime {
  readonly settings: CompressionSettings;
  private state: CompressionState;
  private flushed = false;
  constructor(private readonly options: CompressorOptions) {
    this.settings = compressionSettings(options.settings);
    this.state = structuredClone(options.state ?? initialCompressionState());
    if (!Number.isSafeInteger(options.maxChars) || options.maxChars < 1000) throw new Error('Invalid compression context budget');
  }
  snapshot(): CompressionState { return structuredClone(this.state); }

  emit(event: string, payload: Record<string, unknown>): void {
    try { this.options.emit?.(`context.${event}`, payload); } catch { /* 观察者不能改变压缩提交结果。 */ }
  }
  skipped(messages: Message[], reason: string, before: number, backoff = false): CompressionResult {
    if (backoff) this.state.nextAttemptChars = before + Math.max(256, Math.floor(before * 0.1));
    this.emit('compression.skipped', { reason, beforeChars: before });
    return { messages, changed: false };
  }

  get maxChars(): number { return this.options.maxChars; }
  get memory(): string { return this.options.memory ?? ''; }
  get focus(): string | undefined { return this.options.focus; }

  /** 运行时必须传入所选 L2；直接使用此类时默认使用参考 L2。算法异常原样传播。 */
  async compress(messages: Message[], tools: ToolSchema[], signal?: AbortSignal, force = false): Promise<CompressionResult> {
    return (this.options.algorithm ?? referenceCompactHistory)(messages, tools, this, signal, force);
  }

  commit(original: Message[], candidate: Message[], tools: ToolSchema[], method: NonNullable<CompressionResult['method']>): CompressionResult {
    const before = requestSize(original, tools), after = requestSize(candidate, tools);
    if (after > this.options.maxChars || before - after < Math.max(128, before * 0.05)) {
      return this.skipped(original, 'no-meaningful-reduction', before, true);
    }
    this.state.nextAttemptChars = after + Math.max(256, Math.floor((before - after) * 0.5));
    this.emit('compression.end', { method, beforeChars: before, afterChars: after });
    return { messages: candidate, changed: true, method };
  }

  async generate(prompt: Message[], signal?: AbortSignal): Promise<string | null> {
    if (!this.flushed && this.options.beforeSummary) {
      this.flushed = true;
      try {
        await withTimeout(inner => this.options.beforeSummary!(prompt, inner), this.settings.timeoutMs, signal);
      } catch (error) {
        signal?.throwIfAborted();
        this.emit('memory.flush.failure', { category: error instanceof TimeoutError ? 'timeout' : 'other' });
      }
    }
    const primary = this.options.summaryProvider ?? this.options.provider;
    // 辅助模型失败时只向主模型尝试一次；没有辅助模型时不会向相同对象重复请求。
    const routes = primary === this.options.provider ? [primary] : [primary, this.options.provider];
    let failure: SummaryFailure = 'other';
    for (const [attempt, provider] of routes.entries()) {
      signal?.throwIfAborted();
      this.emit('summary.attempt', { attempt: attempt + 1, route: attempt ? 'main-fallback' : 'primary' });
      try {
        const response = await withTimeout(inner => provider.complete(prompt, [], inner), this.settings.timeoutMs, signal);
        signal?.throwIfAborted();
        if (!response.content?.trim()) throw new ProviderError('Empty context summary', 'empty');
        try { validateModelResponse(response); }
        catch { throw new ProviderError('Invalid context summary response', 'invalid'); }
        if (response.toolCalls?.length) throw new ProviderError('Summary requested tools', 'invalid');
        const body = response.content.replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
        if (!body || /^(?:I (?:cannot|can't|am unable)|Sorry[, ]|抱歉|对不起)[\s\S]{0,100}(?:summari|assist|help|总结|摘要|帮助)/i.test(body)) {
          throw new ProviderError('Summary empty or refused', 'empty');
        }
        if (!/^##\s+\S/m.test(body)) throw new ProviderError('Summary is not a structured checkpoint', 'invalid');
        this.state = initialCompressionState();
        return redact(body);
      } catch (error) {
        signal?.throwIfAborted();
        failure = this.classify(error);
        this.emit('summary.failure', { attempt: attempt + 1, category: failure });
      }
    }
    this.state.failures = this.state.lastFailure === failure ? this.state.failures + 1 : 1;
    this.state.lastFailure = failure;
    const ladder = [60_000, 300_000, 900_000];
    const delay = failure === 'timeout' || failure === 'truncated' || failure === 'overload'
      ? ladder[Math.min(this.state.failures - 1, ladder.length - 1)]
      : failure === 'access' ? 900_000 : ['empty', 'invalid', 'network'].includes(failure) ? 30_000 : 60_000;
    this.state.cooldownUntil = Date.now() + delay;
    return null;
  }

  private classify(error: unknown): SummaryFailure {
    if (error instanceof TimeoutError) return 'timeout';
    if (error instanceof ProviderError) return error.kind === 'context_length' ? 'invalid' : error.kind;
    if (error instanceof SyntaxError) return 'invalid';
    if (error instanceof DOMException && error.name === 'AbortError') return 'timeout';
    if (error instanceof TypeError) return 'network';
    return 'other';
  }
  mustPreserveHistory(): boolean {
    const kind = this.state.lastFailure;
    if (kind === 'timeout' || kind === 'overload') return this.state.failures < 3;
    return kind !== 'other';
  }
}
