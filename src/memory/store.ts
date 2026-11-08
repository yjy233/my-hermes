/** 持久化完整会话轨迹；上下文筛选不会删除已保存的历史记录。 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertFiniteJson, assertToolBoundary, type Message } from '../core/models.js';
import { initialCompressionState, type CompressionState } from '../core/compression/settings.js';

export interface Session {
  id: string;
  key: string;
  scope: string;
  systemPrompt: string | null;
}
export interface SessionRecord extends Session { createdAt: string; messageCount: number }
export interface MemoryHit { sessionId: string; content: string; score: number }
/** 默认 Hermes 式压缩保存的可继续执行的工作上下文，与摘要代际检查点分表。 */
export interface WorkingContextCheckpoint { messages: Message[]; state: CompressionState }

/** 摘要只是原始历史的派生视图；coveredCount 不包含冻结的 system 消息。 */
export interface ContextCheckpoint {
  sessionId: string;
  generation: number;
  coveredCount: number;
  prefixHash: string;
  summary: string;
  updatedAt: string;
}

/**
 * 一轮运行中的待提交摘要。
 * expectedGeneration 是读取时看到的代际；0 表示尚无摘要。
 * 真正保存时才递增 generation，避免失败或取消的轮次留下半成品检查点。
 */
export interface ContextCheckpointDraft {
  coveredCount: number;
  prefixHash: string;
  summary: string;
  expectedGeneration: number;
}

interface SessionRow { id: string; session_key: string; scope: string; system_prompt: string | null }

function sessionFrom(row: SessionRow): Session {
  return { id: row.id, key: row.session_key, scope: row.scope, systemPrompt: row.system_prompt };
}

function parseMessage(payload: string): Message {
  const data: unknown = JSON.parse(payload);
  if (typeof data !== 'object' || data === null) throw new Error('Invalid stored message');
  const message = data as Message;
  if (!['system', 'user', 'assistant', 'tool'].includes(message.role)
      || typeof message.content !== 'string') throw new Error('Invalid stored message');
  if (message.toolCalls !== undefined && (!Array.isArray(message.toolCalls)
      || message.toolCalls.some(call => !call || typeof call.id !== 'string'
        || typeof call.name !== 'string' || !call.arguments || typeof call.arguments !== 'object'
        || Array.isArray(call.arguments)))) throw new Error('Invalid stored tool calls');
  if (message.toolCallId !== undefined && typeof message.toolCallId !== 'string') {
    throw new Error('Invalid stored tool call ID');
  }
  if (message.reasoningContent !== undefined && typeof message.reasoningContent !== 'string') {
    throw new Error('Invalid stored reasoning content');
  }
  if (message.contextSummary !== undefined && (!message.contextSummary || typeof message.contextSummary.body !== 'string' ||
      typeof message.contextSummary.hasUserTurn !== 'boolean' || (message.contextSummary.originalContent !== undefined &&
        typeof message.contextSummary.originalContent !== 'string'))) throw new Error('Invalid stored summary marker');
  return message;
}

/** 统一持久化和哈希的字段集合、字段顺序，不把调用方附加的临时字段写入历史。 */
function serializeMessage(message: Message): { payload: string; content: string } {
  const clean: Message = {
    role: message.role, content: message.content,
    ...(message.toolCalls !== undefined ? { toolCalls: message.toolCalls } : {}),
    ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
    ...(message.reasoningContent !== undefined ? { reasoningContent: message.reasoningContent } : {}),
    ...(message.contextSummary !== undefined ? { contextSummary: message.contextSummary } : {}),
  };
  assertFiniteJson(clean);
  const payload = JSON.stringify(clean);
  parseMessage(payload);
  return { payload, content: message.content };
}

/**
 * 为已覆盖的原始消息前缀计算内容指纹。
 * 它包含工具参数、调用 ID 和 reasoningContent，因此元数据变化也会使旧摘要失效。
 * 传入历史不能包含外层临时拼出的 system 或摘要消息。
 */
export function hashContextPrefix(messages: Message[]): string {
  const payloads = messages.map(message => serializeMessage(message).payload);
  return createHash('sha256').update(`[${payloads.join(',')}]`).digest('hex');
}

/** 冷却状态只保存固定类别和有限计数，不能持久化 Provider 的任意错误正文。 */
function validateCompressionState(value: unknown): asserts value is CompressionState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid compression state');
  const state = value as CompressionState;
  if (![state.cooldownUntil, state.failures, state.nextAttemptChars].every(item => Number.isFinite(item) && item >= 0)
      || (state.lastFailure !== undefined && !['access', 'network', 'timeout', 'overload', 'empty', 'truncated', 'invalid', 'other'].includes(state.lastFailure))) {
    throw new Error('Invalid compression state');
  }
  assertFiniteJson(state);
}

export class SessionStore {
  readonly path: string;
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(path: string) {
    this.path = path === ':memory:' ? path : resolve(path);
    if (path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
    this.database = new DatabaseSync(this.path);
    this.database.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL,
        system_prompt TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        payload TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, id);
      CREATE INDEX IF NOT EXISTS sessions_scope ON sessions(scope);
    `);
    // 两条开发线曾给不同格式使用同一个表名。只迁移可明确识别的旧摘要表，
    // 不重写 messages；远端工作上下文表保持原名，摘要代际表使用独立名称。
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const columns = this.database.prepare('PRAGMA table_info(context_checkpoints)').all().map(row => String(row.name));
      if (columns.includes('generation') && !columns.includes('compression_state')) {
        const existing = this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'summary_checkpoints'").get();
        if (existing) throw new Error('Both legacy and current summary checkpoint tables exist; refusing to overwrite either');
        this.database.exec('ALTER TABLE context_checkpoints RENAME TO summary_checkpoints');
      } else if (columns.length && !['session_id', 'payload', 'message_count', 'compression_state'].every(name => columns.includes(name))) {
        throw new Error('Unknown context checkpoint table format');
      }
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS context_checkpoints (
          session_id TEXT PRIMARY KEY REFERENCES sessions(id),
          payload TEXT,
          message_count INTEGER NOT NULL DEFAULT -1,
          compression_state TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS summary_checkpoints (
          session_id TEXT PRIMARY KEY REFERENCES sessions(id),
          generation INTEGER NOT NULL CHECK (generation >= 1),
          covered_count INTEGER NOT NULL CHECK (covered_count > 0),
          prefix_hash TEXT NOT NULL,
          summary TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      this.database.close();
      throw error;
    }
  }

  getOrCreate(key: string, scope: string): Session {
    if (typeof key !== 'string' || !key || typeof scope !== 'string' || !scope) {
      throw new Error('Session key and memory scope are required');
    }
    this.database.prepare(
      'INSERT OR IGNORE INTO sessions (id, session_key, scope) VALUES (?, ?, ?)',
    ).run(randomUUID().replaceAll('-', ''), key, scope);
    const row = this.database.prepare(
      'SELECT id, session_key, scope, system_prompt FROM sessions WHERE session_key = ?',
    ).get(key) as unknown as SessionRow;
    if (row.scope !== scope) throw new Error('An existing session cannot move to another scope');
    return sessionFrom(row);
  }

  setSystemPrompt(id: string, text: string): void {
    const result = this.database.prepare(
      'UPDATE sessions SET system_prompt = ? WHERE id = ? AND system_prompt IS NULL',
    ).run(text, id);
    if (Number(result.changes) === 0
        && !this.database.prepare('SELECT 1 FROM sessions WHERE id = ?').get(id)) {
      throw new Error(`Unknown session: ${id}`);
    }
  }

  loadMessages(id: string): Message[] {
    return this.database.prepare(
      'SELECT payload FROM messages WHERE session_id = ? ORDER BY id',
    ).all(id).map(row => parseMessage(String(row.payload)));
  }

  /** 保留远端第三参数接口，原始消息与工作上下文仍在同一事务提交。 */
  appendMessages(id: string, messages: Message[], checkpoint?: WorkingContextCheckpoint): void {
    this.commitTurn(id, messages, undefined, checkpoint);
  }

  /** 工作上下文只在与原始历史水位匹配时采用；旧库和外部追加自动回到完整历史。 */
  loadContextMessages(id: string): Message[] {
    const row = this.database.prepare('SELECT payload, message_count FROM context_checkpoints WHERE session_id = ?').get(id);
    const count = this.database.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get(id)!;
    if (!row?.payload || Number(row.message_count) !== Number(count.count)) return this.loadMessages(id);
    const payloads: unknown = JSON.parse(String(row.payload));
    if (!Array.isArray(payloads)) throw new Error('Invalid context checkpoint');
    return payloads.map(payload => parseMessage(JSON.stringify(payload)));
  }

  loadCompressionState(id: string): CompressionState {
    const row = this.database.prepare('SELECT compression_state FROM context_checkpoints WHERE session_id = ?').get(id);
    if (!row) return initialCompressionState();
    const state: unknown = JSON.parse(String(row.compression_state));
    validateCompressionState(state);
    return state;
  }

  /** 失败只更新冷却状态，不发布未完成回合的摘要或消息。 */
  saveCompressionState(id: string, state: CompressionState): void {
    validateCompressionState(state);
    this.database.prepare('INSERT INTO context_checkpoints (session_id, compression_state) VALUES (?, ?) '
      + 'ON CONFLICT(session_id) DO UPDATE SET compression_state = excluded.compression_state').run(id, JSON.stringify(state));
  }

  /** 按会话读取最近一次成功提交的摘要；没有摘要的旧数据库返回 null。 */
  loadCheckpoint(id: string): ContextCheckpoint | null {
    const row = this.database.prepare(
      'SELECT session_id, generation, covered_count, prefix_hash, summary, updated_at '
      + 'FROM summary_checkpoints WHERE session_id = ?',
    ).get(id);
    if (!row) return null;
    const checkpoint: ContextCheckpoint = {
      sessionId: String(row.session_id), generation: Number(row.generation),
      coveredCount: Number(row.covered_count), prefixHash: String(row.prefix_hash),
      summary: String(row.summary), updatedAt: String(row.updated_at),
    };
    // 即使数据库被外部程序手工改坏，也不能把异常摘要悄悄当成有效上下文。
    if (!Number.isSafeInteger(checkpoint.generation) || checkpoint.generation < 1
        || !Number.isSafeInteger(checkpoint.coveredCount) || checkpoint.coveredCount < 1
        || !/^[a-f0-9]{64}$/.test(checkpoint.prefixHash)
        || !checkpoint.summary.trim() || checkpoint.summary.length > 16_000) {
      throw new Error('Invalid stored context checkpoint');
    }
    return checkpoint;
  }

  /**
   * 原子提交本轮原始消息及其派生摘要。
   *
   * 摘要请求在事务外执行：数据库锁不跨越模型网络请求。
   * 只有最终答复已完成后，Agent 才调用本方法；失败或取消时不调用即可保留旧状态。
   * 写入前重新校验指纹和摘要代际，拒绝迟到结果覆盖更新的摘要。
   */
  commitTurn(id: string, messages: Message[], checkpoint?: ContextCheckpointDraft, working?: WorkingContextCheckpoint): void {
    // 开始事务前先序列化，避免只写入畸形轮次的一部分。
    const serialized = messages.map(serializeMessage);
    let active: string | undefined;
    if (working) {
      validateCompressionState(working.state);
      active = '[' + working.messages.map(message => serializeMessage(message).payload).join(',') + ']';
    }
    if (checkpoint) {
      if (!Number.isSafeInteger(checkpoint.coveredCount) || checkpoint.coveredCount < 1) {
        throw new Error('Checkpoint coveredCount must be a positive safe integer');
      }
      if (!Number.isSafeInteger(checkpoint.expectedGeneration) || checkpoint.expectedGeneration < 0
          || checkpoint.expectedGeneration >= Number.MAX_SAFE_INTEGER) {
        throw new Error('Checkpoint expectedGeneration must be a nonnegative safe integer');
      }
      if (typeof checkpoint.prefixHash !== 'string' || !/^[a-f0-9]{64}$/.test(checkpoint.prefixHash)) {
        throw new Error('Checkpoint prefixHash must be a SHA256 digest');
      }
      if (typeof checkpoint.summary !== 'string' || !checkpoint.summary.trim()
          || checkpoint.summary.length > 16_000) {
        throw new Error('Checkpoint summary must contain 1..16000 characters');
      }
    }
    const insert = this.database.prepare(
      'INSERT INTO messages (session_id, payload, content) VALUES (?, ?, ?)',
    );
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (checkpoint) {
        // 摘要范围针对未裁剪、未清理工具输出的原始历史，包含本轮待保存的新消息。
        // 用事务内重新读取的数据校验，不能只相信模型请求开始时的内存副本。
        const previous = this.loadCheckpoint(id);
        if ((previous?.generation ?? 0) !== checkpoint.expectedGeneration) {
          throw new Error('Checkpoint generation conflict; reload the current session');
        }
        const transcript = [...this.loadMessages(id), ...serialized.map(item => parseMessage(item.payload))];
        if (checkpoint.coveredCount > transcript.length
            || checkpoint.coveredCount < (previous?.coveredCount ?? 0)) {
          throw new Error('Checkpoint coveredCount exceeds history or moves backward');
        }
        if (hashContextPrefix(transcript.slice(0, checkpoint.coveredCount)) !== checkpoint.prefixHash) {
          throw new Error('Checkpoint history prefix hash mismatch');
        }
        assertToolBoundary(transcript, checkpoint.coveredCount);
      }
      for (const { payload, content } of serialized) insert.run(id, payload, content);
      if (checkpoint) {
        this.database.prepare(
          'INSERT INTO summary_checkpoints (session_id, generation, covered_count, prefix_hash, summary) '
          + 'VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET '
          + 'generation = excluded.generation, covered_count = excluded.covered_count, '
          + 'prefix_hash = excluded.prefix_hash, summary = excluded.summary, updated_at = CURRENT_TIMESTAMP',
        ).run(id, checkpoint.expectedGeneration + 1, checkpoint.coveredCount, checkpoint.prefixHash, checkpoint.summary);
      }
      if (working && active !== undefined) {
        const count = this.database.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get(id)!;
        this.database.prepare('INSERT INTO context_checkpoints (session_id, payload, message_count, compression_state) VALUES (?, ?, ?, ?) '
          + 'ON CONFLICT(session_id) DO UPDATE SET payload = excluded.payload, message_count = excluded.message_count, '
          + 'compression_state = excluded.compression_state').run(id, active, Number(count.count), JSON.stringify(working.state));
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  search(query: string, scope: string, limit = 5): MemoryHit[] {
    if (!query.trim() || limit <= 0) return [];
    if (query.length > 1000) throw new Error('Search query is too long');
    if (!Number.isInteger(limit)) throw new Error('Search limit must be an integer');
    const needle = query.trim().replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
    return this.database.prepare(
      "SELECT m.session_id, m.content FROM messages m JOIN sessions s ON s.id = m.session_id "
      + "WHERE s.scope = ? AND m.content LIKE ? ESCAPE '\\' ORDER BY m.id DESC LIMIT ?",
    ).all(scope, `%${needle}%`, Math.min(limit, 100)).map(row => ({
      sessionId: String(row.session_id), content: String(row.content), score: 1,
    }));
  }

  listSessions(): SessionRecord[] {
    return this.database.prepare(
      'SELECT s.id, s.session_key, s.scope, s.system_prompt, s.created_at, '
      + 'COUNT(m.id) AS message_count FROM sessions s LEFT JOIN messages m ON m.session_id = s.id '
      + 'GROUP BY s.id ORDER BY s.created_at DESC, s.id',
    ).all().map(row => ({
      ...sessionFrom(row as unknown as SessionRow),
      createdAt: String(row.created_at), messageCount: Number(row.message_count),
    }));
  }

  close(): void {
    if (!this.closed) { this.database.close(); this.closed = true; }
  }
}
