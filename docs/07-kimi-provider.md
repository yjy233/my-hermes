# Kimi Provider 练习（L0）

先独立实现真实模型连接，再组合 Agent。L0 的学习入口是 `src/core/providers/kimi.ts` 中的 `KimiProvider.complete`；它是明确的 TODO，不会偷偷调用完整答案。参考实现放在 `kimi-reference.ts`，公共选项与默认值放在 `kimi-shared.ts`，运行入口通过 `createProvider` 选择实现。

## 先离线验收，再接真实 API

```sh
npm run dev -- check --stage 0 --mode reference --trace
npm run dev -- check --stage 0 --mode learner --trace --debug
```

阶段 0 使用本机 mock HTTP 服务与测试密钥，验收选中 Provider 的真实请求/响应链路；不连接 Moonshot，不读取真实密钥，也不产生在线调用费用。`--mode` 在这里选择 L0 的 learner/reference，`--provider-mode` 不参与阶段选择。具名 case 检查消息转换、工具调用、推理字段、错误和取消，失败结果指出 L0 与具体 case。

VS Code 的“运行和调试”可选择 **Kimi Provider：离线验收**，按 F5 后选择 mode；通用阶段配置也可选 stage 0。断点先放在 `kimi.ts` 的 complete，再查看共享消息转换和实际 HTTP 请求。普通 case 有 3000 ms 等待上限，`--debug` 停用这层计时以便单步，Provider 自身超时仍独立存在。

## 协议基线与依据

本项目于 **2026-10-25** 核对官方文档，选择 `kimi-k3.1-pro` 作为教学基线。它始终启用推理，使用顶层 `reasoning_effort`，不能沿用 K2 的 `thinking` 开关；固定采样参数应省略。这里选 low 降低入门场景的推理强度，不代表模型关闭推理。[K3.1 Pro 官方说明](https://platform.kimi.ai/docs/guide/kimi-k3-1-pro-quickstart)、[Reasoning Effort](https://platform.kimi.ai/docs/guide/use-reasoning-effort)。

| 项目 | 教学约定 |
| --- | --- |
| 默认模型 | kimi-k3.1-pro；其他模型须自行核对参数兼容性 |
| 国内 API root | https://api.moonshot.cn/v1 |
| 国际 API root | https://api.moonshot.ai/v1 |
| 请求路径 | 在 root 后追加 /chat/completions |
| 身份认证 | Authorization: Bearer，加对应平台创建的 API key |
| 响应模式 | stream=false，完整 JSON 响应 |
| 推理参数 | reasoning_effort=low；不发送 thinking |
| 生成预算 | max_completion_tokens=8192；本项目预算，不保证复杂任务一定能完成 |
| 采样参数 | 省略 temperature、top_p、n 与 penalty 参数 |

两个区域的请求入口见 [国内 Chat API](https://platform.moonshot.cn/docs/api/chat) 和 [国际 Chat API](https://platform.moonshot.ai/docs/api/chat)。官方当前推荐 max_completion_tokens，max_tokens 已标记弃用；命中生成上限会返回 length，不能把截断内容当成已完成答复。上述端点的文档地址可能重定向到新的官方 Kimi 文档域名。

## 你需要实现什么

1. 检查配置、密钥和 signal，在请求开始前拒绝已取消的调用。读取共享选项，别把密钥、模型、地址硬编码进函数。
2. 把内部消息转换成 wire 格式，保留正文、工具调用与已有 reasoningContent；附带工具 schema、正确的 Kimi 参数和 Bearer header，使用 Node 内置 fetch 发起 POST。
3. 结合外部 signal 与 Provider 超时，限制响应字节数，严格解析 UTF-8 和 JSON；结束时清理等待与资源。超时和失败不允许返回伪造最终文本。
4. 检查 choices、assistant 角色、finish_reason 和消息结构。stop 表示最终答复，tool_calls 表示请求执行工具；length 等未完成状态应报错。工具参数是 JSON 字符串，解析后仍需有限值、大小与结构检查。
5. 将 content、tool_calls 和 reasoning_content 转成内部 ModelResponse；调用共享响应校验，拒绝空结果、重复调用 ID、超额内容和非法参数。不要只取 content 而丢掉模型需要的协议字段。
6. 返回可区分的错误类别，远端错误正文可能含请求内容，不能直接打印；trace 只记录阶段、步骤、工具名称等元数据。不要把密钥或原始推理字段写入 trace。

这是任务契约，不提供 complete 的实现代码。先让正常文本与工具返回通过，再逐项处理失败、边界与取消；需要对照时再读 kimi-reference.ts。

## 为什么要保存 reasoningContent

K3 多轮对话与工具调用要求回传完整 assistant 消息，包括 reasoning_content 和 tool_calls。只保存最终 content，会破坏后续请求所需的协议上下文。[官方多轮要求](https://platform.kimi.ai/docs/guide/use-reasoning-effort)。

内部字段为 `reasoningContent?: string`，wire 字段为 reasoning_content。L0 负责解析并返回，Core 的 runLoop 保留到 assistant 消息，SQLite payload 完整持久化，下一次请求通过 toWireMessage 回传。该字段受 32000 字符上限和总体上下文预算约束，不能放到预算之外。

聊天最终只显示 content，trace 不打印原始推理内容。数据库保留协议原始消息，本地 history 检查可能看到对应字段；查看状态与展示最终答复是不同的入口。

## 两个独立的 mode

| 选项 | 控制什么 |
| --- | --- |
| --mode reference / learner | Agent 的 L1～L5；在 check 中控制当前阶段学习实现，包括 L0 |
| --provider-mode reference / learner | 真实运行时 Kimi Provider 的实现；Kimi 默认 learner |

因此，你可以用完整参考 Agent 调试自己的 Provider，不必先完成其他练习：

```sh
# 在本机设置对应平台的真实 API key，不写入 config.json
export MOONSHOT_API_KEY='YOUR_PLATFORM_API_KEY'
npm run dev -- chat --provider kimi --provider-mode learner --mode reference \
  --message '请调用计算工具计算 (2+3)*4，并核对结果' --trace
```

也接受 KIMI_API_KEY；Kimi 不使用 OPENAI_API_KEY 作为兜底。L0 尚未实现时，上述命令明确失败；只想对照请求链路，可改 `--provider-mode reference`。

默认使用国内 root。切换国际区时显式指定地址，并使用对应区域平台创建、具备模型权限的 key：

```sh
npm run dev -- chat --provider kimi --provider-mode reference --mode reference \
  --base-url https://api.moonshot.ai/v1 --model kimi-k3.1-pro \
  --message '请用工具计算 6*7'
```

显式切到 `--provider kimi` 会使用 Kimi 的模型与地址预设，避免沿用之前本地服务的 model/baseUrl；显式 --model/--base-url 优先。保持 provider 为 demo 或 compatible 时，Kimi 的 Provider 练习不会被误调用。

在线调用需要你的平台 key、账户模型权限和网络连通性。本仓库只完成离线与 mock 协议验收，没有使用真实凭证请求在线 Kimi；离线通过后，仍应由你在本机验证真实账户的文本、工具循环和多轮恢复。
