# Hermes 参考映射与教学取舍

本项目以 [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) 为主要学习参考，使用 TypeScript 与 Node.js 24+ 独立实现教学框架，不宣称与 Hermes 的配置、插件或运行时协议兼容。OpenClaw 只作为同类产品背景，本轮没有移植其实现。

研究日期：2026-10-25。GitHub API 查询到的参考提交为 [`4ea8d23cc9f527332ccb1d55359b27741b6ea51b`](https://github.com/NousResearch/hermes-agent/commit/4ea8d23cc9f527332ccb1d55359b27741b6ea51b)，提交时间 `2026-10-25T02:56:21Z`。以下源码链接固定到该提交；在线文档可能继续更新，分析结论以本次阅读为准。

## 模块对应

| 能力 | Hermes 参考 | 本项目的教学实现与边界 |
| --- | --- | --- |
| Core | `AIAgent`；`run_agent.py` 是入口 facade，循环拆在 `agent/conversation_loop.py` 与 `agent/turn_*.py` | 单一 Agent 运行同一套 provider → tool → history 循环；入口不包含推理逻辑。省去上游多协议适配、模型切换、流式输出与子代理预算树。 |
| Gateway | 长驻 `GatewayRunner`，归一化消息、鉴权、会话路由、忙碌控制与发送 | 保留独立 Gateway、会话锁、授权和事件去重；连接器先提供 CLI / JSONL / 本地 HTTP。没有声称支持 Telegram、飞书等生产平台。 |
| 短期上下文 | 工具结果清理、边界对齐、中段摘要、保留最近消息，避免拆散 tool call/result | 教学起点按完整 user turn 移除较老上下文，保留当前轮与工具组；这是确定性的裁剪，不是 Hermes 的语义摘要。SQLite 原始记录仍可检索。 |
| 长期记忆 | 有界、人工可读 `MEMORY.md` / `USER.md`，会话起始冻结快照 | 保留两类文件、容量检查、持久写入和会话快照；按用户 scope 隔离。教学默认每文件 4,000 字符，是明确的简化，并未复制上游不同配额。 |
| 历史检索 | SQLite 持久会话、全文检索与压缩相关元数据 | 本地 SQLite 存消息和工具调用，按 scope 搜索；不声称实现上游 FTS5 多索引、压缩代际与会话迁移全部语义。 |
| Skills | 索引 → `SKILL.md` → 参考文件的渐进披露 | 索引只注入名称/描述，正文按需读；保留目录形式，限制读路径。不支持上游技能市场、完整元数据规范与安装流程。 |
| Plugins | 显式启用的可信 Python 扩展，向 context 注册工具和 hooks；另有专用 provider 插件体系 | 显式列出的 TypeScript / JavaScript 本地入口、工具注册和生命周期观察 hook；拒绝重名覆盖。不实现 marketplace、pip entry points、热加载或进程外 host。 |
| 自进化 | 从实践中维护事实记忆与可复用技能；可使用后台反思和 curator | 成功轨迹 → 候选 Skill → 本地人工提升 → 新会话可用。候选不是已验证的知识，提升不修改项目源码或模型权重。 |

核心拆分参考 [架构说明](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture) 与 [固定提交中的架构文档](https://github.com/NousResearch/hermes-agent/blob/4ea8d23cc9f527332ccb1d55359b27741b6ea51b/website/docs/developer-guide/architecture.md)。循环和内部消息格式参考 [Agent Loop Internals](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop) 与 [对应源码文档](https://github.com/NousResearch/hermes-agent/blob/4ea8d23cc9f527332ccb1d55359b27741b6ea51b/website/docs/developer-guide/agent-loop.md)。

## 三种记忆不能混为一谈

短期记忆是当前模型请求中的对话与工具结果，受上下文窗口约束。长期事实记忆是跨会话保留的小块信息。程序性记忆是按需载入的 Skill。历史数据库保留经历，供检索补充，而不是每次全部灌入 prompt。

Hermes 文档中的 `MEMORY.md` 上限为 2,200 字符，`USER.md` 为 1,375 字符；超限返回错误，由 Agent 整理后重试，不静默丢条目。会话开始时读成冻结快照，当前会话内的写入立即落盘，但只在下一次会话的系统提示中体现；工具响应可以查看实时内容。本项目保留这些行为原则，但容量和按用户 scope 隔离是教学版自己的配置。见 [Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory) 与 [固定版本说明](https://github.com/NousResearch/hermes-agent/blob/4ea8d23cc9f527332ccb1d55359b27741b6ea51b/website/docs/user-guide/features/memory.md)。

Hermes 的上下文压缩通常包含清理旧工具输出、保护头尾、为中段生成结构化摘要、修复工具配对。教学版从整轮裁剪起步，目的是先学会预算和结构不变量；被裁掉的信息不会自动得到摘要。后续可把预算策略替换为摘要器，并增加压缩失败、摘要质量和重复压缩评测。见 [Context Compression and Caching](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching) 与 [固定版本说明](https://github.com/NousResearch/hermes-agent/blob/4ea8d23cc9f527332ccb1d55359b27741b6ea51b/website/docs/developer-guide/context-compression-and-caching.md)。

上游会话层还负责 WAL、FTS5、活动/归档消息以及压缩相关状态。教学版没有把这些高级恢复能力包装成已完成。见 [Session Storage](https://hermes-agent.nousresearch.com/docs/developer-guide/session-storage) 与 [固定版本说明](https://github.com/NousResearch/hermes-agent/blob/4ea8d23cc9f527332ccb1d55359b27741b6ea51b/website/docs/developer-guide/session-storage.md)。

## 扩展与自进化的边界

Skill 是知识文档；Plugin 是执行代码。Hermes 的插件实现以 Python 为主，本项目使用可信 TypeScript / JavaScript 模块；阅读 Skill 不隐式执行脚本。Hermes 支持工具、hooks、命令和多类 provider 扩展；本项目缩减为工具和 hooks，并拒绝重复注册，便于看清依赖方向。两者格式仅借鉴思想，不兼容上游安装包。见 [Skills System](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)、[Plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins) 及固定提交的 [skills.md](https://github.com/NousResearch/hermes-agent/blob/4ea8d23cc9f527332ccb1d55359b27741b6ea51b/website/docs/user-guide/features/skills.md)、[plugins.md](https://github.com/NousResearch/hermes-agent/blob/4ea8d23cc9f527332ccb1d55359b27741b6ea51b/website/docs/user-guide/features/plugins.md)。

Hermes 可以直接维护技能，也可开启技能写入审核；其 curator 对生成技能做使用统计、陈旧标记、归档和可选的模型整理。教学版选择始终生成待审核候选，再由本地 CLI 提升，以便学习者检查“学到了什么”。这属于知识资产的迭代，不代表模型训练或已经实现上游完整后台维护。见 [Curator](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator) 与 [固定版本说明](https://github.com/NousResearch/hermes-agent/blob/4ea8d23cc9f527332ccb1d55359b27741b6ea51b/website/docs/user-guide/features/curator.md)。

连接器职责是输入归一化与回复交付；Gateway 负责授权、路由与会话生命周期。上游还有平台配对、线程会话、停止/排队控制和持久交付等机制。本项目本地连接器只验证稳定接口，平台 SDK 应在后续独立适配器中添加。事件去重只防止已记录的成功请求被重复执行，不能据此宣称外部副作用 exactly-once。见 [Gateway Internals](https://hermes-agent.nousresearch.com/docs/developer-guide/gateway-internals) 与 [固定版本说明](https://github.com/NousResearch/hermes-agent/blob/4ea8d23cc9f527332ccb1d55359b27741b6ea51b/website/docs/developer-guide/gateway-internals.md)。
