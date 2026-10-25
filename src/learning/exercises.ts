/** Implement these five exercises; the surrounding system stays usable in reference mode. */
import { ExerciseNotImplemented } from '../core/errors.js';
import type { Emit, Message, Provider } from '../core/models.js';
import type { ToolRegistry } from '../core/tools.js';
import type { MemoryHit } from '../memory/store.js';

export async function runLoop(_provider: Provider, _registry: ToolRegistry, _messages: Message[],
  _maxSteps: number, _emit: Emit, _signal?: AbortSignal): Promise<Message[]> {
  // L1: return NEW assistant/tool messages, preserve call IDs, bound actions, honor cancellation.
  throw new ExerciseNotImplemented('L1: implement learning/exercises.ts runLoop');
}
export function compactHistory(_messages: Message[], _maxChars: number): Message[] {
  // L2: keep system + newest complete turns; never orphan tools; use messageSize from core/models.
  throw new ExerciseNotImplemented('L2: implement learning/exercises.ts compactHistory');
}
export function selectMemories(_query: string, _hits: MemoryHit[], _limit: number): MemoryHit[] {
  // L3: rank already scoped hits without mutating them; cap result count.
  throw new ExerciseNotImplemented('L3: implement learning/exercises.ts selectMemories');
}
export function sessionKey(_channel: string, _conversationId: string, _userId: string): string {
  // L4: stable collision-resistant encoding including all three dimensions.
  throw new ExerciseNotImplemented('L4: implement learning/exercises.ts sessionKey');
}
export function reflect(_transcript: Message[]): string | null {
  // L5: only successful tool-assisted final turns produce a reviewable Skill body; else null.
  throw new ExerciseNotImplemented('L5: implement learning/exercises.ts reflect');
}
