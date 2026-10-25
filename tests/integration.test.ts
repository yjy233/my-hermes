/** Complete offline system: real SQLite, Markdown memory, tools, Gateway and reviewed evolution. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Agent } from '../src/core/agent.js';
import { DemoProvider } from '../src/core/providers.js';
import { EvolutionManager } from '../src/evolution/manager.js';
import { Gateway, type InboundMessage } from '../src/gateway/router.js';
import { sessionKey } from '../src/learning/reference.js';
import { LongTermMemory } from '../src/memory/long-term.js';
import { SessionStore } from '../src/memory/store.js';
import { SkillCatalog } from '../src/skills/catalog.js';

function fixture(t: TestContext, reflect = false) {
  const root = mkdtempSync(join(tmpdir(), 'hermes-integration-'));
  const store = new SessionStore(join(root, 'sessions.db'));
  const memory = new LongTermMemory(join(root, 'memory'));
  const skills = new SkillCatalog([join(root, 'skills')]);
  skills.discover();
  const evolution = new EvolutionManager(join(root, 'proposals'), join(root, 'skills'));
  const agent = new Agent({ provider: new DemoProvider(), store, memory, skills, evolution, autoReflect: reflect });
  const gateway = new Gateway(agent, store, sessionKey, new Set(['alice', 'bob']));
  t.after(() => { gateway.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const send = (eventId: string, text: string, userId = 'alice', conversationId = 'first') => {
    const message: InboundMessage = { eventId, channel: 'lab', conversationId, userId, text };
    return gateway.handle(message);
  };
  return { store, memory, skills, evolution, gateway, send };
}

test('tool call IDs persist, memory is scoped, and existing prompt remains frozen', async (t) => {
  const { store, memory, send } = fixture(t);
  const remembered = await send('remember', '/remember 我喜欢 TypeScript');
  assert.equal(JSON.parse(remembered.text.slice(remembered.text.indexOf('{'))).ok, true);
  const scope = Gateway.scopeFor('lab', 'alice');
  const first = store.getOrCreate(remembered.sessionKey, scope);
  assert.ok(first.systemPrompt);
  const frozen = first.systemPrompt;
  assert.equal(frozen.includes('我喜欢 TypeScript'), false);
  const messages = store.loadMessages(first.id);
  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(messages[1].toolCalls![0].id, messages[2].toolCallId);
  assert.match(memory.read(scope, 'MEMORY.md'), /我喜欢 TypeScript/u);
  assert.match((await send('read', '/memory')).text, /我喜欢 TypeScript/u);
  assert.equal(store.getOrCreate(remembered.sessionKey, scope).systemPrompt, frozen);
  const next = await send('new', 'new conversation', 'alice', 'second');
  assert.match(store.getOrCreate(next.sessionKey, scope).systemPrompt!, /我喜欢 TypeScript/u);
  assert.equal((await send('other', '/memory', 'bob')).text.includes('我喜欢 TypeScript'), false);
  assert.deepEqual(store.search('我喜欢 TypeScript', Gateway.scopeFor('lab', 'bob')), []);
  assert.ok(store.search('我喜欢 TypeScript', scope).length);
});

test('successful reflection stays pending until approval, then new session sees reviewed Skill', async (t) => {
  const { store, skills, evolution, send } = fixture(t, true);
  const first = await send('calculate', '/calc 2+3');
  assert.equal(JSON.parse(first.text.slice(first.text.indexOf('{'))).ok, true);
  const proposals = evolution.listProposals();
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].status, 'pending');
  assert.equal(skills.index().includes('learned-calculator'), false);
  evolution.approve(proposals[0].id, 'learned-calculator', 'Reviewed calculator procedure');
  skills.discover();
  assert.match(skills.index(), /learned-calculator/u);
  const scope = Gateway.scopeFor('lab', 'alice');
  await send('continue', 'continue');
  assert.equal(store.getOrCreate(first.sessionKey, scope).systemPrompt!.includes('learned-calculator'), false);
  const second = await send('skill', '/skill learned-calculator', 'alice', 'second');
  assert.match(second.text, /可复用的工具执行流程/u);
  assert.match(store.getOrCreate(second.sessionKey, scope).systemPrompt!, /learned-calculator/u);
  assert.equal(evolution.listProposals().find(proposal => proposal.id === proposals[0].id)!.status, 'approved');
});
