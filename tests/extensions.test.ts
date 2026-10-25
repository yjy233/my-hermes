import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ToolRegistry } from '../src/core/tools.js';
import { EvolutionManager } from '../src/evolution/index.js';
import { PluginManager } from '../src/plugins/index.js';
import { SkillCatalog } from '../src/skills/index.js';

function temporary(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'my-hermes-extension-'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeSkill(root: string, name = 'study', description = 'Read a study guide', body = 'Secret body'): string {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
  return directory;
}

test('skills disclose metadata first and enforce path containment', t => {
  const root = temporary(t);
  const directory = writeSkill(join(root, 'skills'));
  const catalog = new SkillCatalog([join(root, 'skills')]);
  assert.equal(catalog.discover().length, 1);
  assert.match(catalog.index(), /Read a study guide/);
  assert.doesNotMatch(catalog.index(), /Secret body/);
  assert.match(catalog.read('study'), /Secret body/);
  assert.throws(() => catalog.read('../study'), /Skill name/);
  const outside = join(root, 'outside.md');
  writeFileSync(outside, 'private');
  unlinkSync(join(directory, 'SKILL.md'));
  symlinkSync(outside, join(directory, 'SKILL.md'));
  assert.throws(() => catalog.read('study'), /escapes/);
});

test('duplicate skill names and oversized bodies are rejected', t => {
  const root = temporary(t);
  writeSkill(join(root, 'one'));
  writeSkill(join(root, 'two'));
  assert.throws(() => new SkillCatalog([join(root, 'one'), join(root, 'two')]).discover(), /Duplicate skill/);
  writeSkill(join(root, 'large'), 'large', 'large skill', 'x'.repeat(32_000));
  assert.throws(() => new SkillCatalog([join(root, 'large')]).discover(), /budget/);
});

test('explicit TypeScript plugin registers an async tool and sync hook', async t => {
  const root = temporary(t);
  const plugin = join(root, 'example.ts');
  writeFileSync(plugin, `
    export async function register(ctx: { registerTool(tool: unknown): void; on(event: string, handler: () => void): void }) {
      ctx.registerTool({ name: 'plugin_echo', description: 'Echo', parameters: {
        type: 'object', properties: { text: { type: 'string' } }, required: ['text']
      }, handler: async ({ text }: { text: string }) => text.toUpperCase() });
      ctx.on('turn.final', () => undefined);
    }
  `);
  const registry = new ToolRegistry();
  const manager = new PluginManager(registry);
  assert.deepEqual(registry.schemas(), []);
  await manager.load([plugin]);
  const result = await registry.execute({ id: 'c1', name: 'plugin_echo', arguments: { text: 'hi' } });
  assert.equal(JSON.parse(result.content).result, 'HI');
  manager.emit('turn.final', { step: 1 });
  assert.deepEqual(manager.loaded, [realpathSync(plugin)]);
  await assert.rejects(() => manager.load([plugin]), /already loaded/);
});

test('plugin registration validates all tools before mutating the real registry', async t => {
  const root = temporary(t);
  const registry = new ToolRegistry();
  registry.register({ name: 'existing', description: 'exists', parameters: { type: 'object' }, handler: () => undefined });
  const plugin = join(root, 'bad.mjs');
  writeFileSync(plugin, `export function register(ctx) {
    ctx.registerTool({ name: 'new_tool', description: 'new', parameters: { type: 'object' }, handler: () => null });
    ctx.registerTool({ name: 'existing', description: 'duplicate', parameters: { type: 'object' }, handler: () => null });
  }`);
  const manager = new PluginManager(registry);
  await assert.rejects(() => manager.load([plugin]), /Duplicate tool/);
  assert.deepEqual(registry.schemas().map(schema => schema.function.name), ['existing']);
  assert.deepEqual(manager.loaded, []);
});

test('plugin module imports once but each registry receives fresh registration state', async t => {
  const root = temporary(t);
  const plugin = join(root, 'cached.mjs');
  const marker = join(root, 'imports.txt');
  writeFileSync(plugin, `
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    const marker = new URL('./imports.txt', import.meta.url);
    writeFileSync(marker, existsSync(marker) ? readFileSync(marker, 'utf8') + 'I' : 'I');
    export function register(ctx) {
      let count = 0;
      ctx.registerTool({ name: 'cached_tool', description: 'Counter', parameters: { type: 'object' }, handler: () => ++count });
    }
  `);
  const first = new ToolRegistry();
  const second = new ToolRegistry();
  await new PluginManager(first).load([plugin]);
  await new PluginManager(second).load([plugin]);
  assert.equal(readFileSync(marker, 'utf8'), 'I');
  for (const registry of [first, second]) {
    const result = await registry.execute({ id: 'c1', name: 'cached_tool', arguments: {} });
    assert.equal(JSON.parse(result.content).result, 1);
  }
  await assert.rejects(() => new PluginManager(first).load([plugin]), /Duplicate tool/);
  assert.equal(readFileSync(marker, 'utf8'), 'I');
});

test('failed registration can retry without committing partial tools or hooks', async t => {
  const root = temporary(t);
  const plugin = join(root, 'retry.mjs');
  writeFileSync(plugin, `let first = true;
    export function register(ctx) {
      ctx.registerTool({ name: 'retry_tool', description: 'Retry', parameters: { type: 'object' }, handler: () => 'ok' });
      if (first) { first = false; throw new Error('temporary registration failure'); }
    }
  `);
  const registry = new ToolRegistry();
  const manager = new PluginManager(registry);
  await assert.rejects(() => manager.load([plugin]), /temporary/);
  assert.deepEqual(registry.schemas(), []);
  await manager.load([plugin]);
  assert.equal(registry.schemas().length, 1);
});

test('hook failures are isolated and do not disclose exception messages', async t => {
  const root = temporary(t);
  const plugin = join(root, 'hooks.mjs');
  writeFileSync(plugin, `export function register(ctx) {
    ctx.on('turn.final', () => { throw new Error('private token'); });
    ctx.on('turn.final', payload => { payload.changed = true; });
  }`);
  const manager = new PluginManager(new ToolRegistry());
  await manager.load([plugin]);
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (message: unknown) => { warnings.push(String(message)); };
  try {
    const payload = { sessionId: 'one' };
    assert.doesNotThrow(() => manager.emit('turn.final', payload));
    assert.deepEqual(payload, { sessionId: 'one' });
  } finally { console.warn = original; }
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0] ?? '', /private token/);
});

test('evolution requires explicit approval and never overwrites skills', t => {
  const root = temporary(t);
  const skillsRoot = join(root, 'skills');
  const manager = new EvolutionManager(join(root, 'proposals'), skillsRoot);
  const id = manager.propose('session-1', '# A lesson\n\nVerify tool results before replying.');
  const catalog = new SkillCatalog([skillsRoot]);
  assert.deepEqual(catalog.discover(), []);
  assert.equal(manager.listProposals()[0]?.status, 'pending');
  const path = manager.approve(id, 'verify-results', 'Verify each tool result');
  assert.ok(existsSync(path));
  assert.match(readFileSync(path, 'utf8'), /source-proposal/);
  assert.equal(manager.listProposals()[0]?.status, 'approved');
  assert.deepEqual(catalog.discover().map(skill => skill.name), ['verify-results']);
  assert.throws(() => manager.approve(id, 'verify-again', 'Duplicate'), /already/);
  const another = manager.propose('session-2', 'Another candidate');
  assert.throws(() => manager.approve(another, 'verify-results', 'Cannot replace it'), /already exists/);
  assert.equal(manager.listProposals().find(proposal => proposal.id === another)?.status, 'pending');
  assert.throws(() => manager.approve(another, '../escape', 'bad'), /Skill name/);
  assert.throws(() => manager.approve('../escape', 'valid-name', 'bad'), /proposal ID/);
  assert.throws(() => manager.propose('session-3', 'x'.repeat(6001)), /6000/);
});
