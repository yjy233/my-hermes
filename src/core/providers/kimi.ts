/** L0：由你实现模型 Provider。阶段 0 使用本机模拟服务，不需要真实 API Key。 */
import { ExerciseNotImplemented } from '../errors.js';
import type { Message, ModelResponse, Provider, ToolSchema } from '../models.js';
import { resolveKimiOptions, type KimiProviderOptions, type ResolvedKimiOptions } from './kimi-shared.js';

export class KimiProvider implements Provider {
  protected readonly options: ResolvedKimiOptions;
  constructor(options: KimiProviderOptions) { this.options = resolveKimiOptions(options); }

  async complete(_messages: Message[], _tools: ToolSchema[], _signal?: AbortSignal): Promise<ModelResponse> {
    // L0 实现清单，详细契约见 docs/07-kimi-provider.md：
    // 1. 向 options.baseUrl + '/chat/completions' 发送 POST 请求，并设置 Bearer 鉴权。
    // 2. 用 toWireMessage 转换内部消息，同时携带函数工具的 schema。
    // 3. Kimi K3.1 Pro 使用 reasoning_effort:'low'、max_completion_tokens:8192、stream:false。
    //    不发送 K2 的 thinking 参数，也不覆盖模型固定的采样参数。
    // 4. 解析最终文本、tool_calls 和 reasoning_content，保留工具调用 ID。
    // 5. 限制响应字节数，隐藏 HTTP 错误正文；遇到 401/429 不自动重试。
    // 6. 响应外部 AbortSignal 和请求超时，返回前调用 validateModelResponse 校验结果。
    // Agent 工具循环属于独立的 L1 练习；此处不要用 ReferenceKimiProvider 代替自己的实现。
    throw new ExerciseNotImplemented('L0: implement core/providers/kimi.ts KimiProvider.complete');
  }
}
