import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Agent } from '../src/core/agent.js';
import { type Message, type ModelResponse, type Provider } from '../src/core/models.js';
import { DemoProvider } from '../src/core/providers.js';
import { BackgroundReviews } from '../src/evolution/background.js';
import { EvolutionManager } from '../src/evolution/manager.js';
import { REFLECTION_TASK } from '../src/evolution/reflection.js';
import { reflect } from '../src/learning/exercises.js';
import { LongTermMemory, SessionStore } from '../src/memory/index.js';
import { SkillCatalog } from '../src/skills/catalog.js';

const body = '# 计算核验\n\n## 步骤\n1. 保留已经验证的旧步骤。\n2. 核对计算结果。';
const trace = (): Message[] => [
  { role: 'user', content: '请核验计算流程' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'calc', name: 'calculator', arguments: { expression: '2+2' } }] },
  { role: 'tool', toolCallId: 'calc', content: '{"ok":true,"result":4}' },
  { role: 'assistant', content: '已核验，结果为 4。' },
];
const tool = (id: string, name: string, args: Record<string, unknown>): ModelResponse => ({
  content: '', toolCalls: [{ id, name, arguments: args }],
});
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'hermes-review-'));
  const manager = new EvolutionManager(join(root, 'proposals'), join(root, 'skills'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const create = () => manager.approve(manager.propose('source', body), 'verified-calculation', '核验计算流程');
  return { root, manager, create };
}

test('reflection can learn from a failed attempt followed by a successful repair', async () => {
  const input = trace();
  input.splice(1, 0,
    { role: 'assistant', content: '', toolCalls: [{ id: 'failed', name: 'calculator', arguments: {} }] },
    { role: 'tool', toolCallId: 'failed', content: '{"ok":false,"message":"Invalid input; api_key=sk-secret123456789"}' });
  assert.equal(await reflect(input, { async complete(messages) {
    const { records } = JSON.parse(messages[1].content);
    assert.deepEqual(records.filter((r: { role: string }) => r.role === 'tool').map((r: { ok: boolean }) => r.ok), [false, true]);
    assert.match(records[2].text, /Invalid input/);
    assert.equal(JSON.stringify(messages).includes('sk-secret123456789'), false);
    return { content: body };
  } }), body);
});

test('tool-free user corrections reach the model with the previous exchange', async () => {
  const previousExchange = { user: '解释实现', assistant: '输出了过长的介绍' };
  const input: Message[] = [{ role: 'user', content: '以后先给代码，再简短说明。' }, { role: 'assistant', content: '之后会按这个顺序。' }];
  assert.equal(await reflect(input, { async complete(messages) {
    const payload = JSON.parse(messages[1].content);
    assert.deepEqual(payload.previousExchange, previousExchange);
    assert.match(payload.records[0].text, /先给代码/);
    return { content: body };
  } }, { previousExchange }), body);
  assert.equal(await reflect(input, { async complete() { return { content: 'null' }; } }), null);
});

test('review reads an existing skill, stages an update, and preserves its old steps until approval', async t => {
  const { manager, create } = fixture(t), path = create(), before = readFileSync(path, 'utf8');
  const draft = await reflect(trace(), new DemoProvider(), { library: manager.library() });
  assert.ok(draft && typeof draft !== 'string');
  assert.equal(draft.action, 'update');
  assert.equal(draft.name, 'verified-calculation');
  assert.match(draft.content, /保留已经验证的旧步骤/);
  const id = manager.propose('source-2', draft);
  assert.equal(manager.get(id).status, 'pending');
  assert.equal(manager.get(id).previousContent, before);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(manager.approve(id), path);
  assert.match(readFileSync(path, 'utf8'), /复盘补充/);
  assert.match(readFileSync(path, 'utf8'), /description: "核验计算流程"/);
  assert.equal(manager.get(id).status, 'approved');
  assert.throws(() => manager.approve(id), /already/);
});

test('read-before-write rejects an unobserved update, then permits a bounded corrected retry', async t => {
  const { manager, create } = fixture(t); create();
  let calls = 0;
  const draft = await reflect(trace(), { async complete(messages, schemas) {
    assert.deepEqual(schemas.map(schema => schema.function.name), ['skills_list', 'skill_view', 'skill_manage']);
    calls++;
    if (calls === 1) return tool('bad-update', 'skill_manage', { action: 'update', name: 'verified-calculation', content: body });
    if (calls === 2) {
      assert.equal(JSON.parse(messages.at(-1)!.content).ok, false);
      assert.match(messages.at(-1)!.content, /skill_view/);
      return tool('read', 'skill_view', { name: 'verified-calculation' });
    }
    assert.equal(JSON.parse(messages.at(-1)!.content).ok, true);
    return tool('good-update', 'skill_manage', { action: 'update', name: 'verified-calculation', content: body });
  } }, { library: manager.library() });
  assert.ok(draft && typeof draft !== 'string');
  assert.equal(calls, 3);
  assert.equal(manager.listProposals().length, 1, 'Reflection itself never writes proposals');
});

test('skill creation requires a library lookup and review cannot execute main-task tools', async t => {
  const { manager } = fixture(t);
  let calls = 0;
  assert.equal(await reflect(trace(), { async complete(messages) {
    calls++;
    if (calls === 1) return tool('create', 'skill_manage', { action: 'create', content: body });
    assert.equal(JSON.parse(messages.at(-1)!.content).ok, false);
    if (calls === 2) {
      assert.match(messages.at(-1)!.content, /skills_list/);
      return tool('terminal', 'terminal', { command: 'do not execute' });
    }
    assert.match(messages.at(-1)!.content, /Unknown tool/);
    return { content: 'null' };
  } }, { library: manager.library() }), null);
  assert.deepEqual(manager.listProposals(), []);
});

test('step budget and duplicate call IDs stop malformed review loops', async t => {
  const { manager } = fixture(t);
  let calls = 0;
  await assert.rejects(reflect(trace(), { async complete() {
    return tool(`list-${++calls}`, 'skills_list', {});
  } }, { library: manager.library(), maxSteps: 2 }), /step limit/);
  assert.equal(calls, 2);
  await assert.rejects(reflect(trace(), { async complete() {
    return tool('repeated-id', 'skills_list', {});
  } }, { library: manager.library() }), /Duplicate reflection/);
});

test('a same-response read and update does not count as observing the skill', async t => {
  const { manager, create } = fixture(t); create();
  await assert.rejects(reflect(trace(), { async complete() {
    return { content: '', toolCalls: [
      tool('read', 'skill_view', { name: 'verified-calculation' }).toolCalls![0],
      tool('write', 'skill_manage', { action: 'update', name: 'verified-calculation', content: body }).toolCalls![0],
    ] };
  } }, { library: manager.library() }), /earlier model step/);
});

test('review preserves provider reasoning for tool continuation but excludes it from the candidate', async t => {
  const { manager } = fixture(t);
  let calls = 0;
  assert.equal(await reflect(trace(), { async complete(messages) {
    if (++calls === 1) return { ...tool('list', 'skills_list', {}), reasoningContent: 'Provider continuation metadata' };
    assert.equal(messages.at(-2)!.reasoningContent, 'Provider continuation metadata');
    return tool('create', 'skill_manage', { action: 'create', content: body });
  } }, { library: manager.library() }), body);
});

test('stale review and stale approval cannot overwrite a changed skill', async t => {
  const { manager, create } = fixture(t), path = create();
  const original = readFileSync(path, 'utf8');
  const draft = await reflect(trace(), new DemoProvider(), { library: manager.library() });
  assert.ok(draft);
  writeFileSync(path, original + '\n人工修改');
  assert.throws(() => manager.propose('source', draft), /changed since review/);
  writeFileSync(path, original);
  const id = manager.propose('source', draft);
  assert.throws(() => manager.approve(id, 'another-name'), /renamed/);
  writeFileSync(path, original + '\n更新的人工修改');
  assert.throws(() => manager.approve(id), /changed since proposal/);
  assert.equal(manager.get(id).status, 'pending');
  assert.match(readFileSync(path, 'utf8'), /更新的人工修改/);
  assert.throws(() => manager.library().read('../outside'), /Skill name/);
});

function agentFixture(t: TestContext, provider: Provider) {
  const root = mkdtempSync(join(tmpdir(), 'hermes-review-agent-'));
  const manager = new EvolutionManager(join(root, 'proposals'), join(root, 'skills'));
  const store = new SessionStore(join(root, 'sessions.db'));
  const agent = new Agent({ provider, store, evolution: manager, autoReflect: true, mode: 'learner',
    memory: new LongTermMemory(join(root, 'memory')), skills: new SkillCatalog([manager.skillsRoot]),
  });
  t.after(() => { agent.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { agent, store, manager };
}

test('background review starts after the answer and a new foreground turn cancels it', { timeout: 3000 }, async t => {
  const demo = new DemoProvider();
  let finish!: (response: ModelResponse) => void, started!: () => void, reviewSignal: AbortSignal | undefined;
  let reviews = 0;
  const began = new Promise<void>(resolve => { started = resolve; });
  const { agent, manager, store } = agentFixture(t, { complete(messages, tools, signal) {
    if (!messages[0]?.content.startsWith(REFLECTION_TASK)) return demo.complete(messages, tools, signal);
    if (++reviews > 1) return Promise.resolve({ content: 'null' });
    reviewSignal = signal;
    started();
    return new Promise(resolve => { finish = resolve; });
  } });
  assert.match(await agent.run('key', 'scope', '/calc 2+2'), /"result":4/);
  assert.equal(reviews, 0, 'The answer resolves before background dispatch');
  assert.equal(store.loadMessages(store.getOrCreate('key', 'scope').id).length, 4);
  await began;
  assert.match(await agent.run('key', 'scope', '继续'), /demo/);
  assert.equal(reviewSignal?.aborted, true);
  finish({ content: body });
  await agent.waitForReflections();
  assert.deepEqual(manager.listProposals(), []);
});

test('closing the Agent cancels background work and prevents late disk writes', async t => {
  const demo = new DemoProvider();
  let finish!: (response: ModelResponse) => void, started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const { agent, manager } = agentFixture(t, { complete(messages, tools, signal) {
    if (!messages[0]?.content.startsWith(REFLECTION_TASK)) return demo.complete(messages, tools, signal);
    started(); return new Promise(resolve => { finish = resolve; });
  } });
  await agent.run('key', 'scope', '/calc 2+2');
  await began;
  agent.close();
  finish({ content: body });
  await agent.waitForReflections();
  assert.deepEqual(manager.listProposals(), []);
  await assert.rejects(agent.run('key', 'scope', 'closed'), /closed/);
});

test('Agent supplies prior conversation context to a correction review without altering the stored prompt', async t => {
  const demo = new DemoProvider();
  const observed: { previousExchange?: { user: string; assistant: string }; records: { text?: string }[] }[] = [];
  const { agent, store } = agentFixture(t, { async complete(messages, tools, signal) {
    if (messages[0]?.content.startsWith(REFLECTION_TASK)) {
      observed.push(JSON.parse(messages[1].content));
      return { content: 'null' };
    }
    return demo.complete(messages, tools, signal);
  } });
  await agent.run('key', 'scope', '解释流程');
  await agent.waitForReflections();
  const session = store.getOrCreate('key', 'scope'), prompt = session.systemPrompt;
  await agent.run('key', 'scope', '以后先给代码，再说明');
  await agent.waitForReflections();
  assert.equal(observed[1].previousExchange?.user, '解释流程');
  assert.match(observed[1].previousExchange!.assistant, /解释流程/);
  assert.match(observed[1].records[0].text!, /先给代码/);
  assert.equal(store.getOrCreate('key', 'scope').systemPrompt, prompt);
  assert.equal(store.loadMessages(session.id).length, 4, 'Background review messages do not enter the foreground transcript');
});

test('background queue is bounded, replaces pending duplicates, and executes one job at a time', async () => {
  const queue = new BackgroundReviews(), executed: string[] = [];
  let active = 0, peak = 0;
  queue.beginTurn('foreground');
  for (let i = 0; i < 40; i++) queue.enqueue(String(i), async () => {
    peak = Math.max(peak, ++active);
    await Promise.resolve(); executed.push(String(i)); active--;
  });
  queue.enqueue('39', async () => { executed.push('latest-39'); });
  queue.endTurn();
  await queue.idle(); queue.close();
  assert.equal(executed.length, 32);
  assert.equal(executed[0], '8');
  assert.equal(executed.at(-1), 'latest-39');
  assert.equal(peak, 1);
});
