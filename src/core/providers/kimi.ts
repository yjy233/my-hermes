/** L0 已实现示例：独立处理 Kimi HTTP 协议，可通过本机模拟服务调试和验收。 */
import { withTimeout } from '../async.js';
import { ProviderError, TimeoutError } from '../errors.js';
import { fromWireMessage, isRecord, toWireMessage, validateModelResponse,
  type Message, type ModelResponse, type Provider, type ToolSchema } from '../models.js';
import { resolveKimiOptions, type KimiProviderOptions, type ResolvedKimiOptions } from './kimi-shared.js';

export class KimiProvider implements Provider {
  protected readonly options: ResolvedKimiOptions;
  constructor(options: KimiProviderOptions) { this.options = resolveKimiOptions(options); }

  async complete(messages: Message[], tools: ToolSchema[], signal?: AbortSignal): Promise<ModelResponse> {
    signal?.throwIfAborted();
    try {
      return await withTimeout(async requestSignal => {
        requestSignal.throwIfAborted();
        const response = await fetch(this.options.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
          method: 'POST', redirect: 'error', signal: requestSignal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.options.apiKey}` },
          body: JSON.stringify({
            model: this.options.model, messages: messages.map(toWireMessage),
            reasoning_effort: 'low', max_completion_tokens: 8192, stream: false,
            ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
          }),
        });
        requestSignal.throwIfAborted();
        if (!response.ok) {
          // 丢弃远端错误正文；清理失败也不能泄露正文或覆盖已知 HTTP 状态。
          try { await response.body?.cancel(); } catch { /* 继续报告原始 HTTP 状态。 */ }
          throw new ProviderError(`Kimi HTTP ${response.status}`);
        }
        const data = await this.readJson(response, requestSignal);
        requestSignal.throwIfAborted();
        return this.parseResponse(data);
      }, this.options.timeoutMs, signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof ProviderError) throw error;
      if (error instanceof TimeoutError) throw new ProviderError('Kimi request timed out (TimeoutError)');
      // 仅保留固定错误类别，避免 JSON 解析错误或网络错误回显凭证、URL 和模型原文。
      const category = error instanceof TypeError ? 'TypeError' :
        error instanceof SyntaxError ? 'SyntaxError' : error instanceof RangeError ? 'RangeError' : 'Error';
      throw new ProviderError(`Invalid/unavailable Kimi response (${category})`);
    }
  }

  private async readJson(response: Response, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (!response.body) throw new ProviderError('Empty Kimi response body');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0, finished = false;
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      while (true) {
        const { value, done } = await reader.read();
        signal.throwIfAborted();
        if (done) { finished = true; break; }
        size += value.byteLength;
        if (size > this.options.maxResponseBytes) throw new ProviderError('Kimi response exceeds byte limit');
        chunks.push(value);
      }
    } finally {
      signal.removeEventListener('abort', cancel);
      if (!finished) {
        try { await reader.cancel(); } catch { /* 不覆盖读取、超限或取消产生的原始错误。 */ }
      }
      reader.releaseLock();
    }
    // 字节上限在解码前生效，非法 UTF-8 和不完整 JSON 均拒绝接受。
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
    return JSON.parse(text) as unknown;
  }

  private parseResponse(data: unknown): ModelResponse {
    if (!isRecord(data) || !Array.isArray(data.choices) || !isRecord(data.choices[0])) {
      throw new ProviderError('Invalid Kimi response envelope');
    }
    const choice = data.choices[0];
    if (choice.finish_reason !== 'stop' && choice.finish_reason !== 'tool_calls') {
      throw new ProviderError('Kimi did not return a completed text or tool response');
    }
    const message = fromWireMessage(choice.message);
    if (message.role !== 'assistant') throw new ProviderError('Unexpected Kimi response role');
    const result: ModelResponse = {
      content: message.content,
      ...(message.toolCalls !== undefined ? { toolCalls: message.toolCalls } : {}),
      ...(message.reasoningContent !== undefined ? { reasoningContent: message.reasoningContent } : {}),
    };
    validateModelResponse(result);
    if ((choice.finish_reason === 'tool_calls') !== Boolean(result.toolCalls?.length)) {
      throw new ProviderError('Kimi finish_reason does not match its tool calls');
    }
    return result;
  }
}
