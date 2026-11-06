import { messageSize, type Message, type ToolCall } from '../models.js';
import type { CompressionSettings } from './settings.js';
import { elide, redact, summaryBody, withoutSummaries } from './text.js';

export const messagesSize = (messages: Message[]): number => messages.reduce((size, row) => size + messageSize(row), 0);

/** assistant 的一组调用与所有结果是最小切分单位；历史中的孤立结果不会进入新上下文。 */
export function messageGroups(messages: Message[]): Message[][] {
  const groups: Message[][] = [];
  for (let index = 0; index < messages.length; index++) {
    const row = structuredClone(messages[index]);
    if (row.role === 'tool') continue;
    if (row.role !== 'assistant' || !row.toolCalls?.length) { groups.push([row]); continue; }
    const results = new Map<string, Message>();
    while (messages[index + 1]?.role === 'tool') {
      const result = messages[++index];
      if (result.toolCallId && !results.has(result.toolCallId)) results.set(result.toolCallId, structuredClone(result));
    }
    const seen = new Set<string>();
    const calls = row.toolCalls.filter(call => {
      if (seen.has(call.id) || !results.has(call.id)) return false;
      seen.add(call.id); return true;
    });
    if (calls.length) groups.push([{ ...row, toolCalls: calls }, ...calls.map(call => results.get(call.id)!)]);
    else if (row.content) { delete row.toolCalls; delete row.reasoningContent; groups.push([row]); }
  }
  return groups;
}

function tailStart(groups: Message[][], budget: number, count: number): number {
  let start = groups.length, size = 0, rows = 0;
  while (start > 0) {
    const group = groups[start - 1], next = messagesSize(group);
    if (start < groups.length && (size + next > budget || rows + group.length > count)) break;
    size += next; rows += group.length; start--;
  }
  return start;
}

function toolStatus(content: string): Record<string, unknown> {
  try {
    const data = JSON.parse(content);
    if (data && typeof data === 'object') return {
      ...(typeof data.ok === 'boolean' ? { ok: data.ok } : {}),
      ...(data.ok === false ? { error: elide(redact(String(data.error ?? 'ToolError')), 80),
        message: elide(redact(String(data.message ?? '')), 240) } : {}),
    };
  } catch { /* 非 JSON 的旧记录依然可用作摘要来源。 */ }
  return {};
}

export function skillReloads(messages: Message[]): string[] {
  const names = new Set<string>();
  for (const row of messages) {
    for (const call of row.toolCalls ?? []) {
      if (call.name === 'skill_read' && typeof call.arguments.name === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(call.arguments.name)) {
        names.add(call.arguments.name);
      }
    }
    if (row.contextSummary) {
      for (const match of row.content.matchAll(/\[Reload skill: ([a-zA-Z0-9_-]{1,64})\]/g)) names.add(match[1]);
    }
  }
  return [...names];
}

/** 只在一次压缩尝试内清理副本，摘要失败时可完整丢弃这些改动。 */
export function pruneHistory(messages: Message[], available: number, settings: CompressionSettings): Message[] {
  const groups = messageGroups(messages);
  const protectedTail = tailStart(groups, available * 0.25, settings.protectLast);
  const latestCall = groups.findLastIndex(group => Boolean(group[0].toolCalls?.length));
  const calls = new Map<string, ToolCall>();
  const duplicates = new Map<string, string>();
  for (const row of messages) for (const call of row.toolCalls ?? []) calls.set(call.id, call);
  for (let groupIndex = groups.length - 1; groupIndex >= 0; groupIndex--) {
    for (const row of groups[groupIndex]) {
      if (row.role === 'assistant' && groupIndex !== latestCall && groupIndex >= settings.protectFirst) delete row.reasoningContent;
      if (row.role !== 'tool') continue;
      const call = calls.get(row.toolCallId ?? '');
      const duplicateKey = JSON.stringify([call?.name, call?.arguments, row.content]);
      const laterId = duplicates.get(duplicateKey);
      duplicates.set(duplicateKey, row.toolCallId ?? '');
      // 最新工具轮的结果尚未被模型消费；即使过大，也由上层明确报预算错误而非静默丢弃。
      if (groupIndex === latestCall || groupIndex < settings.protectFirst || (groupIndex >= protectedTail && !laterId)) continue;
      if (row.content.length <= 2000) continue;
      const skill = call?.name === 'skill_read' && typeof call.arguments.name === 'string'
        ? `[Reload skill: ${call.arguments.name}] Call skill_read before relying on this skill.` : undefined;
      row.content = JSON.stringify({ ...toolStatus(row.content), compressed: true, originalChars: row.content.length,
        ...(laterId ? { duplicateOf: laterId } : { excerpt: elide(redact(row.content), 240) }),
        ...(skill ? { skill } : {}),
      });
    }
  }
  return groups.flat();
}

export interface CompressionWindow {
  head: Message[]; middle: Message[]; tail: Message[]; previous: string; skills: string[]; hasUserTurn: boolean;
}

export function planWindow(messages: Message[], available: number, settings: CompressionSettings): CompressionWindow | null {
  const previousMessages = messages.filter(row => row.contextSummary);
  const previous = previousMessages.map(summaryBody).join('\n\n');
  const rows = withoutSummaries(messages);
  if (rows[0]?.role !== 'system') return null;
  const groups = messageGroups(rows.slice(1));
  let headEnd = 0, headCount = 1;
  while (headEnd < groups.length && headCount < settings.protectFirst) headCount += groups[headEnd++].length;
  const latestUser = groups.findLastIndex(group => group[0].role === 'user');
  // 单轮长任务也能压缩：原始用户请求在摘要后重新作为当前任务锚点保留。
  if (latestUser < headEnd) headEnd = 0;
  const tailBegin = Math.max(headEnd, tailStart(groups, available * 0.25, settings.protectLast));
  if (tailBegin <= headEnd) return null;
  const middle = groups.slice(headEnd, tailBegin).flat();
  const tail = groups.slice(tailBegin).flat();
  if (latestUser >= 0 && latestUser < tailBegin) tail.unshift(structuredClone(groups[latestUser][0]));
  return { head: [structuredClone(rows[0]), ...groups.slice(0, headEnd).flat()], middle, tail, previous,
    skills: skillReloads([...previousMessages, ...middle]),
    hasUserTurn: rows.some(row => row.role === 'user') || previousMessages.some(row => row.contextSummary?.hasUserTurn) };
}
