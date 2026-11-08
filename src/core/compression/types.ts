import type { Message, ToolSchema } from '../models.js';
import type { CompressionSettings, CompressionState } from './settings.js';

export interface CompressionResult {
  messages: Message[];
  changed: boolean;
  method?: 'prune' | 'summary' | 'fallback';
}

/** L2 使用的运行环境：模型请求、冷却状态和提交检查由基础设施提供。 */
export interface CompressionRuntime {
  readonly maxChars: number;
  readonly settings: Readonly<CompressionSettings>;
  readonly memory: string;
  readonly focus: string | undefined;
  snapshot(): CompressionState;
  emit(event: string, payload: Record<string, unknown>): void;
  skipped(messages: Message[], reason: string, before: number, backoff?: boolean): CompressionResult;
  commit(original: Message[], candidate: Message[], tools: ToolSchema[], method: NonNullable<CompressionResult['method']>): CompressionResult;
  generate(prompt: Message[], signal?: AbortSignal): Promise<string | null>;
  mustPreserveHistory(): boolean;
}

export type CompactHistory = (messages: Message[], tools: ToolSchema[], runtime: CompressionRuntime,
  signal?: AbortSignal, force?: boolean) => Promise<CompressionResult>;
