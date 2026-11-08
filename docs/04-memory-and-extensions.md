# 记忆、Skills、Plugin 与自进化

本篇介绍本项目接口。需要系统理解 Hermes 与本项目的对应关系时，先读 [记忆系统图解](09-memory-system-guide.md)；数据库表、索引和迁移清单见 [记忆存储参考](10-memory-storage-reference.md)。L3 的逐步调试、搜索与读取示例见 [历史检索教程](11-l3-history-retrieval.md)。

## 记忆的三个层次

- 短期上下文默认由选定的 L2 `compactHistory` 异步清理并摘要，`ContextCompressor` 提供运行环境，工作上下文和冷却状态单独持久化；关闭后使用辅助函数 `trimHistory` 整轮裁剪。两种方式都不删改原始记录，详见 [上下文压缩](08-context-compression.md)。
- 会话历史由 `node:sqlite` 存在 profile 的 `sessions.db` 中；成功轮次完整保留 assistant/tool 调用关系。按 scope 过滤后，使用 FTS5 默认 `unicode61` 词索引、`trigram` 子串索引或字面 LIKE 回退召回原文；`%`、`_` 按普通字符处理。FTS 是关键词倒排索引，没有 embedding 或向量检索。
- 长期记忆位于 `memory/<sha256(scope)>/MEMORY.md` 和 `USER.md`；每文件默认 4000 字符，临时文件写入后原子替换。超限报错，不静默截断，人工编辑同样受读取预算检查。

scope 由入口生成，模型不能替换。Gateway 使用 `[channel,userId]` 的规范 JSON，同渠道同用户跨会话共享长期记忆，不同渠道或用户隔离。`SessionStore.getOrCreate` 拒绝把已有 session key 迁移到另一个 scope。

`SessionStore` 提供 `getOrCreate`、`setSystemPrompt`、`loadMessages`、`appendMessages`、`search`、`searchCapabilities`、`readHistory`、`listSessions`、`close`。系统提示在新会话第一次运行时固定；记忆写入后，工具读取可见实时值，新会话才读取新快照。Node 24 的 `node:sqlite` 可能发出实验性 API 警告。

## 磁盘存储与历史召回

默认 profile 为项目目录下的 `.hermes-lab/`；`--home` 或 `MY_HERMES_HOME` 可指定其他位置。记忆不统一存成 JSONL：

| 文件 | 内容 |
| --- | --- |
| `sessions.db` | SQLite：`sessions` 保存会话与固定系统提示；`messages` 保存成功轮次原文与稳定 ID；两张 FTS 虚拟表按运行时能力建立关键词/子串索引，`history_search_meta` 记录索引版本和重建状态；`context_checkpoints` 保存默认链路的工作上下文与冷却状态；`summary_checkpoints` 保存可选检查点引擎的摘要、覆盖数与代际 |
| `memory/<sha256(scope)>/MEMORY.md`、`USER.md` | 精选事实、偏好及用户资料，独立于对话摘要 |
| `skills/<name>/SKILL.md` | 经审核的可复用流程；待审候选另存于 `proposals/*.json` |
| `traces.jsonl` | 启用 chat/gateway 的 `--trace` 后追加的诊断事件，不是完整会话或记忆数据库 |

JSONL 连接器则是按行传递输入事件和输出回复的协议，不承担记忆持久化。

L3 `selectMemories` 已在 learner 实现，运行链路是 `history_search → SessionStore.search → 所选模式的 selectMemories → 工具结果 → 下一次模型请求`。需要上下文时，模型再调用 `history_read`：

1. 入口绑定 scope，工具只接受 query，不能指定另一个用户或渠道。查询覆盖该 profile 中同 scope 的所有 session，包含当前会话。
2. SQLite 从完整 `messages` 表召回最多 20 条候选，不查询压缩摘要。英文等词项优先走 `messages_fts` 的词索引；足够长的中文片段走 `messages_fts_trigram`，短中文、路径、符号等走字面 LIKE。多词先要求全部命中，零命中后才放宽为任一词命中。索引不可用时保留字面回退，数据库锁、损坏等真实错误继续上报。用户输入不会作为 SQL 或 MATCH 操作符执行。
3. 工具另外合并当前轮已执行工具的原文，排除 `history_search` 与 `history_read` 自身结果，避免递归扩张。临时候选按完整 query 的字面子串匹配，较新的在前；它们可以补回本轮已经清理或摘要、尚未入库的输出，`source` 为 `live`，暂时没有持久 `messageId`。
4. L3 按去重后的查询词项覆盖数排序，忽略大小写；重复词不额外加分。词项同分时 live 优先；同一 FTS 来源内使用 BM25 `rank` 升序，数值越小越相关，负值也一样。不同来源的 rank 不直接比较，其余保持原序，不把兼容字段 `score` 当作统一相关度。用 `sessionId + messageId` 去重后最多返回 5 条，不按相同正文合并不同经历，不修改候选或原始分数。
5. 已持久命中包含 `sessionId`、`messageId`、`role`、`createdAt`、`source` 和原文；FTS 来源另带 `rank`。工具预算不足时只缩短正文预览，保留结构化字段，使用 `contentTruncated/originalContentChars` 标出省略。模型可拿锚点继续调用 `history_read`，不用从截断的字符串里猜 ID。
6. 空查询或无匹配返回空数组，数据库错误由工具框架包装成 `ok: false`，不会伪装成没有记录。FTS 与 trigram 都不自动把整句自然语言改写为语义检索；模型应挑选关键词，并通过原文窗口核对结果。

`history_read` 要求 `session_id`，最多选择一种锚点：`around_message_id` 读取周边窗口、`before_message_id` 读取更早页、`after_message_id` 读取更晚页。`limit` 默认 10，范围 1～50；返回消息始终按 ID 升序，并提供 `hasBefore/hasAfter`、`beforeCursor/afterCursor`。这是按稳定 ID 的 keyset 分页，不按数组下标或 SQL OFFSET 翻页；同一会话的消息 ID 可以不连续。

长正文可用 `around_message_id + limit: 1 + content_offset` 续读，`content_chars` 默认 2000、范围 1～6000。按响应中的 `nextContentOffset` 请求下一段；offset 按 JavaScript UTF-16 字符单位计数，不能切开代理对。窗口只返回历史数据，旧工具参数与 reasoning 不会作为新指令重放给模型；完整协议字段仍保留在数据库及 `readHistory` 库 API 中。目标会话必须属于当前 scope，锚点还必须属于该会话。

历史原文在模型主动调用工具后进入下一次请求。离线 Demo 的 `/recall 关键词` 演示搜索；`npm run learn:recall` 演示搜索、窗口与翻页，[L3 教程](11-l3-history-retrieval.md) 讲解具体断点。`npm run dev -- check --stage 2 --mode learner` 运行 26 项 L2/L3 验收；完整 learner CLI 聊天仍需实现 L4 路由。`tests/recall.test.ts` 保留原有压缩、重启与隔离回归，新增 `tests/history-search.test.ts`、`tests/l3-ranking.test.ts` 和 `tests/recall-upgrade.test.ts` 覆盖候选索引、排序和搜索后读取的链路。

## 长期记忆条目与整理

`memory` 工具用 `target: "memory"` 或 `"user"` 选择环境事实或用户偏好；文件路径仍由 scope 决定。`operations` 是同一目标的一批操作：`add(content)` 新增条目，`patch(old_text, content)` 替换唯一片段，`remove(old_text)` 删除唯一匹配的整条记录。条目以单独一行 `§` 分隔，精确重复的新增不会挤占容量。

存储层先在内存中演算整批操作，最后检查总容量，再原子写入一次。定位歧义、缺少条目或最终超容量时，整个批次不写入；错误提供当前条目、容量和需要腾出的空间，让模型把合并旧事实与新增事实放到同一批重试。它不自动丢弃仍有效的事实，也不声称通过文本匹配解决事实冲突。

压缩前的可选记忆整理只开放 `memory` 工具，最多两次模型请求；保存稳定偏好、项目约定和环境事实，跳过凭证、原始日志、临时状态与整段推理。摘要用于接续当前任务，不能整篇灌入长期记忆。记忆工具写入是已经发生的副作用，后续主任务失败或取消不保证撤销；SQLite 成功轮次与压缩工作上下文则仍按事务规则提交。详见 [上下文压缩](08-context-compression.md#压缩前整理长期记忆)。

`memory_read` / `memory_write` 保留兼容；Demo 的 `/remember` 仍演示整篇替换。工具读取能立即看到新值，当前会话的 system 快照保持冻结，新会话才注入新值。

## Skill 渐进加载

`SkillCatalog(roots)` 扫描下一层 `*/SKILL.md`，支持单行 frontmatter；`discover()` 刷新、`index()` 返回名称/描述、`read(name)` 按需读正文。单文件上限 32000 字节，重复名称、软链目录和越界路径会被拒绝。

```markdown
---
name: my-study-notes
description: 将学习材料整理为概念、例子和自测题。
---

# 学习流程

1. 说明适用场景。
2. 按步骤处理材料。
3. 用一个案例验证结果。
```

内置技能在 `src/data/skills/`，构建时复制到 `dist/data/`；个人技能放 profile 的 `skills/`。新会话刷新目录，发现刚批准的内容；已有会话保留原系统提示。Skill 是知识输入，阅读它不会自动执行其中脚本，也不会安装 Plugin。

## Plugin 显式加载

插件是可信 TypeScript / JavaScript 模块。`await new PluginManager(registry).load(paths)` 只加载显式入口；模块导出 `register(context)`，可同步完成或返回 Promise。context 提供 `registerTool(tool)` 和 `on(event, handler)`。

工具使用统一 Registry：`name/description/parameters/handler`，handler 接收 `(args, { signal })`。schema 使用本版支持的 JSON Schema 子集，参数先校验再执行；异步操作应使用 signal。观察 Hook 必须同步，收到独立 payload；错误被隔离，不能改变已保存答复。事件适合观察与统计，不承担必须成功的业务写入。

```sh
npm run dev -- chat --plugin ./examples/plugins/word-count.ts
```

配置文件的 `plugins` 数组以 profile 目录为相对基准；命令行 `--plugin` 相对当前目录。tsx 开发入口可加载 `.ts` 示例；运行构建产物时使用编译后的 `.js` 插件。

Node 使用稳定文件 URL 缓存 ESM 模块，同一路径不会每轮重新执行顶层代码。每个新 Registry 仍调用 register，获得独立注册上下文；注册失败不提交半套工具和 Hook。修改插件源码或修复顶层 import 失败后需重启进程，不通过不断变更 URL 来绕过缓存。

Plugin 拥有当前 Node 进程权限，这些注册接口不是沙箱。同步阻塞会阻塞事件循环，AbortSignal 不能中断任意同步代码；不要把不可信下载模块直接放入 plugins。

## 自进化闭环

`EvolutionManager.propose(sessionId, content)` 写入 `proposals/<id>.json`，状态 pending；`listProposals()` 用于审阅；本地 `approve(id, name, description)` 提升到 `skills/<name>/SKILL.md` 并写 approved 状态。候选不提前进入索引，提升保留来源信息。

参考反思只为成功工具流程生成保守建议，默认不复制私密参数。请实际阅读正文后批准；框架拒绝重名覆盖和重复批准，不自动修改源码、权重或现有技能。候选是可审核的程序性知识草稿，不代表已通过效果评测。

## 调试建议

1. 在 `SessionStore.appendMessages` 检查调用 ID 与结果配对。
2. 修改 USER.md，对比旧会话和新会话的系统提示。
3. 在 `SkillCatalog.read` 确认正文按需载入。
4. 让插件重复注册工具，观察初始化直接报错。
5. 对比待审和批准后的索引，确认模型没有批准接口。

运行 `npm test` 验证持久化、隔离、路径边界、扩展注册和审核；`npm run dev -- check --stage 4` / `--stage 5 --mode reference` 可单独检查扩展与自进化闭环。

构建时还会将示例插件编译到 `dist/examples/plugins/word-count.js`，可直接供编译后的 CLI 加载。使用已安装 npm 包时，选择这个 JavaScript 入口；Node 不会对 `node_modules` 内的 TypeScript 文件执行内置类型擦除。仓库开发流程仍使用 `examples/plugins/word-count.ts`。
