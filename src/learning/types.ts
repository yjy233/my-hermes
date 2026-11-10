import type { Emit, Message, Provider } from '../core/models.js';
import type { ToolRegistry } from '../core/tools.js';
import type { MemoryHit } from '../memory/store.js';
import type { CompactHistory } from '../core/compression/types.js';
import type { ReflectionOptions, ReflectionResult } from '../evolution/reflection.js';
export type Mode = 'reference' | 'learner';
export interface Algorithms {
  runLoop(provider: Provider, registry: ToolRegistry, messages: Message[], maxSteps: number,
    emit: Emit, signal?: AbortSignal): Promise<Message[]>;
  compactHistory: CompactHistory;
  selectMemories(query: string, hits: MemoryHit[], limit: number): MemoryHit[];
  sessionKey(channel: string, conversationId: string, userId: string): string;
  /** learner 异步调用模型；reference 保留同步规则版作对照，调用方统一 await。 */
  reflect(transcript: Message[], provider: Provider, options?: ReflectionOptions): ReflectionResult | Promise<ReflectionResult>;
}
