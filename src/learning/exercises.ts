/** L1～L3 已实现并附中文说明；L4～L5 继续保留为练习，外围系统可切换到 reference 模式运行。 */
import { abortable } from '../core/async.js';
import { ContextBudgetExceeded, ExerciseNotImplemented, StepLimitExceeded } from '../core/errors.js';
import { messageSize, validateModelResponse, type Emit, type Message, type Provider } from '../core/models.js';
import type { ToolRegistry } from '../core/tools.js';
import type { MemoryHit } from '../memory/store.js';

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
 * L2：在预算内，保留系统提示和最近的连续完整用户轮次。
 *
 * 本阶段采用确定性的“整轮裁剪”：旧轮次不再发送给模型，但不删除数据库历史。
 * Hermes 的完整上下文压缩还包含工具输出清理和模型语义摘要；这里先学习预算与消息边界。
 * 当前函数不请求模型，因此可以同步执行，也不需要额外支付摘要请求费用。
 *
 * 一个用户轮次从 user 开始，到下一个 user 之前结束，例如：
 *   user → assistant(toolCalls) → tool → tool → assistant
 * 必须把这一组一起保留，避免模型收到没有声明来源的工具结果。
 * 最新轮次也可能只有当前 user 消息，因为此时还没有开始请求模型。
 *
 * @param messages 以 system 开头的上下文，包含历史消息和当前用户消息。
 * @param maxChars 消息序列化后的字符预算；不是模型 tokenizer 计算出的 token 数。
 * @returns 一个新数组，包含原 system 和最近的连续完整轮次，不修改输入消息。
 */
export function compactHistory(messages: Message[], maxChars: number): Message[] {
  // 1. 预算必须能明确比较，拒绝 NaN、Infinity、小数和非正数。
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new Error('maxChars 必须是大于 0 的安全整数');
  }
  const system = messages[0];
  if (system?.role !== 'system') {
    throw new Error('上下文必须以 system 消息开头');
  }

  // 2. 系统提示承载行为规则、记忆快照和 Skill 索引，不能为了省空间丢掉。
  // 使用共享的 messageSize，连 role、工具调用参数、调用 ID、reasoningContent 一起计费。
  // 仅累加 content.length 会漏掉这些协议字段，低估上下文大小。
  let remaining = maxChars - messageSize(system);
  if (remaining < 0) {
    throw new ContextBudgetExceeded('系统提示超过上下文预算');
  }

  // 3. 按 user 边界分组，而不是按固定消息条数截取。
  // 一轮可能运行多次工具，或者一次声明多个工具，因此不能假设“一轮只有两条消息”。
  // 这里只新建分组数组，不改变原消息内容，保留完整的工具和思考协议字段。
  const turns: Message[][] = [];
  let currentTurn: Message[] | undefined;
  for (const message of messages.slice(1)) {
    if (message.role === 'user') {
      currentTurn = [];
      turns.push(currentTurn);
    }
    if (!currentTurn) {
      throw new Error('system 后的第一个轮次必须从 user 消息开始');
    }
    currentTurn.push(message);
  }

  // 4. 从最新轮次向前装入预算，保证当前用户的问题优先保留。
  // 一旦某个较老轮次装不下就停止，不能跳过它，再捡回更早的小轮次。
  // 这样输出始终是时间上连续的历史后缀，减少因中间断档而误解上下文的机会。
  const kept: Message[][] = [];
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    const turnSize = turn.reduce((total, message) => total + messageSize(message), 0);
    if (turnSize > remaining) {
      // 连最新轮次都装不下时，明确报错，交给调用方缩短输入或调整预算。
      // 不能返回只有 system 的结果，让模型在看不到当前问题的情况下回答。
      if (kept.length === 0) {
        throw new ContextBudgetExceeded('系统提示与最新完整轮次超过上下文预算');
      }
      break;
    }
    kept.unshift(turn);
    remaining -= turnSize;
  }

  // 5. 恢复原来的时间顺序。这里只有 system 时，直接返回包含 system 的新数组。
  // 此函数只决定“本次发送哪些消息”；SQLite 原始记录由外层管理，仍然可以检索。
  // 工具 schema 的开销和循环中新追加的消息，由外层 BudgetProvider 在请求前继续检查。
  return [system, ...kept.flat()];
}

/**
 * L3：对已经检索出的历史候选做简单、稳定的相关性排序。
 *
 * 本函数只负责“候选中哪些更相关”，不访问数据库，也不决定用户数据隔离范围。
 * 调用方的 SessionStore 已按 scope 筛选候选；不能在这里混入其他用户的历史。
 * 这是基础词项匹配，没有实现中文分词、语义向量或 embedding 服务。
 *
 * @param query 用户要查找的内容，按 Unicode 字母、数字和下划线提取查询词。
 * @param hits 已按用户隔离的候选；同分时保留传入顺序，延续检索层的时间顺序。
 * @param limit 最多返回的条数；非正安全整数返回空数组，非安全整数报错。
 * @returns 排序后的新数组，不改写候选本身，也不覆盖候选原有的 score。
 */
export function selectMemories(query: string, hits: MemoryHit[], limit: number): MemoryHit[] {
  // 1. 显式校验上限，避免 slice 把 NaN、Infinity 或小数悄悄转换成其他值。
  if (!Number.isSafeInteger(limit)) {
    throw new Error('limit 必须是安全整数');
  }
  if (limit <= 0 || hits.length === 0) return [];

  // 2. 统一大小写并去重。同一个词在查询中重复多次，不应获得额外权重。
  // 例如“TypeScript agent TypeScript”只有两个查询词。
  // 连续中文会作为一个词项，当前阶段采用子串匹配，后续可替换成更完整的检索器。
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])];
  if (terms.length === 0) return hits.slice(0, limit);

  // 3. 一个不同查询词命中内容就计 1 分，重复出现不再加分。
  // 把临时相关性和原始下标放在新对象中，避免给 MemoryHit.score 写入另一种含义。
  const ranked = hits.map((hit, index) => {
    const content = hit.content.toLowerCase();
    const relevance = terms.reduce((total, term) => total + Number(content.includes(term)), 0);
    return { hit, index, relevance };
  });

  // 4. 优先相关性，同分保留原顺序。只排序新数组，不对 hits 原地调用 sort。
  // 最后去掉临时排序字段，调用方得到的仍然是原来的 MemoryHit 数据格式。
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
