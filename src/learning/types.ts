import type { Emit, Message, Provider } from '../core/models.js';
import type { ToolRegistry } from '../core/tools.js';
import type { MemoryHit } from '../memory/store.js';
export type Mode = 'reference' | 'learner';
export interface Algorithms {
  runLoop(provider: Provider, registry: ToolRegistry, messages: Message[], maxSteps: number,
    emit: Emit, signal?: AbortSignal): Promise<Message[]>;
  compactHistory(messages: Message[], maxChars: number): Message[];
  selectMemories(query: string, hits: MemoryHit[], limit: number): MemoryHit[];
  sessionKey(channel: string, conversationId: string, userId: string): string;
  reflect(transcript: Message[]): string | null;
}
