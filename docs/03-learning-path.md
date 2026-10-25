# 分阶段学习与实现

先看 [架构](01-architecture.md)，再实现 `src/learning/exercises.ts` 中的五个函数。外围基础设施已经实现，完整答案在同目录的 `reference.ts`，建议自己实现后再对照。

```sh
npm install
npm run build
npm run check -- --all --mode reference
npm run dev -- check --stage 1 --mode learner
```

前三条应成功，最后一条在未完成练习时报告 L1。`learner` 不回退到答案。`demo --stage N` 和 `check` 使用同一离线场景，不需要模型凭证。

`check/demo` 的 mode 优先级为命令行 `--mode` → 所选 profile 的 `config.json` → 默认 `reference`。profile 由 `--home` 或 `MY_HERMES_HOME` 选择。检查只读取配置，运行数据放临时目录，不初始化日常 profile，不调用其真实模型，也不加载其插件。

## 阶段总览

| 阶段 | 目标 | 学习者修改 | 独立验收 |
| --- | --- | --- | --- |
| 1 Core | 模型 → 工具 → 观察 → 最终答复 | L1 `runLoop` | `check --stage 1 --mode learner` |
| 2 Memory | 上下文预算、长期记忆、历史召回 | L2 `compactHistory`、L3 `selectMemories` | `check --stage 2 --mode learner` |
| 3 Gateway | 路由隔离、同会话顺序、事件去重 | L4 `sessionKey` | `check --stage 3 --mode learner` |
| 4 Extensions | Skill 渐进加载、可信 Plugin | 没有必填算法，扩展自己的实例 | `check --stage 4 --mode learner` |
| 5 Evolution | 成功轨迹 → 候选 → 审核 → Skill | L5 `reflect` | `check --stage 5 --mode learner` |

表中命令加前缀 `npm run dev --`。阶段检查直接调用当前算法，可以先做阶段 2、3 或 5；阶段 4 在练习未完成时也能通过。

完整 `chat --mode learner` 需要 L4、L2、L1；`/recall` 调用 L3，`--auto-reflect` 才调用 L5。辅助反思失败不会撤销已保存答复；未完成的召回算法会形成工具错误。随时切回 `--mode reference` 检查外围系统。

## 阶段 1：有界 Agent Loop（L1）

先读 `src/core/models.ts`、`src/core/providers.ts` 和 `src/core/tools.ts`，再实现：

```ts
runLoop(provider, registry, messages, maxSteps, emit, signal?): Promise<Message[]>
```

契约：

1. 输入历史只用于请求，返回本轮新产生的 assistant/tool 消息，不重复返回原始 user/system；不要原地改输入数组。
2. `await provider.complete(context, registry.schemas(), signal)` 得到响应后，先校验，再构造 assistant 消息。使用内部 camelCase `toolCalls` 和 `toolCallId`。
3. 有调用时逐个 `await registry.execute(call, signal)`，把所有结果加入上下文，再请求模型。每条工具结果必须对应声明的 call ID。
4. 无调用的最终文本结束循环。空响应、重复 ID、过多调用、超长文本和非法参数应拒绝。可复用 `core/models.ts` 的 `validateModelResponse`。
5. 达到 `maxSteps` 仍无最终答复时抛 `StepLimitExceeded`，不能把工具结果冒充最终答复；最后一步仍请求工具时不启动新的工具副作用。共享异常在 `core/errors.ts`。
6. 在合适位置检查 `signal?.throwIfAborted()`，向 Provider 和 Registry 传递 signal，并用 `emit(event, payload)` 发出观察事件。

离线验收 `/calc (2+3)*4` 应产生 calculator 调用、`{"ok":true,"result":20}` 的工具返回，再得到最终文本。主动测试未知工具、非法表达式、超时、重复 ID、模型持续请求工具等情况。Registry 会把普通工具失败包装为 `ok: false`，让模型观察错误后继续决策；取消应保留取消语义。

在 `exercises.ts` 的模型返回处及 `ToolRegistry.execute` 设置断点，检查 `assistant(toolCalls) → tool(toolCallId) → assistant`。内部字段由 `toWireMessage/fromWireMessage` 转成模型 API 所需的 snake_case，学习算法不用自行拼 HTTP payload。

## 阶段 2：短期上下文与长期记忆（L2/L3）

先读 `src/memory/store.ts`、`src/memory/long-term.ts` 与 `src/core/builtin-tools.ts`，区分完整历史和下一次模型可见上下文。

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

先运行 `check --stage 4 --mode learner`，然后读 `src/skills/catalog.ts`、`src/plugins/manager.ts` 和 [示例插件](../examples/plugins/word-count.ts)。

验证索引只含名称/描述，读取工具才加载 Skill 正文。复制一个 Skill，修改名称、描述和验证案例，通过 `skills list` / `skills read NAME` 检查，不要与内置名称冲突。

插件导出 `register(context)`，通过 `context.registerTool(...)` 注册工具，通过 `context.on(event, handler)` 观察事件；register 可返回 Promise，观察 Hook 应为同步函数。工具 handler 接收 `(args, { signal })`，异步操作应响应取消。

```sh
npm run dev -- chat --plugin ./examples/plugins/word-count.ts
```

`--plugin` 路径以当前工作目录解析；`config.json` 的 plugins 相对路径以 profile 为基准。源码插件由 tsx 开发入口加载；构建后的纯 Node 入口使用 `.js` 插件。模块导入有缓存，修改源码或修复顶层导入失败后重启进程。

离线 Demo 不会自动选任意插件工具，阶段检查会直接调用 Registry。使用兼容模型时，模型可根据 schema 选择插件工具。观察重复工具被拒绝、注册失败不留下半套工具、Hook 异常不改变业务结果。

## 阶段 5：可审核自进化（L5）

实现 `reflect(transcript): string | null`。成功的工具执行、最终 assistant 文本都存在时才生成候选。纯聊天、未结束的工具调用、任意失败工具返回 null。

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
node --inspect-brk --import tsx src/cli.ts check --stage 1 --mode learner
```

用 Chrome 的 Node 调试器或 VS Code 附加到该进程，打开 `src/learning/exercises.ts`。观察 messages/context/响应和 signal；Source Map 用于把执行位置映射回 TypeScript。也可在学习函数内临时加入 `debugger;`。

```sh
npm run typecheck
npm test
npm run check -- --all --mode learner
npm run build
```

阶段检查是明确的小契约，不是完整正确性证明；默认测试覆盖基础设施与参考实现。完成练习后还应补充自己的边界案例，并跑通 learner 对话、记忆召回、两种连接器和候选审核闭环。
