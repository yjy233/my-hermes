/** L1～L5 都是 learner 模式实际调用的实现，可与 reference 模式逐项对照。 */
import { abortable, withTimeout } from '../core/async.js';
import { StepLimitExceeded } from '../core/errors.js';
import { requestSize, validateModelResponse, type Emit, type Message, type Provider, type ToolSchema } from '../core/models.js';
import type { ToolRegistry } from '../core/tools.js';
import type { MemoryHit } from '../memory/store.js';
import type { CompressionResult, CompressionRuntime } from '../core/compression/types.js';
import { assembleSummary, buildSummaryPrompt, deterministicSummary, elide, redact, summaryMessage, withoutSummaries } from '../core/compression/text.js';
import { messagesSize, planWindow, pruneHistory } from '../core/compression/window.js';
import { reviewTools } from '../evolution/review-tools.js';
import { reflectionBody, reflectionMessages, reviewableTurn, type ReflectionOptions, type ReflectionResult } from '../evolution/reflection.js';

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
 * Persistent Goals 的“轮数”在这个函数之外：一次 runLoop 可以包含多次 complete，
 * 但只有整轮回答落盘后才消耗一次 goal turns_used，见 goals/runtime.ts。
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

/**
 * L3：对已经召回的历史候选做去重与重排，让模型优先看到有用的原文。
 *
 * 分工要清楚：SessionStore 的 FTS5/trigram/LIKE 负责“找出哪些消息”，
 * 本函数负责“给这些候选排顺序、最多返回多少条”。它不再查询数据库，
 * 也不能自行扩大 scope；候选必须由调用方提前按当前用户隔离。
 * FTS5 仍属于关键词检索，不会自动拥有向量检索的语义理解能力。
 */
export function selectMemories(query: string, hits: MemoryHit[], limit: number): MemoryHit[] {
  // 1. limit 是工具结果的条数上限，不是字符数。拒绝 NaN/Infinity/小数，
  // 避免 slice 隐式取整，让调用方以为自己的上限被正确执行了。
  if (!Number.isSafeInteger(limit)) throw new RangeError('Memory limit must be a safe integer');
  if (limit <= 0 || !query.trim() || !hits.length) return [];

  // 2. 查询词去重并忽略大小写。“TypeScript typescript 记忆”只有两个词项。
  // 连续中文这里仍是一个词项；候选层的 trigram 负责中文子串召回。
  // 若查询只有 % 等符号，则把整个查询当字面词项，不能把它变成通配符。
  const normalized = query.trim().toLowerCase();
  const terms = new Set(normalized.match(/[\p{L}\p{N}_]+/gu) ?? [normalized]);

  // 3. 同一条数据库消息可能从不同召回路径重复进入候选，用稳定身份去重。
  // 不按 content 去重：两次不同会话说了同一句话，仍是两条不同的经历。
  // 还没入库的 live 消息可能没有 messageId，此时不能猜测它的持久身份。
  // 去重要在截断条数之前完成，否则“前五条有三条重复”会意外只剩两条。
  const seen = new Set<string>();
  const ranked: { hit: MemoryHit; index: number; relevance: number; live: boolean }[] = [];
  for (const [index, hit] of hits.entries()) {
    if (Number.isSafeInteger(hit.messageId) && hit.messageId! > 0) {
      const identity = JSON.stringify([hit.sessionId, hit.messageId]);
      if (seen.has(identity)) continue;
      seen.add(identity);
    }
    const content = hit.content.toLowerCase();
    let relevance = 0;
    for (const term of terms) if (content.includes(term)) relevance++;
    ranked.push({ hit, index, relevance, live: hit.source === 'live' });
  }

  // 4. 第一层规则简单且可解释：不同词项命中数越多越靠前。
  // 同分时先看本轮 live 原文，再看已持久化历史；live 没有 BM25，
  // 不能因为“缺一个数值”就被所有历史记录挤到最后。
  // 原始下标是最终稳定顺序；只操作新数组，不原地 sort 调用方的 hits。
  ranked.sort((left, right) => right.relevance - left.relevance
    || Number(right.live) - Number(left.live) || left.index - right.index);

  // 5. BM25 的方向容易弄反：SQLite FTS5 通常返回负数，数值越小越相关。
  // 但是词索引和 trigram 的分数来自不同语料/切词，不能跨来源直接比较。
  // 我们在“词项分数相同、live 优先级相同”的一层中，保留每个来源原本的
  // 位置，只把同来源且有有效 rank 的候选按 BM25 放回这些位置。
  //
  // 这样也避免一个隐蔽错误：比较器若写成“同来源比 rank，否则比下标”，
  // 面对 fts A、like B、fts C 时可能产生循环关系，不再是合法的排序规则。
  for (let start = 0; start < ranked.length;) {
    let end = start + 1;
    while (end < ranked.length && ranked[end].relevance === ranked[start].relevance
      && ranked[end].live === ranked[start].live) end++;

    const positions = new Map<string, number[]>();
    for (let index = start; index < end; index++) {
      const { source, rank } = ranked[index].hit;
      if ((source === 'fts5' || source === 'trigram') && typeof rank === 'number' && Number.isFinite(rank)) {
        const slots = positions.get(source) ?? [];
        slots.push(index);
        positions.set(source, slots);
      }
    }
    for (const slots of positions.values()) {
      const sameSource = slots.map(index => ranked[index]);
      sameSource.sort((left, right) => left.hit.rank! - right.hit.rank! || left.index - right.index);
      slots.forEach((position, index) => { ranked[position] = sameSource[index]; });
    }
    start = end;
  }

  // 6. score 是存储层保留的兼容字段，不在这里改写成另一种分值；
  // 返回的仍然是 MemoryHit，只去掉临时的下标/词项分数/live 装饰信息。
  return ranked.slice(0, limit).map(item => item.hit);
}
export function sessionKey(_channel: string, _conversationId: string, _userId: string): string {
  // L4：将渠道、会话、用户三个维度编码成稳定且不易碰撞的会话键。

  let sKey = ""

  let terms: string[] = []

  terms.push(_channel)
  terms.push(_conversationId)
  terms.push(_userId)

  sKey = JSON.stringify(terms)

  return sKey
}
export async function reflect(
  transcript: Message[], provider: Provider, options: ReflectionOptions = {},
): Promise<ReflectionResult> {
  // 1. 检查轮次完整性，不再把失败尝试和无工具的用户纠正一律丢掉。
  options.signal?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 10_000, maxInputChars = options.maxInputChars ?? 12_000;
  const maxSteps = options.maxSteps ?? 5;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647 ||
    !Number.isSafeInteger(maxInputChars) || maxInputChars < 1 ||
    !Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 8) throw new Error('Invalid reflection budget');
  if (!reviewableTurn(transcript)) return null;

  // 2. 复盘只有三个专用技能工具；不复用主任务的注册表，候选尚未落盘。
  const review = reviewTools(options.library), schemas = review.registry.schemas();
  // 再这里插入的 自进化prompt
  const messages = reflectionMessages(transcript, maxInputChars - JSON.stringify(schemas).length, options);
  if (!messages) return null;

  // 3. 总超时覆盖整个“列出 → 读取 → 提议”循环，而不是每步重新计时。
  return withTimeout(async signal => {
    const callIds = new Set<string>();
    for (let step = 0; step < maxSteps; step++) {
      signal.throwIfAborted();
      if (requestSize(messages, schemas) > maxInputChars) throw new Error('Reflection context budget exceeded');
      const response = await abortable(provider.complete(structuredClone(messages), schemas, signal), signal);
      signal.throwIfAborted();
      validateModelResponse(response);
      if (!response.toolCalls?.length) {
        const body = reflectionBody(response.content);
        // 有技能库时必须通过技能工具提议，避免跳过读取而把旧技能误当作新建。
        if (body && options.library) throw new Error('Use skill_manage to propose a candidate');
        return body;
      }
      // 没有技能库时， reflection 仍然可以通过工具调用提议，但不允许使用 skill_manage。
      if (!options.library) throw new Error('Reflection cannot request tools without a skill library');

      if (response.toolCalls.filter(call => call.name === 'skill_manage').length > 1) {
        throw new Error('Only one skill_manage call per response');
      }
      if (response.toolCalls.some(call => call.name === 'skill_manage') &&
        response.toolCalls.some(call => call.name === 'skill_view' || call.name === 'skills_list')) {
        throw new Error('Observe skill lookup results in an earlier model step before proposing changes');
      }
      // 4. 先把 assistant 消息和工具结果都写进上下文，下一轮模型才能看到完整的历史。
      messages.push({
        role: 'assistant', content: response.content, toolCalls: response.toolCalls,
        ...(response.reasoningContent !== undefined ? { reasoningContent: response.reasoningContent } : {}),
      });
      for (const call of response.toolCalls) {
        if (callIds.has(call.id)) throw new Error('Duplicate reflection tool call ID');
        callIds.add(call.id);
        messages.push(await review.registry.execute(call, signal));
      }
      signal.throwIfAborted();
      if (review.draft() !== null) return review.draft();
    }
    throw new Error('Reflection step limit exceeded');
  }, timeoutMs, options.signal);
}
