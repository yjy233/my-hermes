# 运行、调试与验证

## 安装与离线起步

需要 Node.js 24+ 和 npm。运行时使用内置 node:sqlite，不需要单独安装 SQLite 包；部分 Node 24 版本可能显示实验性 API 警告，具体稳定性标记见 [Node 24 SQLite 文档](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)。

```sh
node --version
npm install
npm run typecheck
npm test
npm run build
npm run dev -- init
npm run check -- --all --mode reference
npm run dev -- demo --stage 1 --mode reference
npm run dev -- chat --message '/calc (2+3)*4' --trace
```

默认 DemoProvider 是确定性替身，支持 `/calc`、`/remember`、`/memory`、`/recall`、`/skill`。`/remember` 整篇替换目标记忆，合并信息应先读后写；交互中 `/new` 更新会话边界，`/quit` 退出。

构建产物入口是 `node dist/cli.js`，例如 `node dist/cli.js chat --message '/calc 2+2'`。构建同时复制内置技能到 dist/data/，不能只复制一个 cli.js 而遗漏其模块和资源。

## Profile 与配置

默认 profile 为当前目录的 `.hermes-lab/`。子命令的 `--home PATH` 优先于 `MY_HERMES_HOME`；config.json 使用 camelCase：

```json
{
  "mode": "reference",
  "provider": "demo",
  "model": "local-model",
  "baseUrl": "http://127.0.0.1:11434/v1",
  "maxSteps": 8,
  "contextChars": 24000,
  "turnTimeoutMs": 120000,
  "autoReflect": false,
  "plugins": []
}
```

命令行覆盖配置。修改后重启入口；已有会话仍保留原始提示快照，新会话读取最新记忆和 Skill 索引。插件配置路径相对 profile，命令行 --plugin 相对当前目录；密钥只放环境变量。

`check/demo` 也读取所选配置，mode 按 `--mode` → config.json → reference 决定；始终使用离线 Provider 和临时数据，不初始化日常 profile、不加载其中插件。配置为 learner 时，不带 --mode 的检查运行学习实现。

```sh
npm run dev -- doctor
npm run dev -- sessions
npm run dev -- history SESSION_ID
npm run dev -- skills list
npm run dev -- skills read study-notes
```

SESSION_ID 来自 sessions。`--trace` 将事件写入 profile 的 traces.jsonl，同时输出到标准错误；JSONL 回复留在标准输出。历史与长期记忆是本地明文。

chat/gateway 独占 profile 的 `.runtime.lock/`。崩溃残留需确认旧进程退出后手动删除锁目录，不能假定操作系统自动释放。具体步骤见 [Gateway](05-gateway.md)。

## TypeScript 断点

```sh
node --inspect-brk --import tsx src/cli.ts check --stage 1 --mode learner
node --inspect-brk --import tsx src/cli.ts chat --message '/calc (2+3)*4' --mode reference
```

附加 Chrome 的 Node 调试器或 VS Code 调试器，打开 src 下的 TypeScript 文件设置断点。--inspect-brk 先暂停入口，继续后才执行命令；可用 Source Map 对应源码，或在学习函数中暂时写 debugger 语句。

| 位置 | 观察什么 |
| --- | --- |
| `src/learning/exercises.ts` 的 `runLoop` | context 顺序、响应、工具结果与终止条件 |
| `src/core/tools.ts` 的 `ToolRegistry.execute` | schema、限时、错误 envelope、AbortSignal |
| `src/core/agent.ts` | 提示快照、预算、完整轮次持久化 |
| `src/memory/store.ts` 的 `appendMessages` | assistant/tool ID 往返 |
| `src/gateway/router.ts` 的 `Gateway.handle` | 授权、队列、去重、取消 |
| `src/evolution/manager.ts` 的 `approve` | 候选状态与写入 Skill |

## 连接器

```sh
npm run dev -- gateway --connector jsonl --allow-user learner < examples/messages.jsonl
```

重复事件应返回 cached=true；验证新执行时更换 eventId。HTTP 启动、camelCase 请求 JSON、curl 与恢复步骤见 [Gateway 文档](05-gateway.md)。服务只用于 loopback 调试，需配置 MY_HERMES_GATEWAY_TOKEN 和 --allow-user。

## 真实模型

```sh
npm run dev -- chat --provider compatible --model local-model \
  --base-url http://127.0.0.1:11434/v1 --message '请计算 (2+3)*4' --trace
```

服务须支持 Chat Completions、function tools 与 tool 消息。base URL 包含 /v1、不包含 /chat/completions，入口追加路径；模型名称改成实际服务名称。远程凭证放在 MY_HERMES_API_KEY 或 OPENAI_API_KEY，本地服务可按需不设。

Provider 使用内置 fetch 与 AbortSignal，统一转换内部 camelCase 消息和 API wire 字段，限制响应长度并隐藏远端错误正文。本仓库验收使用离线与本机协议测试，未用真实厂商凭证调用在线模型；兼容接口不保证每个服务的所有细节一致。

## 验证与排查

```sh
npm run typecheck
npm test
npm run check -- --all --mode reference
npm run build
```

完成练习后再运行 `npm run check -- --all --mode learner`。阶段检查只覆盖小契约；测试覆盖基础设施和参考实现，不替代学习者自己的边界案例。

| 现象 | 首先检查 |
| --- | --- |
| ExerciseNotImplemented | 当前 mode 与 L1～L5，实现练习或显式切 reference |
| ContextBudgetExceeded | system、最新完整轮、工具 schema 总预算 |
| 工具 ok=false | error/message、参数和目标，不能当成成功事实 |
| 同 eventId 冲突 | 是否把旧 ID 用在新正文上 |
| 旧会话记忆未变 | 快照是设计行为，用读取工具检查即时值或 /new |
| 新 Skill 不在索引 | 是否批准、名称是否冲突、是否新建会话 |
| 修改插件未生效 | Node import 缓存，重启入口 |
| Profile lock 错误 | 旧实例是否仍运行，或崩溃残留目录；先核实再恢复 |
| HTTP 超时后重试 | 副作用可能发生，先检查实际结果，不保证回滚 |
| node:sqlite 警告 | 区分运行时实验性 API 警告与应用失败，检查 Node 版本 |
