# Gateway 与连接器调试

Gateway 接收统一事件，Core 不依赖 JSONL 或 HTTP。当前实现两个本地连接器；真实 IM 平台后续实现独立适配器，不把平台 SDK 放进 Core。

## 消息协议

事件恰好包含五个 camelCase 字符串字段：

```json
{"eventId":"msg-001","channel":"jsonl","conversationId":"study-room","userId":"alice","text":"你好"}
```

ID 最多 256 字符且不能含控制字符，正文最多 16000 字符；归一化函数为 `parseInbound`。成功输出为 `eventId/sessionKey/text/cached`。同一事件应重用稳定 eventId，新消息使用新 ID。

L4 `sessionKey(channel, conversationId, userId)` 包含完整路由三元组。同房间不同用户隔离；长期记忆 scope 使用 `[channel,userId]`，同渠道同用户可跨会话共享记忆。

## 并发、重试与持久化

`Gateway.handle(message, signal?)` 通过 Promise 队列串行处理同一会话，不同会话可并发；排队时可以取消。成功回复进入 SQLite 的 gateway_events 表。重复已完成事件返回相同正文与 `cached: true`，重启后仍有效；同一事件 ID 改正文会冲突，失败不写成功缓存。

取消、超时或崩溃可能发生在工具副作用之后、成功缓存之前。AbortSignal 能停止配合取消的异步调用，不能回滚已经发生的操作，也不能中断任意同步代码。重试前检查实际结果，外部工具应提供幂等键或 outbox，不能把成功缓存当成 exactly-once 保证。

## Profile 所有权与崩溃恢复

`chat/gateway` 在整个运行期间持有 `ProfileLock`。它以原子 mkdir 创建 `<home>/.runtime.lock/`，owner.json 保存 PID 和随机 token；正常退出核对 token 后删除 owner.json 与目录。

异常退出不会由操作系统自动清除目录锁。再次启动遇到已有目录时一律拒绝，不根据 PID 自动回收，避免误删仍属于另一个实例的锁。

恢复步骤：

1. 查看 `<home>/.runtime.lock/owner.json` 中的 PID。
2. 确认原 chat/gateway 进程已经停止，且没有其他实例使用该 profile。
3. 仅删除该锁目录内的 owner.json，再删除空的 `.runtime.lock` 目录，然后重新启动。

默认 profile 在 POSIX shell 中可这样检查；确认进程退出后才执行最后两条：

```sh
cat .hermes-lab/.runtime.lock/owner.json
# 用系统进程查看器核实上面记录的进程已经结束
rm .hermes-lab/.runtime.lock/owner.json
rmdir .hermes-lab/.runtime.lock
```

使用其他 `--home` 时替换路径。不要删除 sessions.db 或 memory/ 来恢复锁。编程调用 Gateway 时也应在整个生命周期使用 ProfileLock；它是本机所有权约束，不是分布式租约。

## JSONL 连接器

`runJsonl(gateway, input, output)` 按字节切分输入，每行最多 64000 字节，严格检查 UTF-8；错误行输出结构化 error 和行号，继续后续输入，空行跳过。成功与错误都一行一个 JSON。

```sh
npm run dev -- gateway --connector jsonl --allow-user learner <<'JSONL'
{"eventId":"debug-001","channel":"jsonl","conversationId":"room","userId":"learner","text":"/calc 2+2"}
{"eventId":"debug-001","channel":"jsonl","conversationId":"room","userId":"learner","text":"/calc 2+2"}
JSONL
```

第一行执行，第二行 cached 为 true。重启后重发仍命中缓存；要观察一次新执行，请换 eventId。可在中间插入 not-json 检查错误恢复。

## 本机 HTTP

`GET /health` 提供本机健康检查；`POST /message` 需要 `Authorization: Bearer <token>` 和用户 allowlist。CLI 只监听 loopback：127.0.0.1、localhost 或 ::1。默认 body 上限 64000 字节；编程选项 maxBodyBytes 最多可设为 1 MiB。

```sh
export MY_HERMES_GATEWAY_TOKEN='local-debug-token-change-me'
npm run dev -- gateway --connector http --host 127.0.0.1 --port 8765 --allow-user learner
```

另一个终端：

```sh
export MY_HERMES_GATEWAY_TOKEN='local-debug-token-change-me'
curl -s http://127.0.0.1:8765/health
curl -s http://127.0.0.1:8765/message \
  -H "Authorization: Bearer $MY_HERMES_GATEWAY_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"eventId":"http-001","channel":"http","conversationId":"room","userId":"learner","text":"/calc 2+2"}'
```

默认 HTTP 总请求等待为 130000 ms，Core 回合默认 120000 ms；超时向 Agent 传递取消并返回 504，客户端断开也会传播 signal。忽略取消的自定义异步工作仍可能继续，失败或取消后不会因此写成功缓存。

`createHttpServer(gateway, options)` 返回尚未 listen 的 `node:http` Server，编程调用方负责按校验过的 loopback host 监听，并在退出时关闭服务和 Gateway。HTTP token 认证本机调用方；userId 由这个可信调用方提供。生产 IM 连接器必须验证平台签名并从认证事件提取身份，不能信任公网 JSON 中自报的 userId。

## 断点与验收

在 `src/gateway/router.ts` 检查授权、会话队列、缓存，在 `src/connectors/jsonl.ts` 检查分帧与错误恢复，在 `src/connectors/http.ts` 检查认证、body 限额与取消。`npm test` 验证路由、并发、重启去重、协议、锁所有权与本机 HTTP；`npm run dev -- check --stage 3 --mode reference` 单独观察 Gateway 场景。
