/** 候选召回用真实 SQLite/FTS5 验证，不把 LIKE 或内存数组伪装成全文索引。 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { HistorySearch } from '../src/memory/history-search.js';
import type { Message } from '../src/core/models.js';

function schema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE sessions(id TEXT PRIMARY KEY, scope TEXT NOT NULL);
    CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id), payload TEXT NOT NULL, content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX messages_session ON messages(session_id,id);
    CREATE INDEX sessions_scope ON sessions(scope);
    INSERT INTO sessions(id,scope) VALUES('alice-1','alice'),('alice-2','alice'),('bob-1','bob');
  `);
}

function add(database: DatabaseSync, content: string, sessionId = 'alice-1', role: Message['role'] = 'user'): number {
  return Number(database.prepare('INSERT INTO messages(session_id,payload,content) VALUES(?,?,?)')
    .run(sessionId, JSON.stringify({ role, content }), content).lastInsertRowid);
}

function fixture(t: TestContext) {
  const database = new DatabaseSync(':memory:');
  schema(database);
  t.after(() => database.close());
  return database;
}

test('FTS5 按词 AND 召回不同顺序的词，零命中才 OR 放宽，结果带原文消息定位', t => {
  const db = fixture(t), search = new HistorySearch(db);
  const both = add(db, 'memory implementation in TypeScript');
  add(db, 'only TypeScript');
  add(db, 'only memory', 'alice-2');
  assert.deepEqual(search.capabilities(), { fts5: true, trigram: true });
  const hits = search.search('TypeScript memory', 'alice', 10);
  assert.deepEqual(hits.map(hit => hit.messageId), [both]);
  assert.equal(hits[0].source, 'fts5');
  assert.equal(hits[0].content, 'memory implementation in TypeScript');
  assert.equal(hits[0].role, 'user');
  assert.ok(hits[0].createdAt);
  assert.equal(hits[0].score, 1);
  assert.ok(Number.isFinite(hits[0].rank));
  assert.ok(search.search('TypeScript missingword', 'alice', 10).some(hit => hit.messageId === both));
});

test('BM25 小值优先，完整原文不裁剪，同分按较新 messageId 稳定排序', t => {
  const db = fixture(t), search = new HistorySearch(db);
  const unrelated = Array.from({ length: 100 }, (_, index) => `filler${index}`).join(' ');
  add(db, `${unrelated} uniquequery ${unrelated}`);
  const first = add(db, 'uniquequery uniquequery');
  const latest = add(db, 'uniquequery uniquequery', 'alice-2', 'assistant');
  const hits = search.search('uniquequery', 'alice', 10);
  assert.deepEqual(hits.slice(0, 2).map(hit => hit.messageId), [latest, first]);
  assert.ok(hits[0].rank! < hits.at(-1)!.rank!);
  assert.ok(hits[0].rank! < 0, 'SQLite BM25 的负值不是错误，也不能排序反了');
  const original = 'longresult ' + '完整工具正文'.repeat(3000);
  const longId = add(db, original, 'alice-1', 'tool');
  const longHit = search.search('longresult', 'alice', 1)[0];
  assert.equal(longHit.messageId, longId);
  assert.equal(longHit.content, original);
  assert.equal(longHit.role, 'tool');
});

test('中文三字以上用 trigram 查词内片段，两字中文回退 LIKE，混合短词仍能召回', t => {
  const db = fixture(t), search = new HistorySearch(db);
  const id = add(db, '本项目用 TS 实现长期记忆系统及跨会话召回。');
  assert.equal(search.search('长期记忆', 'alice')[0]?.messageId, id);
  assert.equal(search.search('长期记忆', 'alice')[0]?.source, 'trigram');
  assert.equal(search.search('记忆', 'alice')[0]?.messageId, id);
  assert.equal(search.search('记忆', 'alice')[0]?.source, 'like');
  assert.equal(search.search('TS 长期记忆', 'alice')[0]?.messageId, id);
  assert.equal(search.search('TS 长期记忆', 'alice')[0]?.source, 'like');
  assert.equal(search.search('跨会话', 'alice')[0]?.source, 'trigram');
});

test('ASCII 词的零命中可以用 trigram 找到词内子串', t => {
  const db = fixture(t), search = new HistorySearch(db);
  const id = add(db, 'A superlongidentifier appears here.');
  const hits = search.search('longidentifier', 'alice');
  assert.equal(hits[0]?.messageId, id);
  assert.equal(hits[0]?.source, 'trigram');
});

test('普通词和符号查询分别防止 MATCH 操作符与 SQL 通配符被当成语法', t => {
  const db = fixture(t), search = new HistorySearch(db);
  const syntax = add(db, 'alpha OR beta NOT gamma');
  const symbol = add(db, 'literal 100%_done C:\\temp\\file archive-key');
  add(db, 'alpha beta gamma 100XXdone archive key');
  assert.deepEqual(search.search('alpha OR beta', 'alice').map(hit => hit.messageId), [syntax]);
  for (const query of ['%_', 'C:\\temp\\file', 'archive-key']) {
    assert.deepEqual(search.search(query, 'alice').map(hit => hit.messageId), [symbol]);
    assert.equal(search.search(query, 'alice')[0].source, 'like');
  }
  assert.deepEqual(search.search("' OR 1=1 --", 'alice'), []);
  assert.deepEqual(search.search('" OR * NOT "', 'alice'), []);
  assert.deepEqual(search.search('100%_', 'nobody'), []);
});

test('scope 在 LIMIT 前过滤，其他用户即使更相关也不能挤掉当前用户', t => {
  const db = fixture(t), search = new HistorySearch(db);
  const alice = add(db, 'shared query relevant to Alice');
  for (let index = 0; index < 20; index++) add(db, 'shared query shared query', 'bob-1');
  assert.deepEqual(search.search('shared query', 'alice', 1).map(hit => hit.messageId), [alice]);
  assert.ok(search.search('shared query', 'bob', 100).every(hit => hit.sessionId === 'bob-1'));
  assert.deepEqual(search.search('shared query', 'unknown'), []);
});

test('首次索引安装回填旧库，重新打开不对全部历史重复 rebuild，丢失单个索引可重建', t => {
  const root = mkdtempSync(join(tmpdir(), 'hermes-search-migration-'));
  const path = join(root, 'old.db');
  let db = new DatabaseSync(path);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  schema(db);
  const first = add(db, 'legacy original record');
  for (let index = 0; index < 500; index++) add(db, `historical record ${index}`);
  const initial = new HistorySearch(db);
  assert.equal(initial.search('legacy', 'alice')[0]?.messageId, first);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get()?.n, 501);
  db.close(); db = new DatabaseSync(path);
  const before = Number(db.prepare('SELECT total_changes() AS n').get()?.n);
  const reopened = new HistorySearch(db);
  const changes = Number(db.prepare('SELECT total_changes() AS n').get()?.n) - before;
  assert.ok(changes < 100, '初始化只触及固定元数据，不能每次重建几百条历史的索引');
  assert.equal(reopened.search('legacy', 'alice')[0]?.messageId, first);
  db.exec('DROP TABLE messages_fts_trigram');
  const repaired = new HistorySearch(db);
  const chinese = add(db, '测试长期记忆内容');
  assert.equal(repaired.search('长期记忆', 'alice')[0]?.messageId, chinese);
});

test('INSERT/UPDATE/DELETE 原文触发器同步两种索引，rollback同时撤销索引变化', t => {
  const db = fixture(t), search = new HistorySearch(db);
  const id = add(db, 'oldword 旧的长期记忆');
  assert.equal(search.search('oldword', 'alice')[0]?.messageId, id);
  const updated = 'newword 新的跨会话记忆';
  db.prepare('UPDATE messages SET content=?,payload=? WHERE id=?')
    .run(updated, JSON.stringify({ role: 'assistant', content: updated }), id);
  assert.deepEqual(search.search('oldword', 'alice'), []);
  assert.equal(search.search('newword', 'alice')[0]?.messageId, id);
  assert.equal(search.search('跨会话记忆', 'alice')[0]?.messageId, id);
  db.exec('BEGIN');
  add(db, 'transientmarker 临时记录');
  assert.equal(search.search('transientmarker', 'alice').length, 1);
  db.exec('ROLLBACK');
  assert.deepEqual(search.search('transientmarker', 'alice'), []);
  db.prepare('DELETE FROM messages WHERE id=?').run(id);
  assert.deepEqual(search.search('newword', 'alice'), []);
  assert.deepEqual(search.search('跨会话记忆', 'alice'), []);
  db.exec("INSERT INTO messages_fts(messages_fts,rank) VALUES('integrity-check',1)");
  db.exec("INSERT INTO messages_fts_trigram(messages_fts_trigram,rank) VALUES('integrity-check',1)");
});

test('显式 LIKE/禁用 trigram 路由仍维护可用索引，恢复正常查询不会漏掉新消息', t => {
  const db = fixture(t);
  const fallback = new HistorySearch(db, { forceLike: true });
  assert.deepEqual(fallback.capabilities(), { fts5: false, trigram: false });
  const id = add(db, 'TypeScript memory 长期记忆');
  assert.equal(fallback.search('memory TypeScript', 'alice')[0]?.messageId, id);
  assert.equal(fallback.search('memory TypeScript', 'alice')[0]?.source, 'like');
  const noTrigram = new HistorySearch(db, { disableTrigram: true });
  assert.equal(noTrigram.search('长期记忆', 'alice')[0]?.source, 'like');
  assert.equal(noTrigram.search('TypeScript', 'alice')[0]?.source, 'fts5');
  const restored = new HistorySearch(db);
  assert.equal(restored.search('长期记忆', 'alice')[0]?.source, 'trigram');
  assert.equal(restored.search('TypeScript', 'alice')[0]?.messageId, id);
});

test('缺失 FTS 模块时可以读写原文；恢复模块后 dirty 索引重建补齐停用期间记录', t => {
  const db = fixture(t);
  new HistorySearch(db);
  add(db, 'beforemodule record');
  const exec = db.exec.bind(db);
  const mock = t.mock.method(db, 'exec', (sql: string) => {
    if (sql.startsWith('CREATE VIRTUAL TABLE temp.history_fts_probe')) throw new Error('no such module: fts5');
    return exec(sql);
  });
  const unavailable = new HistorySearch(db);
  assert.equal(unavailable.capabilities().fts5, false);
  const id = add(db, 'duringmodule record');
  assert.equal(unavailable.search('duringmodule', 'alice')[0]?.messageId, id);
  assert.equal(unavailable.search('duringmodule', 'alice')[0]?.source, 'like');
  mock.mock.restore();
  const restored = new HistorySearch(db);
  assert.equal(restored.search('duringmodule', 'alice')[0]?.messageId, id);
  assert.equal(restored.search('duringmodule', 'alice')[0]?.source, 'fts5');
});

test('只有 trigram 分词器缺失时仍使用英文 FTS，中文回退且恢复后补齐索引', t => {
  const db = fixture(t);
  new HistorySearch(db);
  const exec = db.exec.bind(db);
  const mock = t.mock.method(db, 'exec', (sql: string) => {
    if (sql.startsWith('CREATE VIRTUAL TABLE temp.history_trigram_probe')) throw new Error('no such tokenizer: trigram');
    return exec(sql);
  });
  const degraded = new HistorySearch(db);
  assert.deepEqual(degraded.capabilities(), { fts5: true, trigram: false });
  const id = add(db, 'survivingindex 独立分词器降级');
  assert.equal(degraded.search('survivingindex', 'alice')[0]?.source, 'fts5');
  assert.equal(degraded.search('独立分词器', 'alice')[0]?.source, 'like');
  mock.mock.restore();
  const restored = new HistorySearch(db);
  assert.equal(restored.search('独立分词器', 'alice')[0]?.source, 'trigram');
  assert.equal(restored.search('独立分词器', 'alice')[0]?.messageId, id);
});

test('已经启用的全文查询发生数据库错误时保留错误，不悄悄改走 LIKE', t => {
  const db = fixture(t), search = new HistorySearch(db);
  add(db, 'visiblequery record');
  const prepare = db.prepare.bind(db);
  const mock = t.mock.method(db, 'prepare', (sql: string) => {
    if (sql.includes('WHERE messages_fts MATCH')) throw new Error('database disk image is malformed');
    return prepare(sql);
  });
  assert.throws(() => search.search('visiblequery', 'alice'), /database disk image is malformed/);
  mock.mock.restore();
  assert.equal(search.search('visiblequery', 'alice')[0]?.source, 'fts5');
});

test('损坏、锁和未知 schema 不能被默认为模块不可用后静默降级', t => {
  const db = fixture(t);
  const mock = t.mock.method(db, 'exec', () => { throw new Error('database is locked'); });
  assert.throws(() => new HistorySearch(db), /database is locked/);
  mock.mock.restore();
  db.exec('CREATE TABLE messages_fts(content TEXT, messages_fts TEXT)');
  assert.throws(() => new HistorySearch(db), /Unexpected messages_fts table definition/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='history_search_meta'").get()?.n, 0,
    '初始化失败时元数据和触发器不能留下半套提交');
  db.exec('DROP TABLE messages_fts');
  new HistorySearch(db);
  db.prepare("UPDATE history_search_meta SET value='999' WHERE key='messages_fts:version'").run();
  assert.throws(() => new HistorySearch(db), /Unsupported messages_fts schema version/);
});

test('检索输入有界，非法limit明确报错，非正limit和空查询不召回', t => {
  const db = fixture(t), search = new HistorySearch(db);
  add(db, 'ordinary record');
  for (const limit of [NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => search.search('ordinary', 'alice', limit), RangeError);
  }
  for (const limit of [0, -1]) assert.deepEqual(search.search('ordinary', 'alice', limit), []);
  assert.deepEqual(search.search(' \n ', 'alice'), []);
  assert.throws(() => search.search('x'.repeat(1001), 'alice'), RangeError);
  assert.throws(() => search.search(Array.from({ length: 33 }, (_, i) => `word${i}`).join(' '), 'alice'), RangeError);
  assert.throws(() => search.search('ordinary', ''), /scope/);
  const first = search.capabilities(); first.fts5 = false;
  assert.equal(search.capabilities().fts5, true, '返回能力副本，调用方不能改坏内部路由');
});
