# 记忆系统配图：生成提示词 A

生成方式：内置 `image_gen`，每张图片独立调用；未使用 CLI 或 API fallback。图片用于本仓库的中文学习文档。正文与代码是精确行为依据，图片用于解释概念和主要时序。

统一视觉：宽幅技术教学信息图、浅白背景、深蓝正文；蓝色表示当前模型上下文，琥珀色表示精选长期记忆，紫色表示原始历史与检索。短中文标签配准确英文标识，边界清楚，尽量减少交叉箭头。

## 01-memory-layers.png

```text
Use case: infographic-diagram
Asset type: a wide educational raster infographic for a Chinese Markdown guide about agent memory.
Primary request: clearly distinguish three independent memory layers and how the model receives them.
Style: professional textbook infographic, white background, crisp dark navy typography, generous whitespace, large legible Simplified Chinese labels, restrained flat icons. Blue for live context, amber for curated memory, violet for history. Landscape 16:9 composition.
Title verbatim: "Agent 记忆的三个层次"
Three large columns, clearly separated:
1. Blue column: "当前上下文" / "Live context"; small labels "近期对话" and "会话摘要"; note "每次请求传给模型".
2. Amber column: "精选长期记忆" / "Curated memory"; file cards named exactly "MEMORY.md" and "USER.md"; small labels "稳定事实" and "用户偏好"; note "新会话开始时自动加载".
3. Violet column: "完整历史" / "History"; database cylinder named "SQLite"; small label "完整对话与工具轨迹"; note "需要时通过工具检索".
Below the columns place a single small neutral model icon labelled "Model". Draw one clear blue arrow from Live context to Model labelled "请求上下文"; draw one amber arrow from Curated memory to Live context labelled "会话开始"; draw one violet arrow from History to Live context labelled "工具结果". No direct arrow from history to curated memory. Curated memory is not the whole transcript.
Bottom narrow neutral note: "Skill：按需加载的流程知识".
Constraints: exact filenames and English labels; no extra architectural claims; no automatic database-to-memory arrow; no illegible small print; no decorative neural network; no watermark; all arrows should show the stated data direction.
```

## 02-recall-tool-loop.png

```text
Use case: infographic-diagram
Asset type: wide Chinese technical teaching diagram embedded in Markdown.
Primary request: a clean left-to-right sequence of history recall as a model tool call round trip.
Style: same white textbook style as the companion memory layers diagram, dark navy text, blue model/context, violet history/search, amber only for a small separate memory maintenance note, large readable labels, no visual clutter.
Title verbatim: "历史召回：一次工具调用的往返"
Main numbered path with exactly six large nodes connected in order by clear arrows:
"1 工具定义" with small "tool schema";
"2 模型决定检索" with small "tool call";
"3 历史检索工具" with two short lines "Hermes: session_search" and "本项目: history_search";
"4 SQLite 检索与排序";
"5 返回工具结果" with small exact "role: tool";
"6 再次请求模型" with small "context + tool result".
Use a lower return arc, or two aligned rows of three nodes if necessary, to make all six nodes readable. The ordering must unambiguously be 1→2→3→4→5→6. A small callout near step 6 reads "模型依据结果继续推理".
Separate amber note at bottom, outside the six-step path: "memory 工具：维护精选事实与偏好" and "与历史检索是不同工具". Do not connect this note as part of the search execution path.
Constraints: no assertion that all history is automatically injected, no search before model tool call, no diagram of vector embeddings, no extra SQL or invented tool names, no watermark.
```

## 03-compaction-and-flush.png

```text
Use case: infographic-diagram
Asset type: wide educational process diagram for the current TypeScript teaching project.
Primary request: explain context compaction and memory-only flush, with two clearly different persistence moments.
Style: white background, dark navy typography, blue context flow, amber curated memory path, violet SQLite history path, thin precise arrows, spacious readable layout, flat textbook infographic. Landscape 16:9.
Title verbatim: "本项目：上下文压缩与记忆整理"
Top main path, arranged in two readable rows if needed:
"每次模型请求前" → "检查预算" → "清理旧工具输出" → "保护近期消息" → "memory-only flush" → "中段 + 旧摘要" → "结构化摘要" → "主模型" → "任务成功".
Under "保护近期消息" show only three short chips: "system", "最新 user", "最新工具组".
Draw an amber downward side path only from "memory-only flush" to two small file cards "MEMORY.md" and "USER.md", with label "memory 工具成功后立即落盘". A smaller note next to the files: "稳定事实与偏好".
Draw a violet downward path from "任务成功" to a SQLite database labelled "原始轨迹 + 工作上下文", with label "同一事务提交".
Put an explicit small boundary note between amber files and blue summary: "会话摘要不直接写入长期记忆". There must be NO arrow from structured summary to the Markdown files.
Bottom two brief statements, readable: "原始历史保留，可按需检索" and "取消时不提交新的工作检查点".
Constraints: this is the project default flow, not a claim of complete Hermes feature parity; no conflation of immediate memory tool writes and successful-turn database transaction; no automatic rollback promise for already-written memory; no crossed arrows; no long paragraphs; exact English filenames and labels; no watermark.
```

## 产物检查

| 文件 | 尺寸 | 检查结果 |
| --- | --- | --- |
| `01-memory-layers.png` | 1672 × 941 | 三层标签、文件名清楚；长期记忆在会话开始流向上下文，历史通过工具结果流向上下文，无历史直写事实记忆箭头。 |
| `02-recall-tool-loop.png` | 1774 × 887 | 六步顺序 1→2→3→4→5→6 清楚；Hermes 与项目工具名正确；`memory` 维护说明独立于检索路径。 |
| `03-compaction-and-flush.png` | 1672 × 941 | 标题明确为本项目；记忆文件立即写入与任务成功后 SQLite 事务两条路径分开；没有摘要直接写长期记忆的箭头。 |

全部图片在内置工具输出后逐张目视检查，未做 SVG/Canvas/Pillow 绘制替代，也未用 CLI fallback。生成器原图保留在 `$CODEX_HOME/generated_images/01a1bb27-3185-7733-ace0-0a40287c0a3b/`，项目引用使用本目录中的副本。

生成器原文件依次为：

- `exec-4c3d7914-68b9-40df-8bb8-990eae830468.png`
- `exec-41f63397-2621-4edd-b82a-258dda958efa.png`
- `exec-7970c27a-be98-470a-b54d-19fca0ffe940.png`

图 3 展示进入实际压缩分支后的主要路径；预算未达到阈值、清理即已足够、摘要失败回退等条件，以正文和源码为准。
