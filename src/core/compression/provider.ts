import { abortable } from '../async.js';
import { ContextBudgetExceeded, ProviderError } from '../errors.js';
import { requestSize, type Message, type Provider, type ToolSchema } from '../models.js';
import { ContextCompressor } from './compressor.js';

/** 将原始循环的追加消息映射到工作上下文；压缩不改变 runLoop 返回的完整 delta。 */
export class CompressingProvider implements Provider {
  private consumed = 0;
  private working: Message[] = [];
  constructor(private readonly delegate: Provider, private readonly compressor: ContextCompressor, private readonly maxChars: number) {}
  get hasRequests(): boolean { return this.consumed > 0; }

  async complete(messages: Message[], tools: ToolSchema[], signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (messages.length < this.consumed) throw new Error('Model loop must append messages monotonically');
    this.working.push(...structuredClone(messages.slice(this.consumed)));
    this.consumed = messages.length;
    this.working = (await this.compressor.compress(this.working, tools, signal)).messages;
    // Provider 确认的溢出最多再压缩两次；只重试模型请求，不重放已执行的工具。
    for (let recovery = 0; ; recovery++) {
      signal?.throwIfAborted();
      if (requestSize(this.working, tools) > this.maxChars) {
        throw new ContextBudgetExceeded('Protected context or failed compression exceeds the request budget; history was preserved');
      }
      try { return await abortable(this.delegate.complete(this.working, tools, signal), signal); }
      catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof ProviderError) || error.kind !== 'context_length' || recovery >= 2) throw error;
        const result = await this.compressor.compress(this.working, tools, signal, true);
        if (!result.changed) throw error;
        this.working = result.messages;
      }
    }
  }

  completedContext(final: Message): Message[] {
    return structuredClone([...this.working, final]);
  }
}
