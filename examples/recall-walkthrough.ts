/**
 * L3 离线教学：用可预测的 Provider 决策，走真实 learner 工具循环和 SQLite。
 * 运行 npm run learn:recall。这里不加载配置/.env，不发网络请求，也不改日常 profile。
 *
 * 先读本文件，再在 runLoop / history-tools / HistorySearch.search / selectMemories 下断点。
 * Provider 只代替模型“决定下一步”，查库、排序、消息追加都运行项目的真实实现。
 */
import assert from 'node:assert/strict';
import { SessionStore, type HistoryPage, type MemoryHit } from '../src/memory/store.js';
import { registerHistoryTools } from '../src/core/history-tools.js';
import { ToolRegistry } from '../src/core/tools.js';
import type { Message, Provider } from '../src/core/models.js';
import { loadAlgorithms } from '../src/learning/index.js';

const store = new SessionStore(':memory:');
try {
  // 1. 模拟一个旧会话，以及另一个用户的私有记录。全文索引由写入触发器同步。
  const old = store.getOrCreate('old-task', 'alice'), foreign = store.getOrCreate('bob-task', 'bob');
  store.appendMessages(old.id, [
    { role: 'user', content: '前提：这是本地部署，先保留日志。' },
    // 故意把 memory 放在 TypeScript 前面：整段 LIKE("TypeScript memory") 查不到。
    { role: 'assistant', content: 'memory implementation uses TypeScript，验证编号 B-42，原样标记 100%_done。' },
    { role: 'user', content: '下一步：检查日志，确认 B-42 后再发布。' },
  ]);
  store.appendMessages(foreign.id, [{ role: 'user', content: 'TypeScript memory PRIVATE_BOB' }]);
  const algorithms = loadAlgorithms('learner'), registry = new ToolRegistry();
  registerHistoryTools(registry, store, 'alice', algorithms);
  console.log('① 准备原始历史与索引：', store.searchCapabilities());

  let requests = 0;
  const provider: Provider = { async complete(messages) {
    requests++;
    if (requests === 1) {
      console.log('② 模型第1次请求：决定调用 history_search("TypeScript memory")');
      return { content: '', toolCalls: [{ id: 'search-1', name: 'history_search', arguments: { query: 'TypeScript memory' } }] };
    }
    // 2. runLoop 已把工具结果作为 role:tool 消息追加，这一次 complete 才能看见它。
    const observation = messages.at(-1)!;
    assert.equal(observation.role, 'tool');
    const payload = JSON.parse(observation.content);
    assert.equal(payload.ok, true);
    if (requests === 2) {
      const hit = (payload.result as MemoryHit[])[0];
      assert.equal(hit.sessionId, old.id); assert.ok(hit.messageId);
      console.log('③ 模型第2次请求：已收到搜索结果', {
        source: hit.source, messageId: hit.messageId, rank: hit.rank, content: hit.content,
      });
      console.log('④ 模型决定调用 history_read：围绕命中消息读取3条原文');
      return { content: '', toolCalls: [{ id: 'read-1', name: 'history_read', arguments: {
        session_id: hit.sessionId, around_message_id: hit.messageId, limit: 3,
      } }] };
    }
    // 3. 检索结果是历史数据。此处模拟模型引用内容答复，不把它当新的系统指令。
    assert.equal(requests, 3);
    const page = payload.result as HistoryPage;
    console.log('⑤ 模型第3次请求：已收到原文窗口');
    for (const row of page.messages) console.log(`   [${row.id}] ${row.message.role}: ${row.message.content}`);
    assert.equal(page.messages.length, 3);
    assert.ok(!JSON.stringify(page).includes('PRIVATE_BOB'));
    return { content: '编号是 B-42。前提是本地部署并保留日志；核对日志后再发布。' };
  } };
  const input: Message[] = [{ role: 'system', content: '需要历史事实时先搜索，再按锚点读原文。' },
    { role: 'user', content: '之前 TypeScript memory 的验证编号是什么？结合前后要求回答。' }];
  const delta = await algorithms.runLoop(provider, registry, input, 4, () => {});
  console.log('⑥ 最终答复：', delta.at(-1)!.content);
  console.log('本轮新增消息：', delta.map(row => row.role).join(' → '));
  assert.equal(requests, 3);
  assert.equal(store.loadMessages(old.id).length, 3, '查询不能改写原始历史');

  // 4. 补充观察候选层的不同路径。这里直接调用库 API，便于在 search 中看 SQL 分支。
  console.log('\n补充观察：中文、符号与 ID 分页');
  for (const query of ['验证编号', '编号', '%_']) {
    console.log(`查询 ${JSON.stringify(query)} →`, store.search(query, 'alice').map(hit => ({
      source: hit.source, messageId: hit.messageId,
    })));
  }
  const first = store.readHistory(old.id, 'alice', { limit: 2 });
  const second = store.readHistory(old.id, 'alice', { afterMessageId: first.afterCursor, limit: 2 });
  console.log('第1页 IDs：', first.messages.map(row => row.id), '下一页 IDs：', second.messages.map(row => row.id));
} finally { store.close(); }
