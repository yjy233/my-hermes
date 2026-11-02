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
npm run dev -- chat --provider demo --mode reference --message '/calc (2+3)*4' --trace
```

上述命令显式选择 DemoProvider，不受本地 profile 是否已配置 Kimi 影响。Demo 是确定性替身，支持 `/calc`、`/remember`、`/memory`、`/recall`、`/skill`。`/remember` 整篇替换目标记忆，合并信息应先读后写；交互中 `/new` 更新会话边界，`/quit` 退出。

构建产物入口是 `node dist/cli.js`，例如 `node dist/cli.js chat --provider demo --mode reference --message '/calc 2+2'`。构建同时复制内置技能到 dist/data/，不能只复制一个 cli.js 而遗漏其模块和资源。

## Profile 与配置

默认 profile 为当前目录的 `.hermes-lab/`。子命令的 `--home PATH` 优先于 `MY_HERMES_HOME`；config.json 使用 camelCase：

```json
{
  "mode": "reference",
  "providerMode": "learner",
  "provider": "demo",
  "model": "local-model",
  "baseUrl": "http://127.0.0.1:11434/v1",
  "maxSteps": 8,
  "contextChars": 24000,
  "turnTimeoutMs": 120000,
  "providerTimeoutMs": 30000,
  "autoReflect": false,
  "plugins": []
}
```

命令行覆盖配置。mode 控制 Core 算法，providerMode 独立选择 Kimi 的已完成主实现 learner 或对照版 reference；provider 可为 demo、compatible 或 kimi。providerTimeoutMs 控制每次模型请求，turnTimeoutMs 控制整个回合。Kimi 示例配置使用 60000 ms 请求超时、180000 ms 回合超时与 64000 字符上下文，见 [kimi.json](../examples/config/kimi.json)。已有配置不会被初始化覆盖。

修改配置后重启入口；已有会话仍保留提示快照，新会话读取最新记忆和 Skill 索引。插件配置路径相对 profile，--plugin 相对当前目录。API key 放本地 `.env` 或 shell 环境，不放 JSON。

CLI 自动读取当前工作目录 `.env`，不存在时可从 [.env.example](../.env.example) 复制。支持 `--env-path PATH` 选择另一个文件；已有 shell 环境变量优先，文件只补充缺失项。需要调整 key 时直接编辑本地文件，不打印到终端。

`check/demo` 也读取所选配置，mode 按 `--mode` → config.json → reference 决定；始终使用离线 Provider 和临时数据，不初始化日常 profile、不加载其中插件。配置为 learner 时，不带 --mode 的检查运行学习实现。

```sh
npm run dev -- doctor
npm run dev -- sessions
npm run dev -- history SESSION_ID
npm run dev -- skills list
npm run dev -- skills read study-notes
```

SESSION_ID 来自 sessions。chat/gateway 的 `--trace` 将事件写入 profile 的 traces.jsonl，同时输出到标准错误；JSONL 回复留在标准输出。check/demo 的 `--trace` 只输出标准错误，不写 profile。历史与长期记忆是本地明文。

chat/gateway 独占 profile 的 `.runtime.lock/`。崩溃残留需确认旧进程退出后手动删除锁目录，不能假定操作系统自动释放。具体步骤见 [Gateway](05-gateway.md)。

## TypeScript 断点

每个阶段先运行同一组参考与学习检查，阶段数字可为 0～5：

```sh
npm run dev -- check --stage 0 --mode reference --trace
npm run dev -- check --stage 0 --mode learner --trace --debug
```

每阶段由具名 case 检查对应实现的成功、失败与边界契约；阶段 0 是已完成 Kimi Provider，本机 mock 不使用真实 key。标准输出是阶段 JSON，看失败 case 名、错误和阶段标识定位。trace 在标准错误给出 case.start、case.passed、case.failed 与带 case 信息的事件，不写 traces.jsonl，不打印用户正文或原始推理字段。debug 将错误栈另外写入标准错误，不改变结构化汇总。

结果中的 stage/mode/status 指明所选阶段、算法和通过状态，total/passed/failed 是 case 计数，cases 包含具名结果与可选 error。默认异步 case 等待上限 3000 ms；--debug 会停用这层计时以便单步，工具/Provider 自身预算仍独立存在。同步阻塞不能靠 Promise 计时强制终止。

VS Code 可在“运行和调试”中选 [launch.json](../.vscode/launch.json) 的“Kimi Provider：离线验收”，按 F5 选择 mode；通用“Agent Lab：阶段验收（选择阶段与模式）”可选阶段 0～5。在表中对应文件设置断点；配置使用 tsx 并启用 trace/debug。交互聊天配置固定使用离线 Demo，真实 Kimi 用下面的 CLI 命令。

也可用 Node Inspector 手动启动：

```sh
node --inspect-brk --import tsx src/cli.ts check --stage 0 --mode learner --trace --debug
node --inspect-brk --import tsx src/cli.ts chat --provider demo --message '/calc (2+3)*4' --mode reference
```

附加 Chrome 的 Node 调试器或 VS Code 调试器，打开 src 下的 TypeScript 文件设置断点。--inspect-brk 先暂停入口，继续后才执行命令；可用 Source Map 对应源码，或在学习函数中暂时写 debugger 语句。

| 位置 | 观察什么 |
| --- | --- |
| `src/core/providers/kimi.ts` 的 `complete` | L0 请求、工具与推理字段、响应、错误和取消 |
| `src/learning/exercises.ts` 的 `runLoop`（已实现） | 中文注释、context/delta、文本与工具共存、推理字段、父级取消 |
| `src/core/tools.ts` 的 `ToolRegistry.execute` | schema、限时、错误 envelope、AbortSignal |
| `src/core/agent.ts` | 提示快照、预算、完整轮次持久化 |
| `src/memory/store.ts` 的 `appendMessages` | assistant/tool ID 往返 |
| `src/gateway/router.ts` 的 `Gateway.handle` | 授权、队列、去重、取消 |
| `src/evolution/manager.ts` 的 `approve` | 候选状态与写入 Skill |

## 连接器

```sh
npm run dev -- gateway --provider demo --mode reference --connector jsonl --allow-user learner < examples/messages.jsonl
```

重复事件应返回 cached=true；验证新执行时更换 eventId。HTTP 启动、camelCase 请求 JSON、curl 与恢复步骤见 [Gateway 文档](05-gateway.md)。服务只用于 loopback 调试，需配置 MY_HERMES_GATEWAY_TOKEN 和 --allow-user。

## 真实模型

KimiProvider 已实现，可以由参考 Core 直接驱动，不要求先完成学习算法。在根目录 `.env` 中填入 MOONSHOT_API_KEY 后：

```sh
npm run kimi:check
npm run kimi:doctor
```

kimi:check 使用本机 mock；kimi:doctor 不调用模型，只报告 apiKeyConfigured 布尔值和配置，不显示密钥。填好真实 key 后由你执行：

```sh
npm run kimi:test
npm run kimi:chat
```

kimi:test 要求回复“Kimi 连接成功”，kimi:chat 启动交互；两者显式选择 Kimi 主实现和参考 Core。Kimi 也接受 KIMI_API_KEY，不读取 OPENAI_API_KEY 兜底；默认国内 root 与 kimi-k3.1-pro。--model/--base-url 显式值优先，国际区使用对应平台 key 与 https://api.moonshot.ai/v1。可用 --env-path 选择独立密钥文件。

K3.1 Pro 始终推理，使用 reasoning_effort=low、max_completion_tokens=8192；不发送 K2 的 thinking 开关，也不显式修改固定采样参数。reasoning_content 对应内部 reasoningContent，必须随 assistant 历史保留和回传，最终聊天只显示 content。官方依据、任务分解与限额见 [Kimi Provider](07-kimi-provider.md)。

通用兼容服务仍可用 `--provider compatible --model YOUR_MODEL --base-url http://127.0.0.1:11434/v1`，其凭证读取 MY_HERMES_API_KEY 或 OPENAI_API_KEY。Provider 使用内置 fetch 和 AbortSignal，转换消息字段，限制响应并隐藏远端错误正文。本仓库只做离线与本机协议测试，未用真实凭证调用在线 Kimi。

## 验证与排查

```sh
npm run typecheck
npm test
npm run check -- --all --mode reference
npm run build
```

完成练习后运行 `npm run dev -- check --all --mode learner`。全部六阶段 0～5 都会输出结果，前面的失败不阻止后续；任何失败使退出码非零。当前 L0/L1 已完成，L2～L5 未完成时状态为 `[passed, passed, failed, failed, passed, failed]`。阶段 1 可独立用 `check --stage 1 --mode learner --trace` 阅读与调试；完整 learner 聊天仍需 L2/L4，下一步可先验收阶段 2 的 L2/L3。阶段 4 只是扩展基线，不能自动验证任意自定义插件。

`npm test` 验证基础设施与参考实现回归；learner 检查直接调用学习者代码，两项分别验收。根据具体任务补充边界案例，不以默认测试通过代替练习完成。中断/超时能传播取消，不能回滚已发生的副作用，忽略 signal 的代码还可能继续；重试前检查实际结果。

| 现象 | 首先检查 |
| --- | --- |
| ExerciseNotImplemented | 检查 L2～L5；L0/L1 已实现，完整聊天仍可选参考 Core |
| Kimi key / HTTP 401 | MOONSHOT_API_KEY/KIMI_API_KEY、区域平台、模型权限，不使用 OpenAI key 兜底 |
| 更新 .env 后没生效 | shell 环境变量优先；确认运行目录或 --env-path 路径 |
| 工具第二轮丢上下文 | reasoningContent 与 toolCalls 是否完整保存、持久化并转换回 wire 字段 |
| 单阶段 failed | 查 case 名和错误，使用同一 stage 的 --trace --debug；不必先补其他阶段 |
| --all 同时有 passed/failed | 全部阶段独立汇总；任一 failed 仍以非零退出 |
| ContextBudgetExceeded | system、最新完整轮、工具 schema 总预算 |
| 工具 ok=false | error/message、参数和目标，不能当成成功事实 |
| 同 eventId 冲突 | 是否把旧 ID 用在新正文上 |
| 旧会话记忆未变 | 快照是设计行为，用读取工具检查即时值或 /new |
| 新 Skill 不在索引 | 是否批准、名称是否冲突、是否新建会话 |
| 修改插件未生效 | Node import 缓存，重启入口 |
| Profile lock 错误 | 旧实例是否仍运行，或崩溃残留目录；先核实再恢复 |
| HTTP 超时后重试 | 副作用可能发生，先检查实际结果，不保证回滚 |
| node:sqlite 警告 | 区分运行时实验性 API 警告与应用失败，检查 Node 版本 |
