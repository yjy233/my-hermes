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
  /**
   * 处理一条入口事件：校验与授权 → 按会话排队 → 检查重复 → 执行 Agent → 缓存答复。
   * 同一 sessionKey 内串行执行，不同 sessionKey 可以并发推进。
   * 返回 cached=true 表示复用了先前成功处理的答复，本次没有再次调用 Agent。
   * sessionKeyFn 必须返回非空字符串；否则 handle() 抛出 TypeError。
   */
  async handle(input: InboundMessage, signal?: AbortSignal): Promise<OutboundMessage> {
    // 1. 即使 TS 类型正确，外部 JSON 仍需运行时校验；授权检查也必须早于读取缓存。
    // 未配置 allowedUsers 表示不设白名单，配置为空 Set 则拒绝所有用户。
    const message = parseInbound(input);
    if (this.closed) throw new Error('Gateway is closed');
    if (this.allowedUsers && !this.allowedUsers.has(message.userId)) {
      throw new PermissionDeniedError('User is not in gateway allowlist');
    }
    signal?.throwIfAborted();

    // 2. sessionKey 决定消息接入哪段对话，同时也是串行队列的键。
    const sessionKey = this.sessionKeyFn(message.channel, message.conversationId, message.userId);
    if (typeof sessionKey !== 'string' || !sessionKey) {
      throw new TypeError('Session key function must return a nonempty string');
    }
    // eventKey 标识一次投递：不同渠道、会话或用户可以使用相同 eventId。
    // payloadHash 用于识别“同一个事件 ID，却改了正文”的冲突，防止误返旧答复。
    const eventKey = JSON.stringify([
      message.channel, message.conversationId, message.userId, message.eventId,
    ]);
    const payloadHash = createHash('sha256').update(JSON.stringify([
      message.channel, message.conversationId, message.userId, message.eventId, message.text,
    ])).digest('hex');

    // 3. 为本次请求占一个队列位置。previous 是前面请求全部结束的信号；
    // slot 由本请求结束时 release，tail 要等 previous 和 slot 都完成。
    // 必须在 await 前更新队尾，后来的同会话请求才会排在本请求之后。
    const previous = this.tails.get(sessionKey) ?? Promise.resolve();
    let release!: () => void;
    const slot = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => slot);
    this.tails.set(sessionKey, tail);
    try {
      await abortableWait(previous, signal);
      // 等待期间可能被取消或关闭，因此轮到本请求时需要再次检查。
      signal?.throwIfAborted();
      if (this.closed) throw new Error('Gateway is closed');

      // 4. 去重查询放在排队之后：前一个相同事件可能刚刚执行完并写入缓存。
      // SQLite 保存的是已完成事件，重启后重复投递也可以直接复用结果。
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

      // 5. 没有缓存才执行 Agent。sessionKey 定位当前对话；scope 决定记忆共享范围。
      // scope 由渠道 + 用户生成，同一用户跨会话共享，群内不同用户仍然隔离。
      const text = await this.agent.run(
        sessionKey, Gateway.scopeFor(message.channel, message.userId), message.text, signal,
      );
      signal?.throwIfAborted();
      if (typeof text !== 'string') throw new TypeError('Agent reply must be a string');

      // 6. 只缓存成功返回且未取消的答复；未记录完成的事件仍可重试。
      // Agent 保存对话与此 INSERT 不在同一事务，缓存不能保证工具副作用只发生一次。
      this.db.prepare(
        'INSERT INTO gateway_events(event_key,payload_hash,session_key,response) VALUES (?,?,?,?)',
      ).run(eventKey, payloadHash, sessionKey, text);
      return { eventId: message.eventId, sessionKey, text, cached: false };
    } finally {
      // 7. 成功、失败或取消都要释放自己的 slot，避免后续请求一直等待。
      // 若在排队时取消，tail 仍需等待 previous，后续请求不能越过尚未完成的前任。
      release();
      void tail.then(() => {
        // 只有本请求仍是最后一个队列位置时才删除；否则会误删后来请求设置的新队尾。
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
