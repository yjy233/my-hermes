import { ContextBudgetExceeded } from '../errors.js';
import { messageSize, type Message } from '../models.js';

/** 关闭语义压缩时使用的同步辅助策略，不属于 L2 摘要算法。 */
export function trimHistory(messages: Message[], maxChars: number): Message[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error('maxChars must be positive');
  if (messages[0]?.role !== 'system') throw new Error('Context must begin with a system message');
  let budget = maxChars - messageSize(messages[0]);
  if (budget < 0) throw new ContextBudgetExceeded('System prompt exceeds context budget');
  const groups: Message[][] = [];
  for (const message of messages.slice(1)) {
    if (message.role === 'user') groups.push([]);
    if (!groups.length) throw new Error('Expected user message after system');
    groups.at(-1)!.push(message);
  }
  const kept: Message[][] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const size = groups[i].reduce((sum, message) => sum + messageSize(message), 0);
    if (size > budget) {
      if (!kept.length) throw new ContextBudgetExceeded('System prompt and newest turn exceed budget');
      break;
    }
    kept.unshift(groups[i]); budget -= size;
  }
  return [messages[0], ...kept.flat()];
}
