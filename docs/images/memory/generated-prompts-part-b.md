# 记忆专题配图：生成提示词与验收记录 B

生成日期：2026-11-08。使用内置 `image_gen`，未使用 CLI/API fallback。图片先生成到 Codex 默认产物目录，再复制进仓库；保留原始文件。没有用 SVG、Pillow 或 HTML 替代生成图片。

与 [提示词记录 A](generated-prompts-part-a.md) 合起来构成本次六张配图。内容版本见 [主指南](../../09-memory-system-guide.md)。

## 04 Hermes 存储地图

- 交付文件：[04-hermes-storage-map.png](04-hermes-storage-map.png)。
- 原始产物说明：Generated images are saved to /Users/bill/.codex/generated_images/01a17117-30b6-75f1-8d34-bfb76c7e7efc as /Users/bill/.codex/generated_images/01a17117-30b6-75f1-8d34-bfb76c7e7efc/exec-bf6e9c00-673d-46f9-992a-2b5a0e8f6744.png by default.
- 图像检查：已目视确认：Markdown 与 SQLite 分区，sessions→messages 的 1:N、system prompt hash 引用、两个 FTS 索引、17/2/30 口径及固定提交日期均清楚。数据库统计以正文附录为准。

### 最终生成提示词

```text
Use case: infographic-diagram
Asset type: Chinese technical learning document illustration, standalone high-resolution landscape infographic, approximately 16:9.
Primary request: Draw an accurate Hermes Agent storage map. Title text verbatim: "Hermes 的记忆存储地图".
Style: clean editorial technical diagram, white background, dark navy type, blue for live context/session, amber for curated long-term facts, purple for history/search. Flat precise panels, very readable Chinese and monospace English identifiers, generous spacing, few thick directional arrows. No characters, no robot mascot, no decorative circuits, no watermark.
Composition: two independent large storage zones:
A left amber zone titled "精简长期记忆 · 文件" containing exactly two document icons labeled "MEMORY.md" and "USER.md". Subtitle "事实与约定" under MEMORY.md and "用户偏好" under USER.md. An amber arrow labeled "会话开始加载" points to a small blue "System prompt" box above them.
A larger right purple/blue zone titled "会话与历史 · state.db". Show core relational tables as three clear cards: "sessions" labeled "会话元数据", "messages" labeled "完整消息与工具轨迹", and "system_prompts" labeled "系统提示去重". A 1→N arrow goes from sessions to messages. A reference arrow from sessions to system_prompts is labeled "hash 引用". Beside messages put two purple search index cards, "messages_fts" subtitle "词项检索", and "messages_fts_trigram" subtitle "中文与子串". Both are derived search indexes connected to messages, not sources of truth.
At bottom of the database zone place a restrained compact band "其他状态：网关 · 用量 · 锁与租约 · 任务账本".
Across lower edge put three large count badges verbatim: "17 张普通表"  "2 张 FTS5 虚拟表"  "30 个显式普通索引".
Footer exact short text: "核心新库口径 · 110afdd · 2026-11-08". Smaller note: "不含内部表、自动索引与按需表".
Accuracy constraints: Markdown files must remain outside SQLite. Do NOT create a memory SQL table. Do NOT draw any arrow that stores the whole history summary directly into MEMORY.md. Do NOT enumerate speculative tables. Do not label the 30 indexes as 30 FTS indexes. Render exact English identifiers, no additional filler text.
```

## 05 Hermes 与本项目对照

- 交付文件：[05-hermes-project-comparison.png](05-hermes-project-comparison.png)。
- 原始产物说明：Generated images are saved to /Users/bill/.codex/generated_images/01a17117-30b6-75f1-8d34-bfb76c7e7efc as /Users/bill/.codex/generated_images/01a17117-30b6-75f1-8d34-bfb76c7e7efc/exec-920ca771-dc28-4811-90f5-affe2b021e07.png by default.
- 图像检查：已目视确认：session_search/history_search、FTS5/trigram 与 LIKE、真实 usage 与字符预算均区分，未把本项目 flush 画成上游完整复刻。

### 最终生成提示词

```text
Use case: infographic-diagram
Asset type: high resolution landscape diagram embedded in Chinese Markdown documentation.
Primary request: Create a side-by-side technical comparison with title exactly "Hermes 与本项目：对应关系与差距".
Audience: a TypeScript learner studying an agent memory system.
Visual system: white background, dark navy large text, blue context, amber curated memory, purple history/search; flat precise cards, subtle dividers, readable Chinese sans-serif and exact English monospace names. Wide composition around 16:9, no illustrations of robots, no logos, no decorations, no watermark.
Layout: two equal columns headed "Hermes Agent" and "my-hermes · TypeScript", with aligned rows and short category labels in a thin center spine.
Row 1 category "精选记忆": both columns show "MEMORY.md / USER.md" and smaller "新会话自动加载".
Row 2 category "历史工具": left "session_search"; right "history_search".
Row 3 category "候选召回": left "FTS5 + trigram"; right "LIKE 子串查询".
Row 4 category "结果排序": left "FTS 相关性排序"; right "L3 词项命中数".
Row 5 category "上下文压缩": left "ContextCompressor · Python"; right "异步 L2 · TypeScript".
Row 6 category "预算计量": left "真实 usage + 估算回退"; right "序列化字符预算".
Row 7 category "长期整理": both show "memory · add / patch / remove".
At bottom add a broad amber callout: "本项目：压缩前 memory-only flush → 有界批次写入".
Footer exact: "设计借鉴 ≠ 上游完整实现". Small date "研究快照：2026-11-08".
Accuracy constraints: do not portray local LIKE as FTS5 or vector search; do not claim current project has actual token accounting; do not combine the history-search tool with memory write tool; don't imply short-term summaries are automatically long-term facts. Keep all rows horizontally aligned, large legible labels, no tiny explanatory paragraphs.
```

## 06 冻结快照时间线

- 交付文件：[06-frozen-snapshot-timeline.png](06-frozen-snapshot-timeline.png)。
- 原始产物说明：Generated images are saved to /Users/bill/.codex/generated_images/01a17117-30b6-75f1-8d34-bfb76c7e7efc as /Users/bill/.codex/generated_images/01a17117-30b6-75f1-8d34-bfb76c7e7efc/exec-b105bbdd-7ce0-4e72-9725-d87e1007fd96.png by default.
- 图像检查：已目视确认：旧会话 system v1 不变、工具响应可以看到 v2、文件立即落盘、新会话读 v2。底部明确标注本项目；上游压缩提交边界可刷新 memory 的例外由主文单独说明。

### 最终生成提示词

```text
Use case: scientific-educational
Asset type: landscape technical documentation infographic, Chinese, high resolution.
Primary request: Draw the exact frozen-memory-snapshot timeline, title verbatim "冻结快照：写入后，谁能看到新记忆？".
Style: coherent with a clean agent-memory documentation series: white background, dark navy large typography, blue session/context cards, amber persistent Markdown file, purple tool responses; understated flat forms, wide 16:9, crisp very legible Chinese, no robots, no watermarks.
Composition: three horizontal time stages T0, T1, T2, with two clearly separated lanes for session A and persistent USER.md plus a new session B at the right.
T0 left: an amber "USER.md · v1" file with the short example text "偏好：英文说明". A solid arrow labeled "会话开始读取" goes to a blue "会话 A · System v1" card. Add a small blue badge "快照冻结".
T1 center: a purple tool-call card "memory · patch" with example text "改为中文说明", arrow labeled "立即落盘" to amber "USER.md · v2" with text "偏好：中文说明". Session A's blue card remains "System v1"; nearby exact label "当前 system 不刷新". A distinct purple tool response bubble says "工具响应可见 v2"; do not connect v2 back into System v1.
T2 right: a new blue "会话 B · System v2" receives an arrow from the v2 file labeled "新会话读取". A short callout says "新会话知道：中文说明".
Bottom footer exact: "文件已更新 ≠ 当前 system 已更新". Smaller note: "本项目：/new 或更换 --session；重启 CLI 不必然创建新会话".
Technical invariants: the new long-term fact persists immediately when the memory tool succeeds; only the initial system snapshot of the old session remains unchanged, not all future assistant knowledge. Do not claim session A cannot know the updated preference at all, since it has the user/tool messages. Do not show memory writes going to SQLite. USER.md and MEMORY.md obey the same snapshot principle. Keep the diagram about this one timing concept with large readable labels and no dense explanatory prose.
```

