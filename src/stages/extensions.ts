import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginManager } from '../plugins/manager.js';
import { SkillCatalog } from '../skills/catalog.js';
import { ToolRegistry } from '../core/tools.js';
import type { StageCase } from './contracts.js';

async function temporary(run: (root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'hermes-extensions-check-'));
  try { await run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

export function extensionCases(): StageCase[] {
  return [{
    name: 'Skill 索引只披露元数据，读取拒绝目录穿越',
    run: () => temporary(root => {
      mkdirSync(join(root, 'notes'));
      writeFileSync(join(root, 'notes', 'SKILL.md'), '---\nname: notes\ndescription: Testing metadata\n---\n\nBODY_ONLY_MARKER');
      const catalog = new SkillCatalog([root]); catalog.discover();
      assert.match(catalog.index(), /notes/);
      assert.doesNotMatch(catalog.index(), /BODY_ONLY_MARKER/);
      assert.match(catalog.read('notes'), /BODY_ONLY_MARKER/);
      assert.throws(() => catalog.read('../outside'));
    }),
  }, {
    name: 'Plugin 重名注册失败不提交半套工具',
    run: () => temporary(async root => {
      const path = join(root, 'duplicate.mjs');
      writeFileSync(path, `export function register(ctx) {
        const tool = {name:'echo',description:'Echo',parameters:{type:'object',properties:{}},handler:()=>1};
        ctx.registerTool(tool); ctx.registerTool(tool);
      }`);
      const registry = new ToolRegistry();
      await assert.rejects(new PluginManager(registry).load([path]), /Duplicate tool/);
      assert.deepEqual(registry.schemas(), []);
    }),
  }, {
    name: 'Plugin 不能覆盖已有工具行为',
    run: () => temporary(async root => {
      const registry = new ToolRegistry();
      registry.register({ name: 'stable', description: 'Existing tool', parameters: { type: 'object', properties: {} }, handler: () => 1 });
      const path = join(root, 'override.mjs');
      writeFileSync(path, `export function register(ctx) {
        ctx.registerTool({name:'stable',description:'Override',parameters:{type:'object',properties:{}},handler:()=>99});
      }`);
      await assert.rejects(new PluginManager(registry).load([path]), /Duplicate tool/);
      const result = await registry.execute({ id: 'existing', name: 'stable', arguments: {} });
      assert.deepEqual(JSON.parse(result.content), { ok: true, result: 1 });
    }),
  }];
}
