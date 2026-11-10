import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, posix } from 'node:path';
import { ToolRegistry } from '../core/tools.js';
import { digest, identifier, readJson, safePath, writeJson } from './files.js';
import { type SkillOperation, SkillRepository, operationFile } from './repository.js';
import { validateSkillName } from '../skills/catalog.js';

export interface PendingEdit { id: string; operations: SkillOperation[]; expected: Record<string, string>; created_at: string }
export function pendingEdits(repo: SkillRepository): PendingEdit[] {
  const root = safePath(repo.root, '.pending');
  return existsSync(root) ? readdirSync(root).filter(name => name.endsWith('.json')).map(name => readJson<PendingEdit>(safePath(root, name), {} as PendingEdit)) : [];
}
export function resolvePending(repo: SkillRepository, id: string, approve: boolean): string {
  const item = pendingEdits(repo).find(item => item.id === id);
  if (!item) throw new Error('Unknown pending skill edit');
  // 审核只解除写入审批，不解除 pin/lock/来源约束，也不绕过过期内容检查。
  const result = approve ? repo.batch(item.operations, item.expected) : 'rejected';
  rmSync(safePath(repo.root, `.pending/${item.id}.json`)); return JSON.stringify(result);
}
export function curatorTools(repo: SkillRepository, dryRun: boolean) {
  const registry = new ToolRegistry(150_000);
  let step = 0, listedAt = -1;
  const observed = new Map<string, { hash: string; step: number }>();
  const key = (name: string, file = 'SKILL.md') => `${name}/${posix.normalize(file)}`;
  const text = { type: 'string', maxLength: 64_000 };
  registry.register({ name: 'skills_list', description: 'List library metadata, usage, protections and eligibility. Paginate to see all candidates.',
    parameters: { type: 'object', properties: { offset: { type: 'integer' }, limit: { type: 'integer' } } },
    handler: args => {
      const offset = Number(args.offset ?? 0), limit = Number(args.limit ?? 50);
      if (offset < 0 || limit < 1 || limit > 100) throw new Error('Invalid pagination');
      const rows = repo.rows(); listedAt = step;
      return { total: rows.length, next_offset: offset + limit < rows.length ? offset + limit : null,
        skills: rows.slice(offset, offset + limit).map(({ path, root, ...row }) => row) };
    } });
  registry.register({ name: 'skill_view', description: 'Read one complete skill file and its package inventory. File paths are relative to the skill root.',
    parameters: { type: 'object', properties: { name: text, file_path: text }, required: ['name'] },
    handler: args => {
      const name = String(args.name), file = String(args.file_path ?? 'SKILL.md');
      if (repo.get(name).disabled) throw new Error('Skill is disabled');
      const result = repo.read(name, file);
      observed.set(key(name, file), { hash: result.hash, step });
      if (!dryRun) {
        try { repo.activity(name, 'view'); repo.activity(name, 'use'); }
        catch (error) { repo.ledger.warnings.push(`Usage telemetry: ${String(error)}`); }
      }
      return result;
    } });
  const opProperties = {
    action: { type: 'string', enum: ['create', 'patch', 'edit', 'write_file', 'remove_file', 'delete'] },
    name: text, content: text, description: text, file_path: text, old_string: text, new_string: text, absorbed_into: text,
    file_content: text, category: text, replace_all: { type: 'boolean' }, encoding: { type: 'string', enum: ['utf8', 'base64'] },
  };
  registry.register({ name: 'skill_manage', description: 'Apply an operations array (1..20) atomically. create uses content; patch uses old_string/new_string or full content; write_file uses file_content. delete must be sole and archives after absorption. Legacy flat action/name is accepted.',
    parameters: { type: 'object', properties: { ...opProperties,
      operations: { type: 'array', maxItems: 20, items: { type: 'object', properties: opProperties, required: ['action', 'name'] } },
    } },
    handler: args => {
      if (dryRun) throw new Error('Dry-run forbids skill mutations');
      if (args.operations !== undefined && args.action !== undefined) throw new Error('Use operations OR a flat operation');
      const operations = (args.operations ?? [args]) as SkillOperation[];
      if (!operations.length || operations.length > 20) throw new Error('Expected 1..20 operations');
      if (operations.length > 1 && operations.some(op => op.action === 'delete')) throw new Error('delete must be the sole operation');
      const expected: Record<string, string> = {}, created = new Set<string>();
      for (const operation of operations) {
        const { name, action } = operation; validateSkillName(name);
        if (!['create', 'patch', 'edit', 'write_file', 'remove_file', 'delete'].includes(action)) throw new Error('Invalid skill action');
        const file = operationFile(operation);
        if (!file) throw new Error('file_path required');
        if (action === 'create') {
          if (listedAt < 0 || listedAt >= step) throw new Error('Observe skills_list in an earlier model step before creating');
          created.add(name);
        } else if (!created.has(name)) {
          const row = repo.get(name), exists = existsSync(safePath(dirname(row.path), file));
          const read = observed.get(key(name, file));
          if (exists && (!read || read.step >= step)) throw new Error('Read the same file with skill_view in an earlier model step');
          expected[key(name, file)] = exists ? read!.hash : 'absent';
          if (exists && repo.read(name, file).hash !== read!.hash) throw new Error('File changed since it was read');
        }
        if (action === 'delete') {
          if (!operation.absorbed_into) throw new Error('Consolidation delete requires absorbed_into; no bare pruning');
          const target = repo.get(operation.absorbed_into), read = observed.get(key(target.name));
          if (!read || read.step >= step || repo.read(target.name).hash !== read.hash) throw new Error('Read the current absorption target before archiving');
          expected[key(target.name)] = read.hash;
        }
      }
      if (repo.options.write_approval) {
        const id = identifier();
        writeJson(safePath(repo.root, `.pending/${id}.json`), { id, operations, expected, created_at: repo.now().toISOString() } satisfies PendingEdit);
        return { status: 'pending', id, message: 'Awaiting approval; live files have not changed.' };
      }
      const result = repo.batch(operations, expected);
      for (const op of operations) observed.delete(key(op.name, operationFile(op)));
      return { status: 'applied', result };
    } });
  return { registry, nextStep: () => { step++; }, invalidateReads: () => { observed.clear(); listedAt = -1; } };
}
