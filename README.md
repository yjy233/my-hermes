# my-hermes

一个以 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 为主要参考的 TypeScript Agent 学习项目：外围框架可运行，核心算法留给学习者，完整参考实现可随时观察和对照。

包含 **Core、Gateway、连接器、短长期记忆、Skills、Plugin、自进化候选与审核**。需要 **Node.js 24+**；运行时仅用内置模块。Kimi Provider 已完整实现，Demo 与阶段验收可离线运行。

![项目架构](docs/images/architecture.png)

## 填入 Kimi 密钥并测试

打开项目根目录 `.env`，在 MOONSHOT_API_KEY 后填写对应平台的 API key；没有该文件时从 [.env.example](.env.example) 复制。密钥只留在本地，不写入 config.json。

```bash
npm install
npm run kimi:check
npm run kimi:doctor
```

kimi:check 是本机 mock 协议回归，kimi:doctor 只检查配置并报告 apiKeyConfigured 布尔值，不显示密钥，也不调用在线模型。填好真实 key 后，由你手动运行：

```bash
npm run kimi:test
npm run kimi:chat
```

测试要求只回复“Kimi 连接成功”，聊天脚本使用已经完成的 Kimi 主实现与参考 Core，不要求先补齐 L1～L5。模型、地址和超时配置在本地 `.hermes-lab/config.json`，示例见 [kimi.json](examples/config/kimi.json)；已有配置不被覆盖。CLI 自动读当前目录 `.env`，支持 --env-path，shell 环境优先。完整说明见 [Kimi 文档](docs/07-kimi-provider.md)。本次只完成离线协议验证，尚未使用你的密钥在线联调。

## 离线观察框架

```bash
npm run dev -- chat --provider demo --mode reference --message '/calc (2+3)*4' --trace
npm run check -- --all --mode reference
npm run typecheck
npm test
npm run build
```

计算示例会经过 Provider、工具校验/执行与 SQLite 持久化，结果为 `20`。DemoProvider 是确定性离线模拟器，不是语言模型；支持 `/calc`、`/remember`、`/memory`、`/recall` 和 `/skill`。交互中 `/new` 开始新会话，`/quit` 退出。Node 的 node:sqlite 可能输出实验性 API 警告，与应用错误不同。

开发入口通过 `tsx` 运行 TypeScript。构建后也可用 `node dist/cli.js init` 和 `node dist/cli.js chat`；`typescript`、`tsx` 等只属于开发依赖，运行构建产物不需要第三方运行时包。

## 自己实现核心

- Core 的 `--mode reference/learner` 选择完整算法或 [exercises.ts](src/learning/exercises.ts) 中的 L1～L5。
- Kimi 的 `--provider-mode learner/reference` 独立选择 [kimi.ts](src/core/providers/kimi.ts) 中已完成的主实现或对照版；主实现不会回退到参考版。

基础设施、Kimi 连接、参考算法与阶段验收均已提供。**L1～L5 保留给学习者实现**。每个阶段可以独立调试，不要求先完成整个 Agent。

| 阶段 | 学习内容 | 当前状态 / 学习任务 | 独立验收 |
| --- | --- | --- | --- |
| 0 | Kimi：真实模型请求、工具与推理字段 | 已实现，阅读与协议回归 | `npm run kimi:check` |
| 1 | Core：模型、工具、观察、终止 | L1 `runLoop` | `npm run dev -- check --stage 1 --mode learner` |
| 2 | 短期上下文、长期记忆、历史召回 | L2 `compactHistory`、L3 `selectMemories` | `npm run dev -- check --stage 2 --mode learner` |
| 3 | Gateway：授权、隔离、幂等 | L4 `sessionKey` | `npm run dev -- check --stage 3 --mode learner` |
| 4 | Skills 与可信 Plugin | 添加自己的 Skill / Tool Plugin | `npm run dev -- check --stage 4 --mode learner` |
| 5 | 自进化：成功轨迹到技能候选 | L5 `reflect` | `npm run dev -- check --stage 5 --mode learner` |

`demo --stage N` 运行同一离线场景。阶段检查的 --mode 选择当前学习实现：阶段 0 用本机 mock 验收 Kimi，不需要真实 key；阶段 1～5 检查对应算法与框架，阶段 4 只验证提供的扩展基线。自定义工具需要另写案例。完整 learner Agent 需要 L1/L2/L4，召回使用 L3，反思使用 L5；也可以先用参考 Core 独立调试 L0。[学习路径](docs/03-learning-path.md) 列出断点与标准，[Kimi 专题](docs/07-kimi-provider.md) 说明模型协议。

每阶段先看参考，再调试自己的代码；将阶段数字换成 0～5：

```bash
npm run dev -- check --stage 0 --mode reference --trace
npm run dev -- check --stage 0 --mode learner --trace --debug
npm run dev -- check --all --mode learner
```

结果 JSON 包含阶段与具名 case 的成功/失败，失败指出错误和相关练习；trace/debug 只向标准错误输出检查事件/错误栈，不写日常 profile。--all 报告全部六阶段，任一失败使退出码非零；L1～L5 未完成时状态为 `[passed, failed, failed, failed, passed, failed]`，不会回退到答案。阶段 0 通过的是已完成 Kimi 主实现，阶段 4 是扩展基线。`npm test` 是基础设施与回归，learner 检查单独验证学生算法。

调试 TypeScript：

```bash
node --inspect-brk --import tsx src/cli.ts check --stage 0 --mode learner --trace --debug
```

随后附加调试器，在 kimi.ts 设置 L0 断点，算法阶段在 exercises.ts 设置断点。VS Code 可选 [阶段调试配置](.vscode/launch.json) 中的“Kimi Provider：离线验收”，或通用配置选择 stage 0～5；按 F5 选择 mode，运行同样的 trace/debug 检查。

## 记忆与扩展

```bash
npm run dev -- chat --provider demo --mode reference --message '/remember 我在学习 TypeScript Agent'
npm run dev -- chat --provider demo --mode reference --message '/memory'
npm run dev -- chat --provider demo --mode reference --session another --message '/recall TypeScript'
npm run dev -- skills list
npm run dev -- chat --provider demo --mode reference --message '/skill study-notes'
npm run dev -- chat --provider demo --mode reference --plugin ./examples/plugins/word-count.ts
```

长期记忆是按用户隔离的 `MEMORY.md` / `USER.md`，每文件默认 4000 字符，超限报错。`/remember` 是整篇替换演示；已有会话的系统提示保持快照，新会话读取更新后的记忆。短期上下文保留最近完整轮次；SQLite 保存成功轮次的完整消息与工具调用。本版采用子串召回与整轮裁剪，Hermes 的全文检索和模型摘要见 [参考映射](docs/02-hermes-reference.md)。

Skill 只提前注入名称/描述，正文通过工具按需读取。Plugin 是显式信任的 TypeScript / JavaScript 模块，导出 `register(context)` 注册工具与 Hook。离线 Demo 不自动选择任意插件工具；阶段 4 直接验收插件调用，真实模型可根据 schema 选择。插件不是沙箱，源文件修改后需重启进程。

## Gateway 与连接器

```bash
npm run dev -- gateway --provider demo --mode reference --connector jsonl --allow-user learner < examples/messages.jsonl
```

JSONL 每行一个事件，重复已完成事件返回 `cached: true`。本机 HTTP 连接器要求 Bearer Token 和用户白名单：

```bash
export MY_HERMES_GATEWAY_TOKEN='replace-with-a-local-token'
npm run dev -- gateway --provider demo --mode reference --connector http --allow-user learner --port 8765
```

消息协议、curl、授权和重试边界见 [Gateway 文档](docs/05-gateway.md)。目前提供 JSONL 与本机 HTTP；飞书、Telegram 等生产 IM 平台可按协议扩展，仓库未包含这些 SDK。

## 自进化闭环

```bash
npm run dev -- chat --provider demo --mode reference --message '/calc 6*7' --auto-reflect
npm run dev -- evolve list
npm run dev -- evolve show PROPOSAL_ID
npm run dev -- evolve approve PROPOSAL_ID --name checked-calculation --description '经人工核对的计算流程'
npm run dev -- skills list
```

将 `PROPOSAL_ID` 替换为实际 ID。成功工具轨迹可生成流程候选，批准后才进入 Skill 索引。模型没有批准工具；基线反思是供人工改进的草稿，不修改源码或模型权重。

## 接入真实模型

```bash
npm run dev -- chat --provider kimi --provider-mode learner --mode reference \
  --message '请调用工具计算 (2+3)*4' --trace
```

填好 `.env` 后可运行上述完整命令。Kimi 默认国内 root 与 kimi-k3.1-pro，另接受 KIMI_API_KEY；不回退读取 OPENAI_API_KEY。配置支持 providerTimeoutMs；Kimi 示例使用 60000 ms 请求超时、180000 ms 回合超时和 64000 字符上下文预算。对照时可选 --provider-mode reference。最终聊天只显示 content，reasoningContent 保留用于后续工具循环。

通用服务仍可用 `--provider compatible --base-url http://127.0.0.1:11434/v1 --model YOUR_MODEL`，读取 MY_HERMES_API_KEY 或 OPENAI_API_KEY。仓库只做离线与本机协议测试，未使用真实凭证调用在线 Kimi 或真实 IM。

## 目录与文档

```text
src/
  core/         Agent、模型协议、工具运行时、providers/Kimi L0
  memory/       node:sqlite 会话、Markdown 长期记忆
  gateway/      事件授权、会话隔离与去重
  connectors/   JSONL、本机 HTTP
  skills/       元数据索引、正文按需读取
  plugins/      显式工具与 Hook 扩展
  evolution/    候选存储、审核与 Skill 提升
  learning/     学习者练习与完整参考算法
  data/skills/  内置 Skill，构建时复制到 dist/data/
  cli.ts        运行、检查、调试和查看状态
  lab.ts        0～5 六个离线阶段验收场景
```

[文档导航](docs/README.md) · [架构](docs/01-architecture.md) · [Hermes 参考](docs/02-hermes-reference.md) · [学习路径](docs/03-learning-path.md) · [记忆与扩展](docs/04-memory-and-extensions.md) · [Gateway](docs/05-gateway.md) · [调试](docs/06-debugging.md) · [Kimi](docs/07-kimi-provider.md)

运行数据默认存入 `.hermes-lab/`。用子命令的 `--home PATH` 或 `MY_HERMES_HOME` 隔离 profile；`config.json` 使用 `mode/providerMode/provider/model/baseUrl/maxSteps/contextChars/providerTimeoutMs/turnTimeoutMs/autoReflect/plugins` 等配置，命令行优先。`check/demo` 也读取所选 profile 的 mode，但始终用临时数据和离线 Provider，不加载其插件。

`chat/gateway` 用 `.runtime.lock/` 目录锁独占 profile。正常退出释放锁；崩溃后需先确认旧进程已停止，再手动移除锁目录，详见 [恢复步骤](docs/05-gateway.md)。`sessions`、`history SESSION_ID`、`doctor` 可查看本地状态。

架构 PNG 由内置 imagegen 生成，位于 `docs/images/architecture.png`；[生成提示词](docs/images/architecture-prompt.txt) 一并保留。精确依赖与接口以可维护的 Mermaid 和源码为准。
