# 分阶段学习与实现

读完 [架构](01-architecture.md)，先阅读已完成的 Kimi 连接 L0 和 `src/learning/exercises.ts` 中带中文注释的 L1 runLoop，再实现 L2～L5。两个主实现、外围基础设施与阶段回归均可运行；对照代码在 `kimi-reference.ts` 和 `learning/reference.ts`。

```sh
npm install
npm run build
npm run check -- --all --mode reference
npm run dev -- check --stage 0 --mode learner
```

以上命令都应成功：阶段 0 验收已经完成的 Kimi 主实现，也可直接运行 `npm run kimi:check`；阶段 1 的 learner 也应通过。L2～L5 未实现时明确失败，不回退到答案。`demo --stage N` 和 `check` 使用同一离线场景，不需要模型凭证。

`check/demo` 的 mode 优先级为命令行 `--mode` → 所选 profile 的 `config.json` → 默认 `reference`。profile 由 `--home` 或 `MY_HERMES_HOME` 选择。检查只读取配置，运行数据放临时目录，不初始化日常 profile，不调用其真实模型，也不加载其插件。

## 阶段总览

| 阶段 | 当前状态 / 学习任务 | 推荐断点 | 可测验收 | 独立命令 |
| --- | --- | --- | --- | --- |
| 0 Kimi Provider | 已实现，阅读与回归 | `src/core/providers/kimi.ts`、`src/core/models.ts` | mock HTTP 请求、文本/工具/推理字段往返、错误与取消 | `check --stage 0 --mode learner` |
| 1 Core | L1 已实现，阅读 / 调试 / 对照 | `src/learning/exercises.ts`、`src/core/tools.ts` | 最终文本、工具结果与 ID 配对、循环预算及非法响应处理 | `check --stage 1 --mode learner` |
| 2 Memory | L2 `compactHistory`、L3 `selectMemories` | `src/learning/exercises.ts`、`src/memory/store.ts` | 完整轮次预算、不修改输入、排序与条数限制、记忆隔离 | `check --stage 2 --mode learner` |
| 3 Gateway | L4 `sessionKey` | `src/learning/exercises.ts`、`src/gateway/router.ts` | 三维路由稳定无碰撞、同事件只执行一次、用户隔离 | `check --stage 3 --mode learner` |
| 4 Extensions | 无必填算法；扩展自己的实例 | `src/skills/catalog.ts`、`src/plugins/manager.ts` | 内置 Skill 按需读取、测试插件注册/执行与扩展边界 | `check --stage 4 --mode learner` |
| 5 Evolution | L5 `reflect` | `src/learning/exercises.ts`、`src/evolution/manager.ts` | 成功轨迹生成候选，纯聊天/失败/未完成轨迹不生成，批准后才可发现 | `check --stage 5 --mode learner` |

表中命令加前缀 `npm run dev --`。阶段检查调用选中 mode 的真实算法，每个具名 case 检查一个成功或边界契约；阶段 0 直接验收 Kimi Provider，阶段 1～5 验收对应算法与框架。可以单独做任一阶段，不依赖其他阶段练习。阶段 4 验收提供的扩展基线，不调用五个学习算法，因此空练习也能通过；它不会自动证明你任意新增的插件正确，新增工具仍需自己的输入、输出与失败案例。

## 每阶段的调试与验收循环

先从阶段 0 的模型连接开始，观察参考行为，再调试自己的实现；后续把阶段数字换成 1～5：

```sh
npm run dev -- check --stage 0 --mode reference --trace
npm run dev -- check --stage 0 --mode learner --trace
npm run dev -- check --stage 0 --mode learner --trace --debug
```

`--stage N` 只运行该阶段的具名契约。标准输出给出该阶段 JSON：`stage/mode/status` 表示本次选择和结果，`total/passed/failed` 汇总 case 数量，`cases` 列出具名结果；失败项的 error 给出类型、消息和相关练习标识。先修复一个失败 case，再重跑同阶段，全部通过后进入下一阶段。

npm 默认还会显示脚本启动信息；需要机器逐行解析 JSON 时，用 `npm run --silent dev -- check ...` 或构建后的 `node dist/cli.js check ...`。

检查模式的 `--trace` 只在标准错误输出 `case.start`、`case.passed`、`case.failed` 及带 case 信息的运行事件，不创建 profile 或 traces.jsonl，也不记录原始用户正文、工具参数或记忆内容。`--debug` 额外将失败 case 的错误栈写到标准错误，便于定位代码；JSON 结果仍留在标准输出。

普通检查为每个异步 case 设置 3000 ms 等待上限，避免未完成的 Promise 挂住整阶段；`--debug` 停用这层 case 计时，便于断点单步。工具和 Provider 自身的业务预算仍独立，debug 不会自动取消这些限制。同步阻塞的插件无法由 Promise 计时强制中断。

使用 VS Code 时，打开“运行和调试”，选择 [launch.json](../.vscode/launch.json) 中的“Agent Lab：阶段验收（选择阶段与模式）”并按 F5；从下拉选项选择阶段 0～5 和 reference/learner，在表中推荐文件设置断点。它通过 tsx 运行同一 CLI，并启用 trace/debug，不需要先搭建另一个调试入口。

随时运行全部学习阶段：

```sh
npm run dev -- check --all --mode learner
```

即使前面阶段失败，仍会报告全部六个阶段；任一阶段失败，退出码非零。L2～L5 未完成时状态为 `[passed, passed, failed, failed, passed, failed]`：阶段 0/1 是已完成主实现，阶段 4 是扩展基线，其余失败明确保留练习，没有使用参考算法兜底。

L1 已完成，但完整 `chat --mode learner` 仍需补齐 L4 和 L2；`/recall` 调用 L3，`--auto-reflect` 才调用 L5。辅助反思失败不会撤销已保存答复；未完成的召回算法会形成工具错误。可用 `--mode reference` 运行完整系统，下一步独立实现阶段 2 的 L2/L3。

## 阶段 0：Kimi 模型连接（L0）

`src/core/providers/kimi.ts` 的 `KimiProvider.complete(messages, tools, signal?)` 已实现，返回 `Promise<ModelResponse>`，不依赖对照版兜底。通过 [Kimi 专题](07-kimi-provider.md) 阅读请求、响应、工具、推理字段与取消；本机 mock 回归不需要真实 key，也不调用在线服务。

`check --stage 0 --mode learner/reference` 分别检查已完成主实现或对照版，与运行时 --provider-mode 分开。根目录 `.env` 填入密钥后，可用 `npm run kimi:doctor` 检查配置，再由你执行 `npm run kimi:test` 或 `npm run kimi:chat`；这些真实调用使用参考 Core，L2～L5 未完成也可运行。阶段回归本身始终离线。

K3.1 Pro 的 `reasoning_content` 必须映射成内部 reasoningContent 并随完整 assistant 历史往返；最终 CLI 只显示 content，不能把推理内容拼到用户答复或 trace。检查预算、错误脱敏与工具 ID 配对，完整契约见专题。

## 阶段 1：有界 Agent Loop（L1）

`src/learning/exercises.ts` 中的 runLoop 已实现，并带详细中文注释。先读 `src/core/models.ts`、`src/core/providers.ts` 和 `src/core/tools.ts`，再单步阅读主实现、对照 reference.ts：

```ts
runLoop(provider, registry, messages, maxSteps, emit, signal?): Promise<Message[]>
```

契约：

1. 输入历史只用于请求，返回本轮新产生的 assistant/tool 消息，不重复返回原始 user/system；不要原地改输入数组。
2. `await provider.complete(context, registry.schemas(), signal)` 得到响应后，先校验，再构造 assistant 消息。使用内部 camelCase `toolCalls`、`toolCallId`、`reasoningContent`；创建 assistant 消息时保留返回的推理字段，供下一次模型请求使用。
3. 有调用时逐个 `await registry.execute(call, signal)`，把所有结果加入上下文，再请求模型。每条工具结果必须对应声明的 call ID。
4. 无调用的最终文本结束循环。空响应、重复 ID、过多调用、超长文本和非法参数应拒绝。可复用 `core/models.ts` 的 `validateModelResponse`。
5. 达到 `maxSteps` 仍无最终答复时抛 `StepLimitExceeded`，不能把工具结果冒充最终答复；最后一步仍请求工具时不启动新的工具副作用。共享异常在 `core/errors.ts`。
6. 在合适位置检查 `signal?.throwIfAborted()`，向 Provider 和 Registry 传递 signal，并用 `emit(event, payload)` 发出观察事件。

阅读时先分清 context 和 delta：context 是发给下一次模型请求的完整工作上下文，delta 只累计本轮新 assistant/tool 消息。两者都会追加新消息，但返回值只有 delta；完整轮次由外层 Agent 提交数据库，runLoop 不重复返回旧历史。

同一响应可以同时有文本和工具调用，此时仍要执行工具，不能看到文本就提前结束。assistant 消息须保留 reasoningContent，执行结果按调用顺序追加并保留 call ID，下一次模型才能观察结果。maxSteps 限制模型请求次数；最后一步若仍要求工具，直接抛错，不再开始新的副作用。父级 signal 在请求前、等待中或工具执行后取消时，应传播原始取消原因，不能包装成普通工具错误或最终答复。

```sh
npm run dev -- check --stage 1 --mode learner --trace
```

当前阶段 1 的 9 个具名回归均应通过；可以在 text/tool 共存、context/delta 更新、结果 ID 配对和取消检查处设置断点。L1 通过后继续下面的 L2/L3，不代表完整 learner 聊天已经可用。

离线验收 `/calc (2+3)*4` 应产生 calculator 调用、`{"ok":true,"result":20}` 的工具返回，再得到最终文本。主动测试未知工具、非法表达式、超时、重复 ID、模型持续请求工具等情况。Registry 会把普通工具失败包装为 `ok: false`，让模型观察错误后继续决策；取消应保留取消语义。

在 `exercises.ts` 的模型返回处及 `ToolRegistry.execute` 设置断点，检查 `assistant(toolCalls) → tool(toolCallId) → assistant`。内部字段由 `toWireMessage/fromWireMessage` 转成模型 API 所需的 snake_case，学习算法不用自行拼 HTTP payload。

## 阶段 2：短期上下文与长期记忆（L2/L3）

这是当前下一步练习：实现 `compactHistory` 与 `selectMemories`。先读 `src/memory/store.ts`、`src/memory/long-term.ts` 与 `src/core/builtin-tools.ts`，区分完整历史和下一次模型可见上下文。

L2 `compactHistory(messages, maxChars)`：

- 保留首条 system，按 user 边界组成完整轮次，优先保留连续的最近轮次。
- 使用 `core/models.ts` 的 `messageSize` 计算序列化长度，不能只计算正文。Core 在请求前另外计入工具 schema。
- 不拆散 assistant 调用与 tool 返回，不删除数据库原始记录，不修改输入数组。
- 预算必须为正；system 自身或 system 加最新轮仍超预算时抛 `ContextBudgetExceeded`。

参考策略是确定性整轮裁剪，旧信息不会自动变成摘要。Hermes 的模型摘要可作为进阶替换策略，需增加摘要失败和质量评估。

L3 `selectMemories(query, hits, limit)`：

- hits 已由存储层按 scope 隔离，本函数只排序，不重新越权查询。
- 返回最多 limit 条，不修改输入；等分保持原始顺序，非正 limit 返回空数组。
- 查询 `TypeScript` 时，`TypeScript tooling` 应排在无关内容前。先让排序可解释，再扩展中文切词、时间衰减或去重。

阶段检查覆盖上下文分组、排序与记忆隔离。在 `SessionStore.appendMessages` 和 `Agent` 请求模型处设置断点，确认 SQLite 仍保存完整历史。修改长期记忆后，用新会话检查提示快照，详见 [记忆与扩展](04-memory-and-extensions.md)。

## 阶段 3：Gateway 路由（L4）

实现 `sessionKey(channel, conversationId, userId)`。必须包含三个维度，结果稳定且非空。不要直接用冒号连接：`["a:b","c","d"]` 与 `["a","b:c","d"]` 容易碰撞。可用无歧义 JSON 序列化，再做稳定哈希。

验收会并发发送同一事件两次，要求 Agent 只执行一次；同房间不同用户必须得到不同会话。去重和持久缓存由 Gateway 基础设施实现，不需要写在 L4。

在 `src/gateway/router.ts` 的 `Gateway.handle` 检查 allowlist、路由、排队和 `cached`；继续测试重启后去重、同 ID 改正文冲突、失败重试。用 [JSONL / HTTP](05-gateway.md) 调试统一协议。

## 阶段 4：Skills 与 Plugin

先运行 `check --stage 4 --mode learner --trace`，然后读 `src/skills/catalog.ts`、`src/plugins/manager.ts` 和 [示例插件](../examples/plugins/word-count.ts)。这一步检查内置 Skill 和验收场景中的插件；为自己新增的工具另写案例，不能仅凭基线 passed 判断其已验证。

验证索引只含名称/描述，读取工具才加载 Skill 正文。复制一个 Skill，修改名称、描述和验证案例，通过 `skills list` / `skills read NAME` 检查，不要与内置名称冲突。

插件导出 `register(context)`，通过 `context.registerTool(...)` 注册工具，通过 `context.on(event, handler)` 观察事件；register 可返回 Promise，观察 Hook 应为同步函数。工具 handler 接收 `(args, { signal })`，异步操作应响应取消。

```sh
npm run dev -- chat --plugin ./examples/plugins/word-count.ts
```

`--plugin` 路径以当前工作目录解析；`config.json` 的 plugins 相对路径以 profile 为基准。源码插件由 tsx 开发入口加载；构建后的纯 Node 入口使用 `.js` 插件。模块导入有缓存，修改源码或修复顶层导入失败后重启进程。

离线 Demo 不会自动选任意插件工具，阶段检查会直接调用 Registry。使用兼容模型时，模型可根据 schema 选择插件工具。观察重复工具被拒绝、注册失败不留下半套工具、Hook 异常不改变业务结果。

## 阶段 5：可审核自进化（L5）

实现 `reflect(transcript): string | null`。成功的工具执行、最终 assistant 文本都存在时才生成候选；工具声明与结果 ID 必须完整配对。纯聊天、未结束调用、失败或非法 JSON 结果、孤立结果、缺失结果和错误 ID 均返回 null。可从 `L5/successful-procedure`、`L5/missing-tool-result` 等具名 case 逐项检查。

候选写适用场景、可复用步骤与验证方式，避免复制原始用户数据、工具参数或凭证。基础实现可只提取工具名称并生成保守流程，不需要额外模型调用。

验收检查 `pending → approved → 可发现 Skill`；未批准的内容不能进入索引，也不能改源码或覆盖已有技能。

```sh
npm run dev -- chat --mode reference --message '/calc (2+3)*4' --auto-reflect --trace
npm run dev -- evolve list
npm run dev -- evolve show PROPOSAL_ID
npm run dev -- evolve approve PROPOSAL_ID --name verified-calculation --description '检查计算结果的流程'
npm run dev -- skills read verified-calculation
```

将 ID 替换为实际候选。补齐练习后改用 `--mode learner`；先阅读候选再批准，框架不会自动批准。断点放在 `reflect`、`EvolutionManager.propose` 与 `approve`。

## 调试与毕业验收

```sh
node --inspect-brk --import tsx src/cli.ts check --stage 0 --mode learner --trace --debug
```

用 Chrome 的 Node 调试器或 VS Code 附加到该进程，先打开 `src/core/providers/kimi.ts`，后续算法阶段打开 `src/learning/exercises.ts`。观察 messages/context/响应和 signal；Source Map 用于把执行位置映射回 TypeScript。也可在学习函数内临时加入 `debugger;`。

```sh
npm run typecheck
npm test
npm run check -- --all --mode learner
npm run build
```

`npm test` 覆盖基础设施与参考实现回归；`check --mode learner` 才直接验收学习者算法的具名契约。两者应分别运行，不能用测试套件通过代替 learner 检查。完成练习后还应补充自己的边界案例，并跑通 learner 对话、记忆召回、两种连接器和候选审核闭环。

中断或超时不能回滚已发生的外部副作用；忽略 signal 的插件工作还可能继续。框架会传播取消并避免将其写成成功缓存，调试失败与重试时仍需检查实际结果，详见 [Gateway 边界](05-gateway.md)。
