/** L1～L3 是运行时实际调用的学习实现；L4/L5 保留为练习。 */
import { abortable } from '../core/async.js';
import { ExerciseNotImplemented, StepLimitExceeded } from '../core/errors.js';
import { requestSize, validateModelResponse, type Emit, type Message, type Provider, type ToolSchema } from '../core/models.js';
import type { ToolRegistry } from '../core/tools.js';
import type { MemoryHit } from '../memory/store.js';
import type { CompressionResult, CompressionRuntime } from '../core/compression/types.js';
import { assembleSummary, buildSummaryPrompt, deterministicSummary, elide, redact, summaryMessage, withoutSummaries } from '../core/compression/text.js';
import { messagesSize, planWindow, pruneHistory } from '../core/compression/window.js';

/**
 * L1：执行一次用户任务中的“模型决策 → 工具执行 → 再次决策”循环。
 *
 * 典型消息顺序：
 *   原始历史和用户问题
 *     → assistant：声明要调用哪些工具
 *     → tool：依次记录每个工具的执行结果
 *     → assistant：给出最终答复，或继续声明下一组工具
 *
 * 返回值只有本轮新增的 assistant/tool 消息。
 * 原始的 system/user/历史消息由调用方管理，不能重复放进返回值。
 * 函数也不直接打印文本；外层 Agent 在成功后保存 delta，并展示最后一条消息的 content。
 *
 * @param provider 模型适配器，负责 HTTP 请求和响应转换；本循环不用拼接 API 请求。
 * @param registry 工具注册表，负责提供工具 schema，并按调用名称执行具体工具。
 * @param messages 初始上下文，通常包含系统提示、已有历史和当前用户的问题。
 * @param maxSteps 本轮最多请求模型的次数，包含最后一次生成最终答复的请求。
 * @param emit 执行进度回调，CLI 的 --trace 用它展示模型和工具的开始、结束事件。
 * @param signal 调用方传入的取消信号，需要继续传给模型和工具。
 * @returns 本轮新增消息组成的数组，最后一条是没有工具调用的 assistant 最终答复。
 */
export async function runLoop(
  provider: Provider,
  registry: ToolRegistry,
  messages: Message[],
  maxSteps: number,
  emit: Emit,
  signal?: AbortSignal,
): Promise<Message[]> {
  // 1. 明确本轮最多能请求多少次模型。
  // 一次 complete 算一步，同一响应里的多个工具调用仍属于这一步。
  // 例如“请求一次工具，再根据结果答复”需要至少两步；纯文本答复只需要一步。
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) {
    throw new Error('maxSteps 必须是大于 0 的安全整数');
  }

  // 2. 分开维护“模型上下文”和“需要返回的新消息”。
  // context 从原始历史开始，随后不断追加消息，供下一次模型请求使用。
  // 复制数组后再 push，不会把本轮消息直接写进调用方传入的 messages 数组。
  const context: Message[] = [...messages];
  // delta 从空数组开始，只积累本轮生成的消息，成功结束时交给外层持久化。
  const delta: Message[] = [];

  for (let step = 0; step < maxSteps; step++) {
    // 3. 在请求开始前响应取消，避免已经取消的任务继续发起模型调用。
    signal?.throwIfAborted();
    emit('model.start', { step, messageCount: context.length });

    // 这是正式模型请求，必须位于循环内部，并使用已经包含工具结果的 context。
    // schemas 告诉模型有哪些工具可选；真正执行工具的仍然是下面的 registry.execute。
    // 把 signal 传给 Provider，同时用 abortable 及时停止等待不配合取消的 Provider。
    // 实际网络请求能否停止，仍取决于 Provider 对 signal 的处理。
    // 不吞掉异常：HTTP 失败、超时等错误应保留原始原因，交给外层处理。
    const response = await abortable(
      provider.complete(context, registry.schemas(), signal),
      signal,
    );

    // 请求期间也可能发生取消，因此响应返回后再检查一次，不接收迟到结果。
    signal?.throwIfAborted();

    // 4. 先校验响应，再写入消息数组或执行工具。
    // 共享校验会拒绝空响应、重复调用 ID、过多工具调用和超长/非法字段。
    validateModelResponse(response);
    // 将“未提供 toolCalls”和“提供空数组”统一为没有工具调用，简化后续分支。
    const toolCalls = response.toolCalls ?? [];

    // 5. 模型的一次响应对应一条 assistant 消息。
    // Provider 返回的 ModelResponse 没有 role，这里补上 assistant 才成为完整的 Message。
    // 即使模型同时返回文本和工具调用，也需要完整保留，不能看到 content 就提前结束。
    const assistant: Message = {
      role: 'assistant',
      content: response.content,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      // Kimi 等思考模型的后续工具请求需要回传 reasoningContent。
      // 它属于协议上下文，不应拼接到最终展示给用户的 content 中。
      ...(response.reasoningContent !== undefined
        ? { reasoningContent: response.reasoningContent }
        : {}),
    };
    context.push(assistant);
    delta.push(assistant);

    // 6. 没有工具调用，就说明这条经过校验的 assistant 消息是最终答复。
    // 返回 delta，而不是包含原始历史的 context，避免外层重复保存历史消息。
    if (toolCalls.length === 0) {
      emit('turn.final', { step });
      return delta;
    }

    // 7. 有工具调用时，必须预留下一次模型请求来理解结果并形成最终答复。
    // 若已到最后一步，在执行工具之前报错，避免启动没有后续处理机会的新副作用。
    // 此限制不会回滚此前步骤已经执行过的工具。
    if (step === maxSteps - 1) {
      throw new StepLimitExceeded(`No final answer after ${maxSteps} model steps`);
    }

    // 8. 按声明顺序逐个执行本次响应中的所有工具，保持消息顺序便于调试。
    // assistant 工具声明必须在 tool 结果之前；全部结果追加后，才进入下一轮模型请求。
    for (const call of toolCalls) {
      signal?.throwIfAborted();
      emit('tool.start', { name: call.name, callId: call.id });

      // Registry 负责参数校验、限时执行和错误包装，并设置对应的 toolCallId。
      // 普通工具失败会得到 ok:false 的 tool 消息，让模型观察后决定下一步。
      // 调用方取消则继续抛出取消异常，不能伪装成普通工具失败后继续循环。
      const result = await registry.execute(call, signal);
      signal?.throwIfAborted();
      emit('tool.end', { name: call.name, callId: call.id });
      context.push(result);
      delta.push(result);
    }
    // 下一次循环会携带本次 assistant 声明及全部 tool 结果重新请求模型。
  }

  // 防御性兜底：只允许通过“最终答复”正常返回，绝不把最后一条工具结果冒充答案。
  throw new StepLimitExceeded(`No final answer after ${maxSteps} model steps`);
}
/**
 * L2：每次模型请求前执行的异步上下文压缩，包含触发、清理、摘要和失败后的选择。
 * 对应 Hermes ContextCompressor.compress 的职责；不调用 reference 答案。
 *
 * runtime 提供模型请求、超时、辅助模型回退、冷却状态与提交校验；
 * window.ts 管理工具配对/头尾边界，text.ts 负责 prompt 与上下文重组。
 * 这里只返回模型要看的工作上下文，SQLite 中的完整原始消息由 Agent 单独保存。
 */
export async function compactHistory(
  messages: Message[], tools: ToolSchema[], runtime: CompressionRuntime,
  signal?: AbortSignal, force = false,
): Promise<CompressionResult> {
  signal?.throwIfAborted();
  const { settings, maxChars } = runtime;
  const originalSize = requestSize(messages, tools);
  const state = runtime.snapshot();

  // 1. 正常请求看软阈值、失败冷却和增长量。远端确认溢出时 force 可绕过这些门槛。
  if (!settings.enabled || (!force && originalSize < maxChars * settings.threshold)) {
    return { messages, changed: false };
  }
  if (!force && state.cooldownUntil > Date.now()) return runtime.skipped(messages, 'cooldown', originalSize);
  if (!force && originalSize <= maxChars && originalSize < state.nextAttemptChars) {
    return runtime.skipped(messages, 'no-progress-backoff', originalSize);
  }
  runtime.emit('compression.start', { beforeChars: originalSize, forced: force });
  const messageBudget = maxChars - JSON.stringify(tools).length;
  if (messageBudget < 512) return runtime.skipped(messages, 'tool-schemas-exhaust-budget', originalSize, true);

  // 2. 先做无模型成本的清理。只改副本，最新工具组保留完整；足够小就直接采用。
  const cleaned = pruneHistory(messages, messageBudget, settings);
  const cleanedSize = requestSize(cleaned, tools);
  if (!force && cleanedSize < maxChars * settings.threshold && originalSize - cleanedSize >= 256) {
    return runtime.commit(messages, cleaned, tools, 'prune');
  }

  // 3. 对齐工具调用组，划分受保护的头尾与待总结的中段，并为摘要留出实际空间。
  const window = planWindow(cleaned, messageBudget, settings);
  if (!window) return runtime.skipped(messages, 'no-middle-window', originalSize, true);
  const reloadNotes = window.skills.length === 0 ? '' : '\n\n## Skills to reload\n' + window.skills
    .map(name => `[Reload skill: ${name}] Call skill_read before using its procedure.`).join('\n');
  const protectedSize = messagesSize(assembleSummary(window.head, summaryMessage(reloadNotes), window.tail));
  const summaryBudget = Math.floor(Math.min(settings.summaryChars, messageBudget * 0.2, messageBudget - protectedSize));
  if (summaryBudget < 256) return runtime.skipped(messages, 'protected-context-exhausts-budget', originalSize, true);
  if (messagesSize(window.middle) + window.previous.length < summaryBudget + 256) {
    return runtime.skipped(messages, 'middle-too-small', originalSize, true);
  }

  // 4. 摘要 prompt = 固定结构要求 + 旧摘要 + 冻结记忆 + 中段轨迹 + 最新请求重点。
  // buildSummaryPrompt 会按序列化大小限长、脱敏，并区分真实用户输入和合成摘要。
  const currentRequest = withoutSummaries(messages).findLast(message => message.role === 'user');
  const prompt = buildSummaryPrompt({
    middle: window.middle, previous: window.previous, memory: runtime.memory,
    focus: runtime.focus ?? currentRequest?.content ?? '', summaryChars: summaryBudget,
    inputChars: maxChars, date: new Date().toISOString().slice(0, 10), hasUserTurn: window.hasUserTurn,
  });
  const generated = prompt ? await runtime.generate(prompt, signal) : null;
  // 取消不能转成本地兜底，也不能让迟到响应产生新的上下文。
  signal?.throwIfAborted();

  // 5. generate 负责有界模型回退和错误分类；L2 决定保留历史还是允许降级。
  // 空摘要、截断、鉴权、网络等失败保留原始输入，连上面的工具清理也不提交。
  if (!generated && prompt && runtime.mustPreserveHistory()) {
    return runtime.skipped(messages, 'summary-failed-preserve-history', originalSize);
  }
  if (!generated && settings.abortOnFailure) return runtime.skipped(messages, 'summary-required', originalSize);
  const summaryBody = generated ?? deterministicSummary(window.middle, window.previous,
    prompt ? runtime.snapshot().lastFailure ?? 'unavailable' : 'summary-input-budget', summaryBudget);

  // 6. 摘要作为历史参考，当前用户请求仍保留。技能重读标记由程序补回。
  // commit 再检查硬预算和实际缩减，避免越压越大或无效重复压缩。
  const summary = summaryMessage(elide(redact(summaryBody), summaryBudget) + reloadNotes, window.hasUserTurn);
  const nextContext = assembleSummary(window.head, summary, window.tail);
  return runtime.commit(messages, nextContext, tools, generated ? 'summary' : 'fallback');
}

// 历史召回，让 Agent 能找到被压缩出上下文的原始对话。
export function selectMemories(query: string, hits: MemoryHit[], limit: number): MemoryHit[] {
  // 1. history_search 先用 SessionStore.search 按 scope 查完整 messages 表。
  // 候选可以来自当前或其他 session；这里不接收 scope，也不自行读取别人的记录。
  if (!Number.isSafeInteger(limit)) throw new RangeError('Memory limit must be a safe integer');
  if (limit <= 0 || !query.trim() || !hits.length) return [];

  // 2. 提取查询里的字母、数字、下划线词项，大小写不敏感，重复词只计一次。
  // 中文连续文字作为一个子串；这不是分词模型或向量语义检索。
  const normalized = query.trim().toLowerCase();
  const terms = new Set(normalized.match(/[\p{L}\p{N}_]+/gu) ?? [normalized]);
  const ranked = hits.map((hit, index) => {
    const content = hit.content.toLowerCase();
    let relevance = 0;
    for (const term of terms) if (content.includes(term)) relevance++;
    return { hit, index, relevance };
  });

  // 3. 命中更多不同词项的记录优先；同分沿用候选顺序（数据库默认较新优先）。
  // 排序装饰后的新数组，不改原 hits、正文或存储层 score，最后应用数量上限。
  ranked.sort((left, right) => right.relevance - left.relevance || left.index - right.index);
  return ranked.slice(0, limit).map(item => item.hit);
}
export function sessionKey(_channel: string, _conversationId: string, _userId: string): string {
  // L4：将渠道、会话、用户三个维度编码成稳定且不易碰撞的会话键。
  throw new ExerciseNotImplemented('L4: implement learning/exercises.ts sessionKey');
}
export function reflect(_transcript: Message[]): string | null {
  // L5：仅从包含成功工具执行的完整轮次生成待审核 Skill 正文，其余情况返回 null。
  throw new ExerciseNotImplemented('L5: implement learning/exercises.ts reflect');
}
