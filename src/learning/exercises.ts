/** 请实现下面五个算法练习；外围系统可随时切换到 reference 模式运行。 */
import { ExerciseNotImplemented } from '../core/errors.js';
import type { Emit, Message, Provider } from '../core/models.js';
import type { ToolRegistry } from '../core/tools.js';
import type { MemoryHit } from '../memory/store.js';

export async function runLoop(_provider: Provider, _registry: ToolRegistry, _messages: Message[],
  _maxSteps: number, _emit: Emit, _signal?: AbortSignal): Promise<Message[]> {
  // L1：仅返回本轮新产生的 assistant/tool 消息，保留调用 ID 和可选的 reasoningContent。
  // 限制执行步数、响应取消，并只将 content 作为最终答复展示。
  throw new ExerciseNotImplemented('L1: implement learning/exercises.ts runLoop');
}
export function compactHistory(_messages: Message[], _maxChars: number): Message[] {
  // L2：保留 system 与最近的完整轮次，不拆散工具调用和结果；用 core/models 的 messageSize 计算预算。
  throw new ExerciseNotImplemented('L2: implement learning/exercises.ts compactHistory');
}
export function selectMemories(_query: string, _hits: MemoryHit[], _limit: number): MemoryHit[] {
  // L3：对已按用户隔离的候选记录排序，不修改原始数据，并限制返回条数。
  throw new ExerciseNotImplemented('L3: implement learning/exercises.ts selectMemories');
}
export function sessionKey(_channel: string, _conversationId: string, _userId: string): string {
  // L4：将渠道、会话、用户三个维度编码成稳定且不易碰撞的会话键。
  throw new ExerciseNotImplemented('L4: implement learning/exercises.ts sessionKey');
}
export function reflect(_transcript: Message[]): string | null {
  // L5：仅从包含成功工具执行的完整轮次生成待审核 Skill 正文，其余情况返回 null。
  throw new ExerciseNotImplemented('L5: implement learning/exercises.ts reflect');
}
