/** Durable complete transcripts; context selection never deletes stored history. */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertFiniteJson, type Message } from '../core/models.js';

export interface Session {
  id: string;
  key: string;
  scope: string;
  systemPrompt: string | null;
}
export interface SessionRecord extends Session { createdAt: string; messageCount: number }
export interface MemoryHit { sessionId: string; content: string; score: number }

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
  return message;
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

  appendMessages(id: string, messages: Message[]): void {
    // Serialize before opening the transaction; never partially append a malformed turn.
    const serialized = messages.map(message => {
      const clean: Message = {
        role: message.role, content: message.content,
        ...(message.toolCalls !== undefined ? { toolCalls: message.toolCalls } : {}),
        ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
      };
      assertFiniteJson(clean);
      const payload = JSON.stringify(clean);
      parseMessage(payload);
      return { payload, content: message.content };
    });
    const insert = this.database.prepare(
      'INSERT INTO messages (session_id, payload, content) VALUES (?, ?, ?)',
    );
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const { payload, content } of serialized) insert.run(id, payload, content);
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
