import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export interface InboundMessage {
  eventId: string;
  channel: string;
  conversationId: string;
  userId: string;
  text: string;
}

export interface OutboundMessage {
  eventId: string;
  sessionKey: string;
  text: string;
  cached: boolean;
}

export class EventConflictError extends Error {
  override name = 'EventConflictError';
}

export class PermissionDeniedError extends Error {
  override name = 'PermissionDeniedError';
}

export function parseInbound(input: unknown): InboundMessage {
  const fields = ['eventId', 'channel', 'conversationId', 'userId', 'text'] as const;
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).length !== fields.length
      || fields.some((field) => !Object.hasOwn(input, field))) {
    throw new TypeError(`Message requires exactly: ${fields.join(', ')}`);
  }
  const data = input as Record<string, unknown>;
  for (const field of fields) {
    const value = data[field];
    const limit = field === 'text' ? 16_000 : 256;
    if (typeof value !== 'string' || !value.trim() || value.length > limit) {
      throw new TypeError(`${field} must be a nonempty string of at most ${limit} characters`);
    }
    if (field !== 'text' && /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new TypeError(`${field} must not contain control characters`);
    }
  }
  return Object.fromEntries(fields.map((field) => [field, data[field]])) as unknown as InboundMessage;
}

export interface GatewayAgent {
  run(sessionKey: string, scope: string, text: string, signal?: AbortSignal): Promise<string>;
}

function abortableWait(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!signal) return promise;
  return new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = (): void => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(() => { cleanup(); resolve(); }, (error: unknown) => {
      cleanup(); reject(error);
    });
  });
}

/** 每个 profile 由一个进程独占；完成事件缓存不保证副作用只执行一次。 */
export class Gateway {
  readonly allowedUsers: ReadonlySet<string> | undefined;
  private readonly db: DatabaseSync;
  private readonly tails = new Map<string, Promise<void>>();
  private closed = false;

  constructor(
    private readonly agent: GatewayAgent,
    store: { path: string },
    private readonly sessionKeyFn: (channel: string, conversationId: string, userId: string) => string,
    allowedUsers?: Set<string>,
  ) {
    this.allowedUsers = allowedUsers === undefined ? undefined : new Set(allowedUsers);
    this.db = new DatabaseSync(store.path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS gateway_events (
        event_key TEXT PRIMARY KEY, payload_hash TEXT NOT NULL,
        session_key TEXT NOT NULL, response TEXT NOT NULL,
        completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  static scopeFor(channel: string, userId: string): string {
    return JSON.stringify([channel, userId]);
  }

  async handle(input: InboundMessage, signal?: AbortSignal): Promise<OutboundMessage> {
    const message = parseInbound(input);
    if (this.closed) throw new Error('Gateway is closed');
    if (this.allowedUsers && !this.allowedUsers.has(message.userId)) {
      throw new PermissionDeniedError('User is not in gateway allowlist');
    }
    signal?.throwIfAborted();
    const sessionKey = this.sessionKeyFn(message.channel, message.conversationId, message.userId);
    if (typeof sessionKey !== 'string' || !sessionKey) {
      throw new TypeError('Session key function must return a nonempty string');
    }
    const eventKey = JSON.stringify([
      message.channel, message.conversationId, message.userId, message.eventId,
    ]);
    const payloadHash = createHash('sha256').update(JSON.stringify([
      message.channel, message.conversationId, message.userId, message.eventId, message.text,
    ])).digest('hex');
    const previous = this.tails.get(sessionKey) ?? Promise.resolve();
    let release!: () => void;
    const slot = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => slot);
    this.tails.set(sessionKey, tail);
    try {
      await abortableWait(previous, signal);
      signal?.throwIfAborted();
      if (this.closed) throw new Error('Gateway is closed');
      const row = this.db.prepare(
        'SELECT payload_hash,session_key,response FROM gateway_events WHERE event_key=?',
      ).get(eventKey);
      if (row) {
        if (row.payload_hash !== payloadHash) {
          throw new EventConflictError('Event ID was already completed with different content');
        }
        return {
          eventId: message.eventId, sessionKey: String(row.session_key),
          text: String(row.response), cached: true,
        };
      }
      const text = await this.agent.run(
        sessionKey, Gateway.scopeFor(message.channel, message.userId), message.text, signal,
      );
      signal?.throwIfAborted();
      if (typeof text !== 'string') throw new TypeError('Agent reply must be a string');
      this.db.prepare(
        'INSERT INTO gateway_events(event_key,payload_hash,session_key,response) VALUES (?,?,?,?)',
      ).run(eventKey, payloadHash, sessionKey, text);
      return { eventId: message.eventId, sessionKey, text, cached: false };
    } finally {
      release();
      void tail.then(() => {
        if (this.tails.get(sessionKey) === tail) this.tails.delete(sessionKey);
      });
    }
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}
