# 分阶段学习与实现

读完 [架构](01-architecture.md)，先阅读已完成的 Kimi 连接 L0 和 `src/learning/exercises.ts` 中带中文注释的 L1 runLoop、L2 compactHistory、L3 selectMemories，再阅读已接通的 L4 会话键和 L5 模型反思。已完成的主实现、外围基础设施与阶段回归均可运行；对照代码在 `kimi-reference.ts` 和 `learning/reference.ts`。

```sh
npm install
npm run build
npm run check -- --all --mode reference
npm run dev -- check --stage 0 --mode learner
```

以上命令都应成功：阶段 0 验收已经完成的 Kimi 主实现，也可直接运行 `npm run kimi:check`；learner 的阶段 1～5 也应通过，检查不会回退到参考答案。`demo --stage N` 和 `check` 使用同一离线场景，不需要模型凭证。

`check/demo` 的 mode 优先级为命令行 `--mode` → 所选 profile 的 `config.json` → 默认 `reference`。profile 由 `--home` 或 `MY_HERMES_HOME` 选择。检查只读取配置，运行数据放临时目录，不初始化日常 profile，不调用其真实模型，也不加载其插件。

## 阶段总览

| 阶段 | 当前状态 / 学习任务 | 推荐断点 | 可测验收 | 独立命令 |
| --- | --- | --- | --- | --- |
| 0 Kimi Provider | 已实现，阅读与回归 | `src/core/providers/kimi.ts`、`src/core/models.ts` | mock HTTP 请求、文本/工具/推理字段往返、错误与取消 | `check --stage 0 --mode learner` |
| 1 Core | L1 已实现，阅读 / 调试 / 对照 | `src/learning/exercises.ts`、`src/core/tools.ts` | 最终文本、工具结果与 ID 配对、循环预算及非法响应处理 | `check --stage 1 --mode learner` |
| 2 Memory | L2 异步 `compactHistory`、L3 `selectMemories` | `src/learning/exercises.ts`、`src/core/compression/`、`src/memory/history-search.ts`、`src/core/history-tools.ts` | 26 项：摘要与失败恢复、FTS/中文回退、BM25/去重、原文窗口、分页和隔离 | `check --stage 2 --mode learner` |
| 3 Gateway | L4 `sessionKey` | `src/learning/exercises.ts`、`src/gateway/router.ts` | 三维路由稳定无碰撞、同事件只执行一次、用户隔离 | `check --stage 3 --mode learner` |
| 4 Extensions | 无必填算法；扩展自己的实例 | `src/skills/catalog.ts`、`src/plugins/manager.ts` | 内置 Skill 按需读取、测试插件注册/执行与扩展边界 | `check --stage 4 --mode learner` |
| 5 Evolution | L5 `reflect` | `src/learning/exercises.ts`、`src/evolution/manager.ts` | 完整轮次后台复盘、先读后更新、候选批准后生效 | `check --stage 5 --mode learner` |

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

即使前面阶段失败，仍会报告全部六个阶段；任一阶段失败，退出码非零。当前 learner 的六阶段状态应全部为 passed，阶段 4 是扩展基线。任何学习实现被改坏后都会直接报告失败，不使用参考算法兜底。

L1～L5 已完成，完整 `chat --mode learner` 可以运行；`/recall` 调用 L3，`--auto-reflect` 才调用 L5。辅助反思失败不会撤销已保存答复；召回失败会形成工具错误供模型处理。也可用 `--mode reference` 对照完整系统；该模式的 L5 仍是同步规则模板，learner 的 L5 才实际请求 Provider。

## 阶段 0：Kimi 模型连接（L0）

`src/core/providers/kimi.ts` 的 `KimiProvider.complete(messages, tools, signal?)` 已实现，返回 `Promise<ModelResponse>`，不依赖对照版兜底。通过 [Kimi 专题](07-kimi-provider.md) 阅读请求、响应、工具、推理字段与取消；本机 mock 回归不需要真实 key，也不调用在线服务。

`check --stage 0 --mode learner/reference` 分别检查已完成主实现或对照版，与运行时 --provider-mode 分开。根目录 `.env` 填入密钥后，可用 `npm run kimi:doctor` 检查配置，再由你执行 `npm run kimi:test` 或 `npm run kimi:chat`；这些快捷脚本使用参考 Core，也可直接调用 CLI 并选择 learner。阶段回归本身始终离线。

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

当前阶段 1 的 9 个具名回归均应通过；可以在 text/tool 共存、context/delta 更新、结果 ID 配对和取消检查处设置断点。L1 通过后阅读 L2/L3，再跟进 L4/L5；单阶段验收只检查该阶段，完整链路还需集成测试。

离线验收 `/calc (2+3)*4` 应产生 calculator 调用、`{"ok":true,"result":20}` 的工具返回，再得到最终文本。主动测试未知工具、非法表达式、超时、重复 ID、模型持续请求工具等情况。Registry 会把普通工具失败包装为 `ok: false`，让模型观察错误后继续决策；取消应保留取消语义。

在 `exercises.ts` 的模型返回处及 `ToolRegistry.execute` 设置断点，检查 `assistant(toolCalls) → tool(toolCallId) → assistant`。内部字段由 `toWireMessage/fromWireMessage` 转成模型 API 所需的 snake_case，学习算法不用自行拼 HTTP payload。

## 阶段 2：短期上下文与长期记忆（L2/L3）

L2 `compactHistory` 和 L3 `selectMemories` 已完成，阶段 2 的 26 个具名 case 应全部通过：保留原有 20 项，新增 6 项历史检索与读取契约。L2 的 learner 与 reference 都直接实现异步压缩主流程，运行时不会绕过所选版本。先在 `exercises.ts` 的 L2 设置断点，再进入 `core/compression` 的辅助方法。

L2 `compactHistory(messages, tools, runtime, signal?, force?)` 返回 `Promise<CompressionResult>`：

- 结合消息与工具 schema 大小，检查软阈值、冷却和无进展退避；force 用于远端确认溢出后的有界恢复。
- 先清理旧工具输出，再按完整工具组保护头尾、选择摘要中段和预算。
- 组装旧摘要、冻结记忆、中段轨迹、当前请求重点，异步请求模型生成结构化摘要。
- 根据失败类别保留完整历史或生成本地兜底；取消原样传播，不转成降级摘要。
- 重组摘要与近期消息，补回 Skill 重读标记；提交前验证预算和实际缩减。不修改原始输入或数据库历史。

`CompressionRuntime` 提供模型请求、辅助模型回退、超时、冷却状态和提交校验。`window.ts` 负责分区与工具配对，`text.ts` 负责 prompt 和摘要重组。旧同步裁剪已移至 `core/compression/trim.ts` 的 `trimHistory`，仅在关闭语义压缩时使用。旧的 `(messages, maxChars)` L2 调用需要迁移到新的异步接口。

默认 `--compression advanced` 只使用这条异步 L2 主链路；`--compression basic` 用于观察同步裁剪的差异。需要生成摘要时，可先通过只开放 `memory` 工具的辅助流程保存长期事实，最多两次模型请求以支持容量错误后的整理重试。不要把长期记忆文件、原始历史和压缩工作上下文当成同一份数据。

压缩验收由 `src/stages/compression.ts` 直接调用选定算法，覆盖阈值、prompt、工具清理、当前任务保留、重复摘要、失败冷却、辅助回退、取消、兜底与受保护区域。摘要请求使用离线 stub，不受 L3/L4 是否完成影响。`src/stages/recall.ts` 增加真实 SQLite 召回、同源 BM25 与去重、中文/字面回退、消息窗口、游标分页和工具接续读取验收。它们不要求先实现 L4/L5。压缩细节见 [上下文压缩](08-context-compression.md)。

L3 `selectMemories(query, hits, limit)`：

- hits 已由存储层按 scope 隔离。本函数对候选去重、重排和截取，不发起数据库查询。
- 大小写不敏感，先按不同查询词项的命中数排序；重复查询词或正文重复词不额外加分。中文连续文字按子串匹配，不做中文语义分词。
- 词项命中同分时，`source: 'live'` 的本轮原文优先；同一 FTS 来源中，有限的 BM25 `rank` 越小越靠前，负数也按升序比较。不同来源的 rank 不互相比较，其余情况保持原序。兼容字段 `score` 不是跨来源的通用相关度。
- 同一个 `sessionId + messageId` 只保留首次候选，先去重再取 limit；不同会话的相同正文仍是不同记录。无持久消息 ID 的临时候选不会仅因正文相同而被合并。
- 不修改输入、score 或 rank；空查询、非正 limit 返回空数组，limit 必须是安全整数。
- `history_search` 从同 scope 的原始 SQLite 消息召回候选，再执行 L3。召回层使用 FTS5 默认 `unicode61` 词索引，中文长片段使用 `trigram`；短中文、符号和不支持相应索引的环境回退到字面 LIKE。索引是可重建的关键词倒排索引，FTS 不等于向量检索。
- 持久命中带 `sessionId/messageId`，`history_read` 按锚点读取同会话原文窗口，再用 before/after ID 游标翻页。长正文用 `content_offset` 接续读取；工具预算缩短正文预览，同时保留结构化定位与分页字段。

先运行以下离线教学，再阅读 [L3 历史检索教程](11-l3-history-retrieval.md)：

```sh
npm run learn:recall
npm run dev -- check --stage 2 --mode learner --trace --debug
```

依次在 `HistorySearch.search`、`selectMemories`、`SessionStore.readHistory` 和 `src/core/history-tools.ts` 的两个 handler 设置断点，观察候选、排序、消息锚点及工具 JSON。再在 `SessionStore.appendMessages` 和 `Agent` 请求模型处确认 SQLite 保留完整历史、搜索结果通过 tool 消息进入下一次模型请求。修改长期记忆后，用新会话检查提示快照，详见 [记忆与扩展](04-memory-and-extensions.md)。

长期记忆的进阶断点放在 `LongTermMemory.manage` 和 `flushLongTermMemory`：检查同一批 `add/patch/remove` 是否只按最终容量提交、错误是否保留原文件，以及旧会话快照和新会话快照是否符合预期。

## 阶段 3：Gateway 路由（L4）

已实现 `sessionKey(channel, conversationId, userId)`，通过 `JSON.stringify([channel, conversationId, userId])` 编码三个维度。必须包含三个维度，结果稳定且非空。不要直接用冒号连接：`["a:b","c","d"]` 与 `["a","b:c","d"]` 容易碰撞。可用无歧义 JSON 序列化，再做稳定哈希。

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

learner 已实现 `async reflect(transcript, provider, options?): Promise<ReflectionResult>`。先检查完整轮次，再由模型判断是否有经验；失败后修复和无工具的用户纠正都可学习，闲聊或缺乏依据时返回 null。未结束调用、非法 JSON、孤立结果、缺失结果和错误 ID 会直接跳过。

`ReflectionResult` 是新建正文、带目标和版本的 `SkillUpdate` 或 null。复盘工具只有 `skills_list`、`skill_view`、`skill_manage`；更新必须先在前一次请求读取完整 Skill。reference 仍是同步的成功工具模板，保留用于对照。

验收检查 `pending → approved → 可发现 Skill`；未批准的内容不能进入索引，也不能改源码；更新已有技能需批准且版本仍匹配。

```sh
npm run dev -- chat --provider demo --mode learner --message '/calc (2+3)*4' --auto-reflect --trace
npm run dev -- evolve list
npm run dev -- evolve show PROPOSAL_ID
npm run dev -- evolve approve PROPOSAL_ID --name verified-calculation --description '检查计算结果的流程'
npm run dev -- skills read verified-calculation
```

将 ID 替换为实际候选。先阅读候选再批准，框架不会自动批准。断点依次放在 `reflect`、`reviewableTurn`、`reflectionMessages`、`reviewTools`、`provider.complete`、`EvolutionManager.propose` 与 `approve`。

Prompt 分为 system 规则和 user JSON 轨迹，并带上可选的上一轮用户/助手摘录。原始参数、成功结果正文、原始思考内容省略，失败消息做脱敏后保留。输入默认限制 12000 字符、候选 6000 字符；整个复盘最多 5 次请求，总超时 10 秒。

Agent 先返回答复，再由后台队列复盘；新前台任务会取消正在进行的复盘。库调用可用 `waitForReflections()` 等待候选，关闭时调用 `close()`；CLI 正常退出前会等待后台结果。异常不撤销已保存答复，取消后的迟到结果不能落盘。完整调试顺序和更新示例见 [自进化闭环](04-memory-and-extensions.md#自进化闭环)。

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

`npm test` 覆盖基础设施、参考实现及已完成学习算法的回归；`check --mode learner` 独立验收学习者算法的具名契约。两者应分别运行，不能用测试套件通过代替 learner 检查。完成练习后还应补充自己的边界案例，并跑通 learner 对话、记忆召回、两种连接器和候选审核闭环。

中断或超时不能回滚已发生的外部副作用；忽略 signal 的插件工作还可能继续。框架会传播取消并避免将其写成成功缓存，调试失败与重试时仍需检查实际结果，详见 [Gateway 边界](05-gateway.md)。

## L5 之后：先读已接入的 Curator

Curator 的实现已放在 `src/curator/`，不再是待做的基础归档练习。先读 [完整流程、配置和源码入口](04-memory-and-extensions.md#curator整库维护)，再运行：

```bash
node --import tsx --test tests/curator.test.ts
npm run dev -- curator status --home /tmp/my-hermes-curator-study
npm run dev -- curator run --dry-run --consolidate --home /tmp/my-hermes-curator-study
```

推荐断点顺序：`Curator.due` → `transitions` → `modelReview` → `curatorTools` → `SkillRepository.batch` → `SkillLedger.undo`。先理解确定性维护，再跟踪脚本化模型合并两个技能的测试，最后故意让批处理第二项失败，观察第一项和统计如何被撤回。

## 接着读 Persistent Goals

已实现于 `src/goals/` 并接入 CLI/Gateway；没有另设 L6 验收。先读 [机制、命令、状态和恢复](04-memory-and-extensions.md#persistent-goals跨回合推进目标)，再执行：

```bash
node --import tsx --test tests/goals.test.ts tests/goals-cli.test.ts
npm run dev -- goal set '/calc (2+3)*4' --max-turns 3 --provider demo --mode reference --home /tmp/my-hermes-goals-study
npm run dev -- goal status --home /tmp/my-hermes-goals-study
```

推荐断点：`goalCommand` → `GoalManager.set` → `GoalRuntime.step` → `Agent.run` → `recordTurn` → `evaluateAfterTurn` → `nextPrompt`。观察一轮 `Agent.run` 内可以有多次模型和工具调用，但 `turns_used` 只加一次。最后在 WAIT、故障裁判和重启恢复测试中观察：定时器什么时候只查状态，什么时候才真正调用模型。

L5 提炼经验、Curator 维护技能库、Goals 推进当前目标，三个模块分别有自己的触发条件。
