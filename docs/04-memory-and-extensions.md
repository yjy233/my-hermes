# 记忆、Skills、Plugin 与自进化

## 记忆的三个层次

- 短期上下文由 `compactHistory` 决定，只影响下一次模型请求，不删改原始记录。
- 会话历史由 `node:sqlite` 存在 profile 的 `sessions.db` 中；成功轮次完整保留 assistant/tool 调用关系。检索是按 scope 过滤的 SQLite LIKE 子串匹配，`%`、`_` 按普通字符处理，未实现上游 FTS5 或向量检索。
- 长期记忆位于 `memory/<sha256(scope)>/MEMORY.md` 和 `USER.md`；每文件默认 4000 字符，临时文件写入后原子替换。超限报错，不静默截断，人工编辑同样受读取预算检查。

scope 由入口生成，模型不能替换。Gateway 使用 `[channel,userId]` 的规范 JSON，同渠道同用户跨会话共享长期记忆，不同渠道或用户隔离。`SessionStore.getOrCreate` 拒绝把已有 session key 迁移到另一个 scope。

`SessionStore` 提供 `getOrCreate`、`setSystemPrompt`、`loadMessages`、`appendMessages`、`search`、`listSessions`、`close`。系统提示在新会话第一次运行时固定；记忆写入后，工具读取可见实时值，新会话才读取新快照。Node 24 的 `node:sqlite` 可能发出实验性 API 警告。

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
