/** 各阶段独立的离线场景，只运行本阶段需要的学习算法。 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculate, objectSchema } from './core/builtin-tools.js';
import { messageSize, type Emit, type Message } from './core/models.js';
import { DemoProvider } from './core/providers.js';
import { ToolRegistry } from './core/tools.js';
import { EvolutionManager } from './evolution/index.js';
import { Gateway } from './gateway/index.js';
import { loadAlgorithms, type Algorithms, type Mode } from './learning/index.js';
import { LongTermMemory, SessionStore } from './memory/index.js';
import { PluginManager } from './plugins/index.js';
import { SkillCatalog } from './skills/index.js';
import { algorithmCases } from './stages/contracts.js';
import { extensionCases } from './stages/extensions.js';
import { providerCases } from './stages/provider.js';
import { runStageCases, type StageResult, type StageRunOptions } from './stages/runner.js';

export const STAGES: Record<number, string> = {
  0: 'Provider：Kimi 请求、思考元数据与工具协议（L0）',
  1: 'Core：模型 → 工具 → 观察 → 最终答复（L1）',
  2: 'Memory：上下文预算、长期记忆、历史召回（L2/L3）',
  3: 'Gateway：路由隔离、并发去重（L4）',
  4: 'Extensions：Skill 渐进加载、显式 Plugin',
  5: 'Evolution：成功轨迹 → 候选 → 审核 → Skill（L5）',
};
export function builtinSkills(): string { return fileURLToPath(new URL('./data/skills', import.meta.url)); }

export async function checkStage(stage: number, mode: Mode = 'reference', options: StageRunOptions = {},
  algorithms: Algorithms = loadAlgorithms(mode)): Promise<StageResult & Record<string, unknown>> {
  if (!Number.isInteger(stage) || !Object.hasOwn(STAGES, stage)) throw new Error('Stage must be 0..5');
  if (stage === 0) return { ...await runStageCases(stage, mode, providerCases(mode), options) };
  const emit: Emit = (event, payload) => {
    try { options.emit?.(event, { stage, mode, ...payload }); } catch { /* 仅用于观察。 */ }
  };
  let details: Record<string, unknown> = {};
  const scenarioName = {
    1: '离线计算完整调用链', 2: '长期记忆读写与用户隔离', 3: 'Gateway 并发去重与用户隔离',
    4: 'Skill 渐进读取与 Plugin 工具调用', 5: '候选审核与 Skill 提升闭环',
  }[stage]!;
  const result = await runStageCases(stage, mode, [
    ...algorithmCases(stage, algorithms, emit), ...(stage === 4 ? extensionCases() : []), {
    name: scenarioName,
    run: async signal => {
      details = await runScenario(stage, algorithms, (event, payload) => emit(event, {
        stage, mode, caseName: scenarioName, ...payload,
      }), signal);
    },
  }], options);
  return { ...details, ...result };
}

async function runScenario(stage: number, algorithms: Algorithms, emit: Emit,
  signal?: AbortSignal): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), 'my-hermes-check-'));
  try {
    if (stage === 1) {
      const registry = new ToolRegistry();
      registry.register({ name: 'calculator', description: 'Arithmetic',
        parameters: objectSchema({ expression: { type: 'string' } }), handler: args => calculate(args.expression as string) });
      const events: string[] = [];
      const delta = await algorithms.runLoop(new DemoProvider(), registry,
        [{ role: 'user', content: '/calc (2+3)*4' }], 4,
        (event, payload) => { events.push(event); emit(event, payload); }, signal);
      assert.equal(delta[0].toolCalls?.[0].name, 'calculator');
      assert.deepEqual(JSON.parse(delta[1].content), { ok: true, result: 20 });
      assert.equal(delta[1].toolCallId, delta[0].toolCalls![0].id);
      assert.equal(delta.at(-1)?.role, 'assistant');
      assert.ok(!delta.at(-1)?.toolCalls?.length);
      return { stage, status: 'passed', events, answer: delta.at(-1)!.content };
    }
    if (stage === 2) {
      const system: Message = { role: 'system', content: 'fixed identity' };
      const old: Message[] = [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'x'.repeat(500) }];
      const latest: Message[] = [{ role: 'user', content: 'new' }, { role: 'assistant', content: 'done' }];
      const budget = [system, ...latest].reduce((size, message) => size + messageSize(message), 0);
      assert.deepEqual(algorithms.compactHistory([system, ...old, ...latest], budget), [system, ...latest]);
      const hits = [{ sessionId: 'old', content: 'gardening', score: 1 }, { sessionId: 'new', content: 'TypeScript tooling', score: 1 }];
      assert.equal(algorithms.selectMemories('TypeScript', hits, 1)[0].content, 'TypeScript tooling');
      const memory = new LongTermMemory(join(root, 'memory'));
      memory.write('alice', 'MEMORY.md', 'TypeScript tooling');
      assert.match(memory.snapshot('alice'), /TypeScript tooling/);
      assert.doesNotMatch(memory.snapshot('bob'), /TypeScript tooling/);
      return { stage, status: 'passed', contextMessages: 3 };
    }
    if (stage === 3) {
      let executions = 0;
      const agent = { async run(_key: string, _scope: string, text: string) { executions++; await Promise.resolve(); return text; } };
      const store = new SessionStore(join(root, 'sessions.db'));
      const gateway = new Gateway(agent, store, algorithms.sessionKey, new Set(['alice', 'bob']));
      try {
        const message = { eventId: '1', channel: 'test', conversationId: 'room', userId: 'alice', text: 'hello' };
        const [first, duplicate] = await Promise.all([gateway.handle(message), gateway.handle(message)]);
        assert.equal(executions, 1); assert.ok(first.cached || duplicate.cached);
        const other = await gateway.handle({ ...message, userId: 'bob' });
        assert.notEqual(other.sessionKey, first.sessionKey);
        await assert.rejects(gateway.handle({ ...message, userId: 'denied' }));
        assert.notEqual(algorithms.sessionKey('a:b', 'c', 'd'), algorithms.sessionKey('a', 'b:c', 'd'));
        return { stage, status: 'passed', executions };
      } finally { gateway.close(); store.close(); }
    }
    if (stage === 4) {
      const catalog = new SkillCatalog([builtinSkills()]); catalog.discover();
      assert.match(catalog.index(), /study-notes/); assert.match(catalog.read('study-notes'), /Agent 学习笔记/);
      const plugin = join(root, 'echo.mjs');
      writeFileSync(plugin, `export function register(ctx) {
        ctx.registerTool({name:'echo',description:'Echo',parameters:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},handler:({text})=>text});
      }`);
      const registry = new ToolRegistry(); await new PluginManager(registry).load([plugin]);
      const result = await registry.execute({ id: 'echo-1', name: 'echo', arguments: { text: 'hello' } });
      assert.equal(JSON.parse(result.content).result, 'hello');
      return { stage, status: 'passed', skills: catalog.index() };
    }
    if (stage === 5) {
      const trace: Message[] = [
        { role: 'user', content: 'calculate' },
        { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'calculator', arguments: { expression: '2+2' } }] },
        { role: 'tool', content: '{"ok":true,"result":4}', toolCallId: '1' },
        { role: 'assistant', content: '4' },
      ];
      const body = algorithms.reflect(trace); assert.ok(body);
      assert.equal(algorithms.reflect([{ role: 'assistant', content: 'chat only' }]), null);
      assert.equal(algorithms.reflect([...trace.slice(0, 2), { role: 'tool', content: '{"ok":false}', toolCallId: '1' }, trace[3]]), null);
      const evolution = new EvolutionManager(join(root, 'proposals'), join(root, 'skills'));
      const id = evolution.propose('test-session', body);
      const catalog = new SkillCatalog([join(root, 'skills')]);
      assert.equal(catalog.discover().length, 0);
      evolution.approve(id, 'verified-calculation', 'A reviewed calculation workflow'); catalog.discover();
      assert.match(catalog.index(), /verified-calculation/);
      assert.throws(() => evolution.approve(id, 'another-calculation', 'Already approved'));
      const duplicateId = evolution.propose('test-session', body);
      assert.throws(() => evolution.approve(duplicateId, 'verified-calculation', 'Existing skill'));
      return { stage, status: 'passed', proposal: 'pending → approved → discoverable' };
    }
    throw new Error('Stage must be one of 1, 2, 3, 4, 5');
  } finally { rmSync(root, { recursive: true, force: true }); }
}
