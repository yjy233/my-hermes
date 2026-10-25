/** 用于对照完整协议流程的可选参考答案；learner 模式不会自动回退到这里。 */
import { isRecord, type Message, type ModelResponse, type ToolSchema } from '../models.js';
import { ProviderError } from '../errors.js';
import { OpenAICompatibleProvider } from '../providers.js';
import { resolveKimiOptions, type KimiProviderOptions } from './kimi-shared.js';

export class ReferenceKimiProvider extends OpenAICompatibleProvider {
  constructor(options: KimiProviderOptions) { super(resolveKimiOptions(options)); }
  protected override buildRequestBody(messages: Message[], tools: ToolSchema[]): Record<string, unknown> {
    const body = super.buildRequestBody(messages, tools);
    delete body.max_tokens;
    return { ...body, reasoning_effort: 'low', max_completion_tokens: 8192, stream: false };
  }
  protected override parseResponse(data: unknown): ModelResponse {
    const choice = isRecord(data) && Array.isArray(data.choices) ? data.choices[0] : undefined;
    if (!isRecord(choice) || !['stop', 'tool_calls'].includes(String(choice.finish_reason))) {
      throw new ProviderError('Kimi did not return a completed text or tool response');
    }
    const result = super.parseResponse(data);
    if ((choice.finish_reason === 'tool_calls') !== Boolean(result.toolCalls?.length)) {
      throw new ProviderError('Kimi finish_reason does not match its tool calls');
    }
    return result;
  }
}
