/** 内部消息使用 camelCase 字段，仅在 Provider 边界转换为 API 协议格式。 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /** 保留思考模型工具调用所需的协议元数据，不作为最终答复展示。 */
  reasoningContent?: string;
}
export interface ModelResponse { content: string; toolCalls?: ToolCall[]; reasoningContent?: string; }
export interface ToolSchema {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface Provider {
  complete(messages: Message[], tools: ToolSchema[], signal?: AbortSignal): Promise<ModelResponse>;
}
export type Emit = (event: string, payload: Record<string, unknown>) => void;
export const MAX_MODEL_CONTENT_CHARS = 16_000;
export const MAX_TOOL_CALLS = 8;
export const MAX_TOOL_ARGUMENT_CHARS = 16_000;
export const MAX_MODEL_REASONING_CHARS = 32_000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertFiniteJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || ancestors.has(value)) {
    throw new Error('Expected finite, non-circular JSON values');
  }
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) throw new Error('Expected plain JSON object');
  ancestors.add(value);
  for (const item of Object.values(value)) assertFiniteJson(item, ancestors);
  ancestors.delete(value);
}

export function validateModelResponse(value: unknown): asserts value is ModelResponse {
  if (!isRecord(value) || typeof value.content !== 'string') {
    throw new Error('Model response must contain text content');
  }
  if (value.content.length > MAX_MODEL_CONTENT_CHARS) throw new Error('Model content exceeds 16000 characters');
  if (value.reasoningContent !== undefined && (typeof value.reasoningContent !== 'string' ||
      value.reasoningContent.length > MAX_MODEL_REASONING_CHARS)) {
    throw new Error('Model reasoningContent must be text of at most 32000 characters');
  }
  const calls = value.toolCalls ?? [];
  if (!Array.isArray(calls) || calls.length > MAX_TOOL_CALLS) throw new Error('At most 8 tool calls allowed');
  if (!value.content && calls.length === 0) throw new Error('Model returned neither content nor tool calls');
  const seen = new Set<string>();
  for (const call of calls) {
    if (!isRecord(call) || typeof call.id !== 'string' || call.id.length < 1 || call.id.length > 128) {
      throw new Error('Tool call ID must contain 1..128 characters');
    }
    if (seen.has(call.id)) throw new Error('Duplicate tool call IDs');
    seen.add(call.id);
    if (typeof call.name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(call.name)) {
      throw new Error('Invalid tool name');
    }
    if (!isRecord(call.arguments)) throw new Error('Tool arguments must be a JSON object');
    assertFiniteJson(call.arguments);
    if (JSON.stringify(call.arguments).length > MAX_TOOL_ARGUMENT_CHARS) {
      throw new Error('Tool arguments exceed 16000 characters');
    }
  }
}

export function toWireMessage(message: Message): Record<string, unknown> {
  return {
    role: message.role, content: message.content,
    ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map(call => ({
      id: call.id, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    })) } : {}),
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    ...(message.reasoningContent !== undefined ? { reasoning_content: message.reasoningContent } : {}),
  };
}

export function fromWireMessage(value: unknown): Message {
  if (!isRecord(value) || !['system', 'user', 'assistant', 'tool'].includes(String(value.role))) {
    throw new Error('Invalid message role');
  }
  const content = value.content ?? '';
  if (typeof content !== 'string') throw new Error('Only text messages are supported');
  const message: Message = { role: value.role as Message['role'], content };
  if (value.reasoning_content !== undefined && value.reasoning_content !== null) {
    if (typeof value.reasoning_content !== 'string') throw new Error('Invalid reasoning_content');
    message.reasoningContent = value.reasoning_content;
  }
  if (value.tool_calls !== undefined) {
    if (!Array.isArray(value.tool_calls)) throw new Error('Invalid tool calls');
    message.toolCalls = value.tool_calls.map((entry: unknown) => {
      if (!isRecord(entry) || !isRecord(entry.function) || typeof entry.id !== 'string' ||
          typeof entry.function.name !== 'string' || typeof entry.function.arguments !== 'string') {
        throw new Error('Invalid wire tool call');
      }
      const args: unknown = JSON.parse(entry.function.arguments);
      if (!isRecord(args)) throw new Error('Tool arguments must be an object');
      return { id: entry.id, name: entry.function.name, arguments: args };
    });
  }
  if (value.tool_call_id !== undefined) {
    if (typeof value.tool_call_id !== 'string') throw new Error('Invalid tool result ID');
    message.toolCallId = value.tool_call_id;
  }
  return message;
}

export function messageSize(message: Message): number { return JSON.stringify(toWireMessage(message)).length; }
