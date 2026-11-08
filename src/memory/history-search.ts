/**
 * 历史消息的候选召回层：FTS5 词索引 → trigram 子串索引 → 字面 LIKE 回退。
 *
 * messages 是唯一原文来源。两个 FTS 表只是可以重建的“词语 → 消息 ID”倒排索引，
 * 不保存新的模型事实，也不调用 LLM。会话隔离、排序和 LIMIT 都在同一条 SQL 中完成。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Message } from '../core/models.js';
import type { MemoryHit } from './store.js';

export interface HistorySearchOptions {
  /** 测试/降级时只使用 LIKE 查询；底层可用的索引仍保持同步，防止恢复后漏消息。 */
  forceLike?: boolean;
  /** 测试 trigram 不可用时的查询回退，不破坏已经存在的索引。 */
  disableTrigram?: boolean;
}
export interface HistorySearchCapabilities { fts5: boolean; trigram: boolean; }
type IndexName = 'messages_fts' | 'messages_fts_trigram';
type SearchSource = 'fts5' | 'trigram' | 'like';
interface SearchRow {
  id: number;
  session_id: string;
  content: string;
  role: string;
  created_at: string;
  rank?: number;
}

const INDEX_VERSION = '1';
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const ORDINARY_QUERY = /^[\p{L}\p{M}\p{N}\s]+$/u;
const ROLES: readonly string[] = ['system', 'user', 'assistant', 'tool'];

/** SQL 参数能防 SQL 注入，但参数里的内容仍会被 MATCH 当作另一种查询语言解析。
 * 因此还要给每个词加 FTS 双引号；OR、NOT、* 等不会被当成用户提供的操作符执行。
 */
function quoteTerm(term: string): string { return `"${term.replaceAll('"', '""')}"`; }

/** LIKE 的参数同样有自己的通配符，%/_/反斜杠必须转义才能表达字面子串。 */
function likePattern(term: string): string {
  return `%${term.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

/** 只允许把明确的缺失模块/分词器当成能力降级；锁、损坏和 SQL 错误必须暴露。 */
function unavailable(error: unknown): boolean {
  return error instanceof Error && /no such module:\s*fts5|no such tokenizer:\s*trigram/iu.test(error.message);
}

function toHit(row: SearchRow, source: SearchSource): MemoryHit {
  if (!Number.isSafeInteger(row.id) || row.id < 1 || !ROLES.includes(row.role)) {
    throw new Error('Invalid stored history search row');
  }
  const rank = row.rank === undefined ? undefined : Number(row.rank);
  if (rank !== undefined && !Number.isFinite(rank)) throw new Error('Invalid history relevance rank');
  return {
    sessionId: row.session_id, content: row.content, score: 1,
    messageId: row.id, role: row.role as Message['role'], createdAt: row.created_at, source,
    ...(rank !== undefined ? { rank } : {}),
  };
}

export class HistorySearch {
  private readonly available: HistorySearchCapabilities;

  constructor(private readonly database: DatabaseSync, private readonly options: HistorySearchOptions = {}) {
    // 使用临时虚拟表探测真实运行时，而不是假设所有 Node/SQLite 构建都启用了扩展。
    const native = { fts5: this.probe(false), trigram: false };
    native.trigram = native.fts5 && this.probe(true);
    this.initialize(native);
    this.available = {
      fts5: native.fts5 && !options.forceLike,
      trigram: native.trigram && !options.forceLike && !options.disableTrigram,
    };
  }

  capabilities(): HistorySearchCapabilities { return { ...this.available }; }

  private probe(trigram: boolean): boolean {
    const name = trigram ? 'history_trigram_probe' : 'history_fts_probe';
    try {
      this.database.exec(`CREATE VIRTUAL TABLE temp.${name} USING fts5(content${trigram ? ", tokenize='trigram'" : ''})`);
      this.database.exec(`DROP TABLE temp.${name}`);
      return true;
    } catch (error) {
      if (!unavailable(error)) throw error;
      return false;
    }
  }

  private initialize(native: HistorySearchCapabilities): void {
    // 一个事务内安装表、触发器、版本标记和旧库回填；不会发布半套可查询的索引。
    // SAVEPOINT 也能安全嵌入调用方已有事务，不覆盖项目其他模块的 PRAGMA user_version。
    this.database.exec('SAVEPOINT history_search_initialize');
    try {
      this.database.exec('CREATE TABLE IF NOT EXISTS history_search_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      const indexes: IndexName[] = [];
      const rebuild: IndexName[] = [];
      for (const [name, enabled] of [
        ['messages_fts', native.fts5], ['messages_fts_trigram', native.trigram],
      ] as const) {
        const version = this.meta(`${name}:version`);
        if (version !== undefined && version !== INDEX_VERSION) throw new Error(`Unsupported ${name} schema version`);
        if (!enabled) {
          // 例如数据库由支持 FTS 的旧进程创建，但当前 SQLite 没有相应模块。
          // 停用依赖它的触发器并记录 dirty；以后能力恢复时会从原文重建，避免永久漏索引。
          this.setMeta(`${name}:dirty`, '1');
          continue;
        }
        const existed = Boolean(this.database.prepare('SELECT 1 FROM sqlite_schema WHERE type = ? AND name = ?').get('table', name));
        this.database.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING fts5(
          content, content='messages', content_rowid='id'${name === 'messages_fts_trigram' ? ", tokenize='trigram'" : ''}
        )`);
        const definition = String(this.database.prepare('SELECT sql FROM sqlite_schema WHERE name = ?').get(name)?.sql ?? '');
        if (!/^CREATE\s+VIRTUAL\s+TABLE\b/iu.test(definition) || !/USING\s+fts5\s*\(/iu.test(definition)
            || !/content\s*=\s*['"]messages['"]/iu.test(definition)
            || !/content_rowid\s*=\s*['"]id['"]/iu.test(definition)
            || (name === 'messages_fts_trigram' && !/tokenize\s*=\s*['"]trigram['"]/iu.test(definition))) {
          throw new Error(`Unexpected ${name} table definition; refusing to trust an incompatible index`);
        }
        indexes.push(name);
        if (!existed || version === undefined || this.meta(`${name}:dirty`) === '1') rebuild.push(name);
      }

      // 外部内容模式不自动同步原表。必须维护 INSERT/UPDATE/DELETE 三种情况。
      // 删除旧索引项时必须传 old.content；只删除 messages 原文会留下错误的倒排记录。
      this.database.exec(`
        DROP TRIGGER IF EXISTS messages_search_insert;
        DROP TRIGGER IF EXISTS messages_search_update;
        DROP TRIGGER IF EXISTS messages_search_delete;
      `);
      if (indexes.length) {
        const insert = indexes.map(name => `INSERT INTO ${name}(rowid, content) VALUES(new.id, new.content);`).join('\n');
        const remove = indexes.map(name => `INSERT INTO ${name}(${name}, rowid, content) VALUES('delete', old.id, old.content);`).join('\n');
        this.database.exec(`
          CREATE TRIGGER messages_search_insert AFTER INSERT ON messages BEGIN ${insert} END;
          CREATE TRIGGER messages_search_delete AFTER DELETE ON messages BEGIN ${remove} END;
          CREATE TRIGGER messages_search_update AFTER UPDATE OF id, content ON messages BEGIN ${remove} ${insert} END;
        `);
      }

      for (const name of indexes) {
        // 新索引不会自动包含安装触发器之前的历史。rebuild 只在首次/版本丢失/恢复能力时运行。
        if (rebuild.includes(name)) this.database.exec(`INSERT INTO ${name}(${name}) VALUES('rebuild')`);
        this.setMeta(`${name}:version`, INDEX_VERSION);
        this.setMeta(`${name}:dirty`, '0');
      }
      this.database.exec('RELEASE SAVEPOINT history_search_initialize');
    } catch (error) {
      this.database.exec('ROLLBACK TO SAVEPOINT history_search_initialize');
      this.database.exec('RELEASE SAVEPOINT history_search_initialize');
      throw error;
    }
  }

  private meta(key: string): string | undefined {
    const row = this.database.prepare('SELECT value FROM history_search_meta WHERE key = ?').get(key);
    return row ? String(row.value) : undefined;
  }

  private setMeta(key: string, value: string): void {
    this.database.prepare('INSERT INTO history_search_meta(key,value) VALUES(?,?) '
      + 'ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }

  /**
   * 选择一种可解释的召回路径，不把不同索引的 BM25 数字混在一起比较。
   * AND 优先找到同时命中的记录；只有零命中才放宽 OR，不让弱命中挤掉完整命中。
   */
  search(query: string, scope: string, limit = 5): MemoryHit[] {
    if (typeof query !== 'string' || query.length > 1000) throw new RangeError('Search query must be text of at most 1000 characters');
    if (typeof scope !== 'string' || !scope) throw new Error('History search scope is required');
    if (!Number.isSafeInteger(limit)) throw new RangeError('Search limit must be a safe integer');
    const text = query.trim();
    if (!text || limit <= 0) return [];
    const bound = Math.min(limit, 100);

    // 路径、调用 ID、标点、SQL/MATCH 特殊符号按完整字面子串搜索，不替用户执行查询语法。
    if (!ORDINARY_QUERY.test(text)) return this.like([text], scope, bound);
    const terms = [...new Set(text.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [])];
    if (terms.length > 32) throw new RangeError('Search query must contain at most 32 terms');
    if (!terms.length) return this.like([text], scope, bound);
    const cjk = terms.some(term => CJK.test(term));
    const supportsTrigrams = terms.every(term => Array.from(term).length >= 3);

    if (cjk) {
      if (this.available.trigram && supportsTrigrams) {
        const hits = this.fullText('messages_fts_trigram', terms, scope, bound);
        if (hits.length) return hits;
      }
      // 两字中文无法产生三字片段；无 trigram 时也仍能查原文。多词保持 AND，再有界放宽 OR。
      return this.like(terms, scope, bound);
    }
    if (this.available.fts5) {
      const hits = this.fullText('messages_fts', terms, scope, bound);
      if (hits.length) return hits;
    }
    // 单词索引不包含任意词内子串；零命中时才试 trigram，最后保留原文 LIKE 的可用性。
    if (this.available.trigram && supportsTrigrams) {
      const hits = this.fullText('messages_fts_trigram', terms, scope, bound);
      if (hits.length) return hits;
    }
    return this.like(terms, scope, bound);
  }

  private fullText(name: IndexName, terms: string[], scope: string, limit: number): MemoryHit[] {
    const source = name === 'messages_fts' ? 'fts5' : 'trigram';
    const run = (operator: 'AND' | 'OR'): MemoryHit[] => {
      const match = terms.map(quoteTerm).join(` ${operator} `);
      // 表名只来自上面的固定联合类型；用户值始终绑定参数。
      // bm25 越小越相关，SQLite 常返回负值；不能误用 DESC 把最差结果排在最前。
      // scope 在 LIMIT 之前过滤，不能“先查全库前几条，再到 JS 排除其他用户”。
      const rows = this.database.prepare(`
        SELECT m.id, m.session_id, m.content, m.created_at,
          json_extract(m.payload, '$.role') AS role, bm25(${name}) AS rank
        FROM ${name} JOIN messages m ON m.id = ${name}.rowid
          JOIN sessions s ON s.id = m.session_id
        WHERE ${name} MATCH ? AND s.scope = ?
        ORDER BY rank ASC, m.id DESC LIMIT ?
      `).all(match, scope, limit) as unknown as SearchRow[];
      return rows.map(row => toHit(row, source));
    };
    const all = run('AND');
    return all.length || terms.length === 1 ? all : run('OR');
  }

  private like(terms: string[], scope: string, limit: number): MemoryHit[] {
    const run = (operator: 'AND' | 'OR'): MemoryHit[] => {
      const conditions = terms.map(() => "m.content LIKE ? ESCAPE '\\'").join(` ${operator} `);
      const rows = this.database.prepare(`
        SELECT m.id, m.session_id, m.content, m.created_at, json_extract(m.payload, '$.role') AS role
        FROM messages m JOIN sessions s ON s.id = m.session_id
        WHERE s.scope = ? AND (${conditions}) ORDER BY m.id DESC LIMIT ?
      `).all(scope, ...terms.map(likePattern), limit) as unknown as SearchRow[];
      return rows.map(row => toHit(row, 'like'));
    };
    const all = run('AND');
    return all.length || terms.length === 1 ? all : run('OR');
  }
}
