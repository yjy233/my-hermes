import { randomUUID } from 'node:crypto';
import { withTimeout } from './async.js';
import { ProviderError } from './errors.js';
import { fromWireMessage, isRecord, toWireMessage, validateModelResponse,
  type Message, type ModelResponse, type Provider, type ToolSchema } from './models.js';

/** 确定性的离线模拟器，用于稳定复现模型响应与工具调用流程。 */
export class DemoProvider implements Provider {
  async complete(messages: Message[], _tools: ToolSchema[], signal?: AbortSignal): Promise<ModelResponse> {
    signal?.throwIfAborted();
    const last = messages.at(-1);
    if (!last) throw new Error('No messages');
    if (last.role === 'tool') {
      const results: string[] = [];
      for (let i = messages.length - 1; i >= 0 && messages[i].role === 'tool'; i--) results.unshift(messages[i].content);
      return { content: `工具结果：${results.join('\n')}` };
    }
    const commands: [string, string, string][] = [
      ['/calc ', 'calculator', 'expression'], ['/recall ', 'history_search', 'query'], ['/skill ', 'skill_read', 'name'],
    ];
    for (const [prefix, name, key] of commands) if (last.content.startsWith(prefix)) {
      return { content: '', toolCalls: [{ id: randomUUID(), name, arguments: { [key]: last.content.slice(prefix.length) } }] };
    }
    if (last.content.startsWith('/remember ')) return { content: '', toolCalls: [{
      id: randomUUID(), name: 'memory_write', arguments: { target: 'MEMORY.md', content: last.content.slice(10) },
    }] };
    if (last.content === '/memory') return { content: '', toolCalls: [{
      id: randomUUID(), name: 'memory_read', arguments: { target: 'MEMORY.md' },
    }] };
    return { content: `[demo] ${last.content}\n离线模式：试试 /calc (2+3)*4、/remember 我喜欢 TypeScript、/memory、/recall TypeScript 或 /skill study-notes。` };
  }
}

export interface CompatibleProviderOptions {
  baseUrl: string; model: string; apiKey?: string; timeoutMs?: number; maxResponseBytes?: number;
}
export class OpenAICompatibleProvider implements Provider {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  constructor(private readonly options: CompatibleProviderOptions) {
    const parsed = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('baseUrl must be an HTTP(S) API root without credentials, query, or fragment');
    }
    if (typeof options.model !== 'string' || !options.model.trim()) throw new Error('Model is required');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 2_000_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 2_147_483_647 ||
        !Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) throw new Error('Invalid provider budget');
    this.url = options.baseUrl.replace(/\/$/, '') + '/chat/completions';
  }
  async complete(messages: Message[], tools: ToolSchema[], signal?: AbortSignal): Promise<ModelResponse> {
    try {
      return await withTimeout(async requestSignal => {
        const response = await fetch(this.url, {
          method: 'POST', signal: requestSignal, redirect: 'error',
          headers: { 'Content-Type': 'application/json', ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}) },
          body: JSON.stringify(this.buildRequestBody(messages, tools)),
        });
        if (!response.ok) { await response.body?.cancel(); throw new ProviderError(`Model HTTP ${response.status}`); }
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (!response.body) throw new ProviderError('Empty model response');
        const reader = response.body.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > this.maxResponseBytes) { await reader.cancel(); throw new ProviderError('Model response exceeds byte limit'); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        return this.parseResponse(data);
      }, this.timeoutMs, signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof ProviderError) throw error;
      // 错误正文或 URL 可能包含提示词和凭证，因此只报告错误类别。
      throw new ProviderError(`Invalid/unavailable model response (${error instanceof Error ? error.name : 'Error'})`);
    }
  }

  protected buildRequestBody(messages: Message[], tools: ToolSchema[]): Record<string, unknown> {
    return { model: this.options.model, messages: messages.map(toWireMessage), max_tokens: 2048,
      ...(tools.length ? { tools, tool_choice: 'auto' } : {}) };
  }

  protected parseResponse(data: unknown): ModelResponse {
    if (!isRecord(data) || !Array.isArray(data.choices) || !isRecord(data.choices[0])) throw new ProviderError('Invalid model envelope');
    const choice = data.choices[0];
    if (choice.finish_reason === 'length' || choice.finish_reason === 'content_filter') throw new ProviderError('Model did not complete its response');
    const message = fromWireMessage(choice.message);
    if (message.role !== 'assistant') throw new ProviderError('Unexpected model role');
    const result: ModelResponse = { content: message.content,
      ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
      ...(message.reasoningContent !== undefined ? { reasoningContent: message.reasoningContent } : {}),
    };
    validateModelResponse(result);
    return result;
  }
}
