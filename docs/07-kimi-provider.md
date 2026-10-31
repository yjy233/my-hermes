# Kimi Provider：配置、运行与协议回归

`src/core/providers/kimi.ts` 的 `KimiProvider.complete` 已完整实现，可直接用于真实 API。它独立处理 HTTP 请求、响应、工具调用、推理字段、超时和取消，不以调用 kimi-reference.ts 代替实现。参考版仍保留，供阅读和协议对照；L1～L5 的 Agent 算法练习继续保留。

## 填入 API key 后测试

1. 打开项目根目录的 `.env`；不存在时从 [.env.example](../.env.example) 复制一份。
2. 在 MOONSHOT_API_KEY 后填入对应平台的 API key。密钥只放本地 `.env` 或 shell 环境，不写入 config.json。
3. 运行离线协议检查和本地配置检查：

```sh
npm run kimi:check
npm run kimi:doctor
```

kimi:check 用本机 mock HTTP 服务与测试密钥检查主实现，不连接 Moonshot。kimi:doctor 不调用模型，只检查配置；apiKeyConfigured 为 true 表示检测到非空密钥，不代表已经验证密钥有效或模型权限，输出不会显示密钥值。

填好真实密钥后，由你在本机运行：

```sh
npm run kimi:test
npm run kimi:chat
```

kimi:test 发出一次真实请求，要求只回复“Kimi 连接成功”；kimi:chat 开始真实交互。两个脚本都选择 Kimi 主实现和参考 Core，直接可用，不要求先补齐 L1～L5。本次仓库验证只使用离线与 mock 协议，没有代你调用在线 Kimi。

CLI 默认读取运行目录下的 `.env`，也可指定文件：

```sh
npm run dev -- doctor --provider kimi --env-path ./.env.local
```

已存在的 shell 环境变量优先于文件，包括显式设置的空值；文件只补充缺失项。支持 MOONSHOT_API_KEY 和 KIMI_API_KEY，Kimi 不回退读取 OPENAI_API_KEY。若更新文件后行为没变，先检查 shell 是否仍设置旧值；不需要把密钥打印到终端排查。

## 模型、地址与超时配置

运行配置位于本地 `.hermes-lab/config.json`，示例见 [examples/config/kimi.json](../examples/config/kimi.json)。配置和 `.env` 均应留在本地；已存在的 profile 不会被初始化过程覆盖。kimi:* 脚本显式选择 Kimi 和参考 Core，旧 profile 的 provider 选择不会使测试误用 Demo。

| 配置 | 含义 |
| --- | --- |
| provider: kimi | 使用 Kimi 连接器 |
| providerMode: learner | 使用 kimi.ts 中已经完成的主实现；reference 选择独立对照版 |
| mode: reference | 使用完整 Agent 算法，L1～L5 未完成也可聊天 |
| model: kimi-k3.1-pro | 本项目验证过协议的模型基线 |
| baseUrl | 国内 https://api.moonshot.cn/v1；国际 https://api.moonshot.ai/v1 |
| providerTimeoutMs | 单次模型请求超时，通用默认 30000 ms，Kimi 示例使用 60000 ms |
| turnTimeoutMs | 整个 Agent 回合超时，Kimi 示例使用 180000 ms |
| contextChars | 消息与工具 schema 的近似字符预算，Kimi 示例使用 64000 |

修改对应的本地配置即可调整模型、地址和超时；改变模型前核对参数兼容性，切换区域时使用对应平台创建、具备模型权限的 key。显式 --model/--base-url 优先于配置；切到不同 provider 时会使用其预设，避免误沿用本地模型服务地址。

## 已实现的协议能力

本项目于 **2026-10-28** 再次核对官方文档。K3.1 Pro 始终启用推理，使用顶层 reasoning_effort；不能沿用 K2 的 thinking 开关。本实现使用 low，保留完整推理字段，不把 low 当成关闭推理。[官方模型说明](https://platform.kimi.ai/docs/guide/kimi-k3-1-pro-quickstart)、[Reasoning Effort](https://platform.kimi.ai/docs/guide/use-reasoning-effort)。

- 请求通过内置 fetch 发往 /chat/completions，使用 Bearer key；完整 JSON 模式 stream=false。
- 使用 reasoning_effort=low 和 max_completion_tokens=8192，省略固定的采样参数；8192 是项目预算，不保证复杂任务一定能完成。
- 限制响应字节数，严格解析 UTF-8、JSON 与 assistant 消息，校验工具参数和调用 ID。
- stop 表示最终结果，tool_calls 表示执行工具；length 等不完整状态报错，不能当作最终答复。
- 外部 AbortSignal 与请求超时共同生效；错误报告保留类别，不直接打印远端错误正文、密钥或原始推理内容。

端点和生成上限参数以 [国内 Chat API](https://platform.moonshot.cn/docs/api/chat) 与 [国际 Chat API](https://platform.moonshot.ai/docs/api/chat) 为准。官方当前推荐 max_completion_tokens；文档链接可能重定向到新的官方 Kimi 域名。

## reasoningContent 的完整往返

K3 多轮对话和工具循环要求回传完整 assistant 消息，包括 reasoning_content 与 tool_calls，不能只保留 content。[官方多轮要求](https://platform.kimi.ai/docs/guide/use-reasoning-effort)。

Provider 将 reasoning_content 映射成内部 `reasoningContent?: string`；Core 保留到 assistant 消息，SQLite payload 完整存储，再由 toWireMessage 还原发送。该字段最多 32000 字符，并计入总体上下文预算。

聊天最终只显示 content，trace 不打印原始推理字段。本地 history 可检查存储的协议消息，可能包含 reasoningContent；查看原始历史与显示最终回复是不同的入口。

## 阶段 0 继续用作独立回归

```sh
npm run dev -- check --stage 0 --mode learner --trace
npm run dev -- check --stage 0 --mode reference --trace
```

两个实现都应通过。阶段 0 只访问本机 mock，不调用在线服务；check 的 --mode 选择被验收的 Provider，不受运行时 --provider-mode 影响。具名 case 检查文本、工具、推理字段、异常和取消，后续改连接代码时可单独重跑。

VS Code 可选“Kimi Provider：离线验收”，按 F5 选择 mode，在 complete 内设置断点。普通 case 默认 3000 ms 等待上限，--debug 停用这层计时；Provider 自身预算仍独立。

两个运行选项的作用保持分开：

| 选项 | 控制什么 |
| --- | --- |
| --mode reference / learner | Agent 的 L1～L5；在 check 中选择当前阶段实现 |
| --provider-mode learner / reference | Kimi 主实现 / 对照实现；主实现已完成 |

完整命令等价于快捷脚本，可按需指定地址或消息：

```sh
npm run dev -- chat --provider kimi --provider-mode learner --mode reference \
  --message '请使用计算工具计算 (2+3)*4，并核对结果' --trace
```

L1～L5 尚未实现时使用 --mode reference；完成后可切 learner 测试自己的 Agent。在线结果还取决于账户权限、网络与服务响应，离线协议通过不能替代你填入真实 key 后的在线联调。
