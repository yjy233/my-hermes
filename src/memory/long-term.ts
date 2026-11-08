/** 有大小上限的精简 Markdown 记忆，按用户 scope 的哈希值隔离。 */
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { assertSafeFile, atomicWrite, canonicalDirectory, pathExists, readBoundedFile } from './files.js';

export type MemoryTarget = 'MEMORY.md' | 'USER.md';
/** 工具使用语义目标，文件路径仍由存储层决定，模型不能传入任意路径。 */
export type MemoryStoreTarget = 'memory' | 'user';
export type MemoryOperation =
  | { action: 'add'; content: string }
  | { action: 'patch'; old_text: string; content: string }
  | { action: 'remove'; old_text: string };
export interface MemoryUsage { chars: number; limit: number; percent: number; }
export interface MemoryManagementResult {
  target: MemoryStoreTarget;
  changed: boolean;
  entries: string[];
  usage: MemoryUsage;
}

/**
 * 让模型从工具错误中恢复：它能看到当前条目和容量，整理后重新提交同一目标的一批操作。
 * details 和 message 都不表示写入成功；调用失败时，原文件保持不变。
 */
export class MemoryOperationError extends Error {
  constructor(message: string, readonly details: Record<string, unknown>) {
    super(`${message}\n${JSON.stringify(details)}`);
    this.name = 'MemoryOperationError';
  }
}

// § 作为单独一行分隔条目；普通句子中的 § 不会被拆成多条记忆。
const ENTRY_SEPARATOR = '\n\n§\n\n';
const TARGET_FILES: Record<MemoryStoreTarget, MemoryTarget> = { memory: 'MEMORY.md', user: 'USER.md' };

export class LongTermMemory {
  readonly root: string;
  readonly maxChars: number;

  constructor(root: string, maxChars = 4000) {
    if (!Number.isSafeInteger(maxChars) || maxChars <= 0) throw new Error('Memory budget must be positive');
    this.root = canonicalDirectory(root);
    this.maxChars = maxChars;
  }

  private memoryPath(scope: string, target: string): string {
    if (target !== 'MEMORY.md' && target !== 'USER.md') {
      throw new Error('Memory target must be MEMORY.md or USER.md');
    }
    if (typeof scope !== 'string' || !scope) throw new Error('Memory scope is required');
    const directory = join(this.root, createHash('sha256').update(scope).digest('hex'));
    if (pathExists(directory) && lstatSync(directory).isSymbolicLink()) {
      throw new Error('Memory scope directories cannot be symlinks');
    }
    mkdirSync(directory, { recursive: true });
    const path = join(directory, target);
    assertSafeFile(this.root, path);
    return path;
  }

  read(scope: string, target: string): string {
    const path = this.memoryPath(scope, target);
    if (!pathExists(path)) return '';
    const content = readBoundedFile(path, this.maxChars * 4);
    if (content.length > this.maxChars) throw new Error('Memory file exceeds the configured budget');
    return content;
  }

  write(scope: string, target: string, content: string): void {
    if (typeof content !== 'string' || content.length > this.maxChars) {
      throw new Error(`Memory content must be at most ${this.maxChars} characters`);
    }
    atomicWrite(this.memoryPath(scope, target), content);
  }

  /**
   * Hermes 式有界条目管理：先在内存中执行整批操作，再按最终大小一次性落盘。
   *
   * “压缩长期记忆”由模型明确提出 patch/remove 来完成，存储层不擅自丢掉旧事实。
   * 例如先把三条项目事实合并为一条，再添加新偏好；只检查整批结束后的容量，
   * 因此可以把 add 放在 remove 之前，不需要为暂时超限把一批操作拆成多次写入。
   *
   * 该方法没有 await，单进程中不会在读、改、写之间插入另一个异步工具调用；
   * 文件落盘继续复用路径检查和 atomicWrite。跨进程互斥由 profile 锁负责。
   */
  manage(scope: string, target: MemoryStoreTarget, operations: readonly MemoryOperation[]): MemoryManagementResult {
    if (target !== 'memory' && target !== 'user') {
      throw new Error('Memory target must be memory or user');
    }
    const file = TARGET_FILES[target];
    const original = this.read(scope, file);
    const currentEntries = this.entries(original);
    const fail = (code: string, message: string, extra: Record<string, unknown> = {}): never => {
      throw new MemoryOperationError(message, {
        code, target, current_entries: currentEntries, usage: this.usage(original), ...extra,
      });
    };

    // 先完成所有参数校验。即使最后一个操作缺字段，也不能先执行前几个操作。
    if (!Array.isArray(operations) || operations.length < 1 || operations.length > 32) {
      fail('invalid_operations', 'Submit between 1 and 32 operations for one target.');
    }
    for (const [index, operation] of operations.entries()) {
      if (operation === null || typeof operation !== 'object' || Array.isArray(operation) ||
          !['add', 'patch', 'remove'].includes(operation.action)) {
        fail('invalid_operation', 'Each operation must use add, patch, or remove.', { operation_index: index });
      }
      const allowed = operation.action === 'add' ? ['action', 'content'] : operation.action === 'patch'
        ? ['action', 'old_text', 'content'] : ['action', 'old_text'];
      if (Object.keys(operation).some(key => !allowed.includes(key))) {
        fail('invalid_operation', 'Use one top-level target; operation fields must match its action.', { operation_index: index });
      }
      if (operation.action !== 'remove') {
        if (typeof operation.content !== 'string' || (operation.action === 'add' && !operation.content.trim())) {
          fail('invalid_content', 'add requires nonempty content; patch requires text content.', { operation_index: index });
        }
        if (operation.action === 'add' && /^\s*§\s*$/mu.test(operation.content)) {
          fail('invalid_content', 'A memory entry cannot contain a standalone § separator line.', { operation_index: index });
        }
      }
      if (operation.action !== 'add' && (typeof operation.old_text !== 'string' || !operation.old_text.trim())) {
        fail('invalid_old_text', 'patch/remove require a nonempty old_text identifying one entry.', { operation_index: index });
      }
    }

    // 在副本上演算。发生歧义、找不到条目、最终超限时，全部放弃，不修改磁盘文件。
    const next = [...currentEntries];
    let changed = false;
    for (const [index, operation] of operations.entries()) {
      if (operation.action === 'add') {
        const content = operation.content.trim();
        // 精确重复是幂等成功，不把重复事实挤进有限的长期记忆容量。
        if (!next.includes(content)) { next.push(content); changed = true; }
        continue;
      }

      // 完整条目精确匹配优先；否则 old_text 必须只指向一条记忆。
      // 例如已有“使用深色主题”和“终端使用深色主题”，完整前者仍可被准确定位。
      const exact = next.map((entry, entryIndex) => entry === operation.old_text ? entryIndex : -1).filter(value => value >= 0);
      const matches = exact.length > 0 ? exact
        : next.map((entry, entryIndex) => entry.includes(operation.old_text) ? entryIndex : -1).filter(value => value >= 0);
      if (matches.length !== 1) {
        fail(matches.length === 0 ? 'not_found' : 'ambiguous_entry',
          matches.length === 0 ? 'old_text matched no entry; inspect current_entries and retry.'
            : 'old_text matched multiple entries; provide a longer unique span.', { operation_index: index });
      }
      const entryIndex = matches[0], entry = next[entryIndex];
      if (operation.action === 'remove') {
        next.splice(entryIndex, 1);
        changed = true;
        continue;
      }

      // patch 只替换一个 span，不能把同条记忆里的其它事实一起覆盖。
      // 同一条中出现多次 old_text 也拒绝，要求模型补充上下文后再提交。
      const start = entry.indexOf(operation.old_text);
      if (entry.indexOf(operation.old_text, start + operation.old_text.length) !== -1) {
        fail('ambiguous_span', 'old_text occurs more than once in its entry; provide a unique span.', { operation_index: index });
      }
      const replacement = entry.slice(0, start) + operation.content + entry.slice(start + operation.old_text.length);
      if (!replacement.trim()) {
        fail('empty_entry', 'patch cannot leave an empty entry; use remove instead.', { operation_index: index });
      }
      if (/^\s*§\s*$/mu.test(replacement)) {
        fail('invalid_content', 'A memory entry cannot contain a standalone § separator line.', { operation_index: index });
      }
      if (replacement !== entry) { next[entryIndex] = replacement; changed = true; }
    }

    // 无变更的幂等操作不重排旧文档，不改变其原有格式或文件修改时间。
    const result = changed ? next.join(ENTRY_SEPARATOR) : original;
    if (result.length > this.maxChars) {
      fail('capacity_exceeded',
        'Batch final content exceeds capacity. No operation was committed. Retry ONE batch that consolidates/removes stale entries and adds the new fact.',
        { attempted_chars: result.length, required_space: result.length - this.maxChars });
    }
    if (changed) this.write(scope, file, result);
    return { target, changed, entries: this.entries(result), usage: this.usage(result) };
  }

  private entries(content: string): string[] {
    return content.split(/\r?\n[ \t]*§[ \t]*\r?\n/u).map(entry => entry.trim()).filter(Boolean);
  }

  private usage(content: string): MemoryUsage {
    return { chars: content.length, limit: this.maxChars, percent: Math.round(content.length / this.maxChars * 100) };
  }

  snapshot(scope: string): string {
    return ['MEMORY.md', 'USER.md'].map(target => {
      const content = this.read(scope, target), usage = this.usage(content);
      // 容量写进会话开始时的快照，模型可以在接近上限时主动合并事实。
      // 这里仅生成文本；已有会话是否冻结仍由 Agent 的会话提示持久化规则决定。
      return `## ${target} [${usage.chars}/${usage.limit} chars; ${usage.percent}%]\n${content}`;
    }).join('\n\n');
  }
}
