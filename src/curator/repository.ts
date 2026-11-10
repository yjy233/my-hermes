import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { dirname, join, posix, relative } from 'node:path';
import { canonicalDirectory, pathExists, readBoundedFile } from '../memory/files.js';
import { isRecord } from '../core/models.js';
import { MAX_SKILL_BYTES, SkillCatalog, validateSkillName, type Skill } from '../skills/catalog.js';
import { collectFiles, digest, identifier, locked, readJson, safePath, writeBytes, writeJson, type PackageFile } from './files.js';
import { SkillLedger, type Actor } from './ledger.js';
import { completePackageBefore } from './backup.js';
import { SkillReferences } from './cron.js';
import { curatorSettings, skillSettings, type CuratorSettings, type SkillSettings } from './settings.js';

export interface Usage {
  created_by: 'agent' | 'learn' | 'installed' | null; created_at: string; first_seen_at?: string;
  use_count: number; view_count: number; patch_count: number; patch_generation: number; last_reused_patch_generation: number;
  last_used_at?: string; last_viewed_at?: string; last_patched_at?: string;
  state: 'active' | 'stale' | 'archived'; pinned: boolean; locked: boolean; archived_at?: string;
}
export interface SkillRow extends Skill, Usage {
  provenance: 'bundled' | 'installed' | 'external' | 'agent' | 'learn' | 'unmanaged';
  managed: boolean; disabled: boolean; persisted: boolean; last_activity_at?: string; cron: boolean;
}
export type SkillOperation = {
  action: 'create' | 'patch' | 'edit' | 'write_file' | 'remove_file' | 'delete'; name: string;
  content?: string; description?: string; file_path?: string; old_string?: string; new_string?: string; absorbed_into?: string;
  file_content?: string; category?: string; replace_all?: boolean; encoding?: 'utf8' | 'base64';
};
export class SkillRepository {
  readonly root: string;
  readonly ledger: SkillLedger;
  readonly references: SkillReferences;
  constructor(readonly home: string, readonly config: CuratorSettings = curatorSettings(), readonly options: SkillSettings = skillSettings(), readonly now: () => Date = () => new Date()) {
    this.root = canonicalDirectory(join(home, 'skills'));
    this.ledger = new SkillLedger(this.root, options); this.references = new SkillReferences(home);
  }
  private empty(): Usage { return { created_by: null, created_at: this.now().toISOString(), use_count: 0, view_count: 0, patch_count: 0,
    patch_generation: 0, last_reused_patch_generation: 0, state: 'active', pinned: false, locked: false }; }
  usage(): Record<string, Usage> {
    const raw: unknown = readJson(safePath(this.root, '.usage.json'), {});
    if (!isRecord(raw)) throw new Error('Invalid skill usage file');
    const result: Record<string, Usage> = {};
    for (const [name, value] of Object.entries(raw)) {
      validateSkillName(name);
      if (!isRecord(value) || (value.state !== undefined && !['active', 'stale', 'archived'].includes(String(value.state)))) throw new Error('Invalid usage record');
      for (const key of ['pinned', 'locked']) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error('Invalid skill protection');
      for (const key of ['use_count', 'view_count', 'patch_count', 'patch_generation', 'last_reused_patch_generation']) {
        if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0)) throw new Error('Invalid usage counter');
      }
      result[name] = { ...this.empty(), ...value } as Usage;
    }
    return result;
  }
  update(name: string, mutate: (record: Usage) => void): void {
    validateSkillName(name);
    locked(this.root, 'usage', () => { const usage = this.usage(); const record = usage[name] ?? this.empty(); mutate(record); usage[name] = record; writeJson(safePath(this.root, '.usage.json'), usage); });
  }
  activity(name: string, kind: 'view' | 'use' | 'patch'): void {
    this.update(name, record => {
      record[`${kind}_count`]++; record[`last_${kind === 'use' ? 'used' : kind === 'view' ? 'viewed' : 'patched'}_at`] = this.now().toISOString();
      if (kind === 'patch') record.patch_generation++;
      if (kind === 'use') record.last_reused_patch_generation = record.patch_generation;
    });
  }
  created(name: string, source: Usage['created_by'] = 'agent'): void { this.update(name, record => Object.assign(record, this.empty(), { created_by: source })); }
  private bundled(): string[] { return readJson(safePath(this.root, '.bundled_manifest'), []); }
  /** 将发行内置技能镜像到 profile；归档绝不触碰源码目录，suppressed 防止下次启动复活。 */
  syncBuiltins(source: string): void {
    locked(this.root, 'mutation', () => {
      const catalog = new SkillCatalog([source]), suppressed = readJson<string[]>(safePath(this.root, '.curator_suppressed.json'), []);
      const names = this.bundled();
      for (const skill of catalog.discover()) {
        if (!names.includes(skill.name)) names.push(skill.name);
        const target = safePath(this.root, skill.name);
        if (pathExists(target) || suppressed.includes(skill.name)) continue;
        for (const file of collectFiles(dirname(skill.path))) {
          const path = safePath(target, file.path); writeBytes(path, file.data); chmodSync(path, file.mode);
        }
      }
      writeJson(safePath(this.root, '.bundled_manifest'), names);
    });
  }
  catalog(onRead?: (name: string) => void): SkillCatalog {
    const result = new SkillCatalog([this.root, ...this.options.external_dirs], { disabled: this.options.disabled, onRead }); result.discover(); return result;
  }
  rows(): SkillRow[] {
    const usage = this.usage(), bundled = this.bundled(), cron = this.references.names();
    const hub = readJson<unknown>(safePath(this.root, '.hub/lock.json'), {});
    const catalog = new SkillCatalog([this.root, ...this.options.external_dirs]);
    return catalog.discover().map(skill => {
      const record = usage[skill.name] ?? this.empty();
      const external = skill.root !== this.root;
      const installed = record.created_by === 'installed' || (isRecord(hub) && isRecord(hub.installed) && (Object.hasOwn(hub.installed, skill.name) || Object.values(hub.installed).some(entry => isRecord(entry) && entry.install_path === relative(this.root, dirname(skill.path)))));
      const provenance = external ? 'external' : installed ? 'installed' : bundled.includes(skill.name) ? 'bundled' : record.created_by ?? 'unmanaged';
      const dates = [record.last_used_at, record.last_viewed_at, record.last_patched_at].filter((s): s is string => !!s && Number.isFinite(Date.parse(s)));
      dates.sort((a, b) => Date.parse(b) - Date.parse(a));
      return { ...skill, ...record, provenance, managed: !external && !installed && (provenance === 'bundled' ? this.config.prune_builtins : record.created_by === 'agent'),
        disabled: this.options.disabled.includes(skill.name), persisted: !!usage[skill.name], last_activity_at: dates[0], cron: cron.has(skill.name) };
    });
  }
  get(name: string): SkillRow { validateSkillName(name); const row = this.rows().find(row => row.name === name); if (!row) throw new Error(`Unknown skill: ${name}`); return row; }
  adopt(name: string): void {
    locked(this.root, 'mutation', () => {
    const row = this.get(name); if (['external', 'bundled', 'installed'].includes(row.provenance) || row.locked) throw new Error('Skill cannot be adopted');
    this.update(name, record => { record.created_by = 'agent'; });
    });
  }
  protect(name: string, key: 'pinned' | 'locked', value: boolean): void {
    locked(this.root, 'mutation', () => { this.get(name); this.update(name, record => { record[key] = value; }); });
  }
  private writable(row: SkillRow, actor: Actor, deleting = false): void {
    if (row.provenance === 'external') throw new Error('External skills are read-only');
    if (actor !== 'user' && row.locked) throw new Error('Skill is locked');
    if (actor !== 'user' && deleting && row.pinned) throw new Error('Skill is pinned');
    if (actor === 'curator' && (!row.managed || row.pinned || row.disabled || row.provenance === 'bundled')) throw new Error('Skill is outside the consolidation scope');
  }
  package(name: string): PackageFile[] { return collectFiles(dirname(this.get(name).path)); }
  private rooted(directory: string): PackageFile[] { return collectFiles(directory).map(file => ({ ...file, path: relative(this.root, join(directory, file.path)).split('\\').join('/') })); }
  read(name: string, file = 'SKILL.md'): { content: string; encoding: 'utf8' | 'base64'; hash: string; files: string[] } {
    const directory = dirname(this.get(name).path), path = safePath(directory, file);
    if (statSync(path).size > 64 * 1024) throw new Error('File exceeds skill_view budget');
    const bytes = readFileSync(path), encoding = isUtf8(bytes) ? 'utf8' : 'base64';
    return { content: bytes.toString(encoding), encoding, hash: digest(bytes), files: collectFiles(directory).map(item => item.path) };
  }
  archive(name: string, actor: Actor = 'user', absorbedInto?: string, automatic = false): string {
    return locked(this.root, 'mutation', () => this.archiveUnlocked(name, actor, absorbedInto, automatic));
  }
  private archiveUnlocked(name: string, actor: Actor, absorbedInto?: string, automatic = false): string {
    const row = this.get(name);
    if (automatic) {
      if (!row.managed || row.pinned || row.locked || row.cron) throw new Error('Skill is protected from automatic archival');
    } else this.writable(row, actor, true);
    if (row.provenance === 'installed' || (row.provenance === 'bundled' && !this.config.prune_builtins)) throw new Error('Installed/bundled skill is not eligible for archival');
    if (row.pinned || row.locked) throw new Error('Unpin/unlock the skill before archiving');
    if (absorbedInto) { if (absorbedInto === name) throw new Error('Cannot absorb into itself'); const target = this.get(absorbedInto); if (target.disabled) throw new Error('Absorption target is disabled'); }
    if (row.cron && !absorbedInto) throw new Error('Cron references require a live absorption target');
    const source = dirname(row.path), archive = safePath(this.root, '.archive'); mkdirSync(archive, { recursive: true });
    let destination = safePath(archive, name); if (pathExists(destination)) destination = safePath(archive, `${name}--${identifier()}`);
    const before = completePackageBefore(this, source, name, this.rooted(source)), oldUsage = this.usage(), oldSuppressed = readJson<string[]>(safePath(this.root, '.curator_suppressed.json'), []);
    const cronBefore = this.references.snapshot();
    renameSync(source, destination);
    try {
      const now = this.now(); utimesSync(destination, now, now);
      this.update(name, record => { record.state = 'archived'; record.archived_at = now.toISOString(); });
      if (row.provenance === 'bundled') writeJson(safePath(this.root, '.curator_suppressed.json'), [...new Set([...oldSuppressed, name])]);
      if (absorbedInto) this.references.rewrite({ [name]: absorbedInto });
    } catch (error) {
      renameSync(destination, source); writeJson(safePath(this.root, '.usage.json'), oldUsage);
      writeJson(safePath(this.root, '.curator_suppressed.json'), oldSuppressed); this.references.restore(cronBefore); throw error;
    }
    this.ledger.record({ actor, action: 'archive', skill: name, absorbed_into: absorbedInto }, before, this.rooted(destination));
    return relative(archive, destination);
  }
  archives(): { id: string; name: string; archived_at: string }[] {
    const root = safePath(this.root, '.archive'); if (!existsSync(root)) return [];
    // 每个归档独立解析，允许同名技能有多个历史版本。
    return readdirSync(root).flatMap(id => {
      const directory = safePath(root, id); if (!statSync(directory).isDirectory() || !existsSync(join(directory, 'SKILL.md'))) return [];
      const text = readBoundedFile(join(directory, 'SKILL.md'), MAX_SKILL_BYTES);
      const raw = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? id;
      const name = raw.startsWith('"') ? JSON.parse(raw) as string : raw;
      return [{ id, name, archived_at: statSync(directory).mtime.toISOString() }];
    }).sort((a, b) => b.archived_at.localeCompare(a.archived_at));
  }
  restore(id: string): string {
    return locked(this.root, 'mutation', () => {
      const entries = this.archives(), item = entries.find(row => row.id === id) ?? entries.find(row => row.name === id);
      if (!item) throw new Error('Unknown archived skill');
      validateSkillName(item.name);
      if (this.bundled().includes(item.name) && !this.config.prune_builtins) throw new Error('Enable prune_builtins before restoring a bundled skill');
      if (this.rows().some(row => row.name === item.name)) throw new Error('Restore would overwrite a live skill');
      const source = safePath(safePath(this.root, '.archive'), item.id), target = safePath(this.root, item.name);
      if (pathExists(target)) throw new Error('Restore target already exists');
      const before = this.rooted(source), usage = this.usage();
      const suppressed = readJson<string[]>(safePath(this.root, '.curator_suppressed.json'), []);
      renameSync(source, target);
      try {
        this.update(item.name, record => { record.state = 'active'; delete record.archived_at; });
        writeJson(safePath(this.root, '.curator_suppressed.json'), suppressed.filter(name => name !== item.name));
      } catch (error) {
        renameSync(target, source); writeJson(safePath(this.root, '.usage.json'), usage);
        writeJson(safePath(this.root, '.curator_suppressed.json'), suppressed); throw error;
      }
      this.ledger.record({ actor: 'user', action: 'restore', skill: item.name }, before, this.rooted(target)); return item.name;
    });
  }
  purge(days: number, dryRun = false): string[] {
    if (!Number.isFinite(days) || days < 0) throw new Error('Invalid archive TTL');
    if (days === 0) return [];
    return locked(this.root, 'mutation', () => {
      const items = this.archives().filter(item => Date.parse(item.archived_at) <= this.now().getTime() - days * 86_400_000);
      if (!dryRun) for (const item of items) {
        const path = safePath(safePath(this.root, '.archive'), item.id), before = completePackageBefore(this, path, item.name, this.rooted(path));
        this.ledger.record({ actor: 'user', action: 'purge', skill: item.name }, before, []);
        rmSync(path, { recursive: true });
      }
      return items.map(item => item.id);
    });
  }
  mutate(operation: SkillOperation, actor: Actor = 'curator', expected?: string): string {
    return locked(this.root, 'mutation', () => this.mutateUnlocked(operation, actor, expected));
  }
  /** 多文件/多技能批处理：delete 必须单独执行，任何一项失败则恢复所有涉及的包及统计。 */
  batch(operations: SkillOperation[], expected: Record<string, string> = {}): string[] {
    if (!operations.length || operations.length > 20) throw new Error('A skill batch needs 1..20 operations');
    if (operations.some(op => op.action === 'delete')) {
      if (operations.length !== 1) throw new Error('delete must be the sole operation');
      return locked(this.root, 'mutation', () => {
        for (const [key, hash] of Object.entries(expected)) {
          const slash = key.indexOf('/');
          if (this.read(key.slice(0, slash), key.slice(slash + 1)).hash !== hash) throw new Error('Absorption source or target changed since it was read');
        }
        return [this.mutateUnlocked(operations[0], 'curator', expected[`${operations[0].name}/SKILL.md`])];
      });
    }
    return locked(this.root, 'mutation', () => {
      const rows = this.rows(), touched = new Set<string>(), directories = new Map<string, string>();
      for (const op of operations) {
        validateSkillName(op.name);
        const file = operationFile(op), key = `${op.name}/${file}`;
        if (touched.has(key) && (['create', 'write_file', 'remove_file', 'edit'].includes(op.action) || op.content !== undefined)) throw new Error('Batch would clobber an earlier operation');
        touched.add(key);
        const row = rows.find(row => row.name === op.name);
        if (row) this.writable(row, 'curator');
        const directory = row ? dirname(row.path) : directories.get(op.name) ?? safePath(this.root, op.category ? `${op.category}/${op.name}` : op.name);
        if (!row && op.action !== 'create' && !directories.has(op.name)) throw new Error('Create must precede other operations on a new skill');
        directories.set(op.name, directory);
      }
      // 所有读版本检查发生在第一项写入之前；后续 patch 可以基于前一项 patch 的结果。
      for (const [key, hash] of Object.entries(expected)) {
        const slash = key.indexOf('/'), name = key.slice(0, slash), file = key.slice(slash + 1), directory = directories.get(name);
        if (!directory) throw new Error('Unexpected batch read marker');
        const path = safePath(directory, file), current = existsSync(path) ? digest(readFileSync(path)) : 'absent';
        if (current !== hash) throw new Error('File changed since it was read');
      }
      const before = [...directories.values()].flatMap(directory => this.rooted(directory));
      const existed = new Set([...directories.values()].filter(path => existsSync(path)));
      const usage = this.usage();
      try {
        const results = operations.map(op => this.mutateUnlocked(op, 'curator', undefined, true));
        this.ledger.record({ actor: 'curator', action: 'batch', skill: [...directories.keys()].join(',') }, before,
          [...directories.values()].flatMap(directory => this.rooted(directory)));
        return results;
      } catch (error) {
        for (const directory of directories.values()) {
          if (!existed.has(directory)) rmSync(directory, { recursive: true, force: true });
          else for (const file of collectFiles(directory)) rmSync(safePath(directory, file.path));
        }
        for (const file of before) { const path = safePath(this.root, file.path); writeBytes(path, file.data); chmodSync(path, file.mode); }
        writeJson(safePath(this.root, '.usage.json'), usage); throw error;
      }
    });
  }
  private mutateUnlocked(operation: SkillOperation, actor: Actor, expected?: string, deferLedger = false): string {
      const op = operation; validateSkillName(op.name);
      if (op.content !== undefined && (op.old_string !== undefined || op.new_string !== undefined)) throw new Error('Use content OR old_string/new_string');
      if (op.action === 'delete') {
        if (expected !== undefined && this.read(op.name).hash !== expected) throw new Error('Skill changed since it was read');
        return this.archiveUnlocked(op.name, actor, op.absorbed_into);
      }
      const creating = op.action === 'create';
      const row = creating ? undefined : this.get(op.name);
      if (row) this.writable(row, actor);
      if (creating && this.rows().some(row => row.name === op.name)) throw new Error('Skill already exists');
      const directory = creating ? safePath(this.root, op.category ? `${op.category}/${op.name}` : op.name) : dirname(row!.path);
      if (creating && pathExists(directory)) throw new Error('Skill path already exists');
      const file = ['write_file', 'remove_file'].includes(op.action) ? op.file_path : op.action === 'patch' && op.content === undefined ? op.file_path ?? 'SKILL.md' : 'SKILL.md';
      if (!file || file.split(/[\\/]/u).some(part => part.startsWith('.')) || (op.action === 'remove_file' && file === 'SKILL.md')) throw new Error('Invalid package file operation');
      const path = safePath(directory, file), previous = existsSync(path) ? readFileSync(path) : undefined;
      const previousMode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
      if (previous && previous.length > 64 * 1024) throw new Error('File exceeds edit budget');
      if (expected !== undefined && (previous === undefined ? 'absent' : digest(previous)) !== expected) throw new Error('File changed since it was read');
      let content = op.action === 'write_file' ? op.file_content ?? op.content : op.content;
      if (op.old_string !== undefined) {
        if (!previous || !isUtf8(previous) || !op.old_string || !previous.toString().includes(op.old_string) || (!op.replace_all && previous.toString().split(op.old_string).length !== 2) || op.new_string === undefined) throw new Error('Patch must match exactly once unless replace_all is true');
        content = op.replace_all ? previous.toString().split(op.old_string).join(op.new_string) : previous.toString().replace(op.old_string, op.new_string);
      }
      if (creating && content && !content.startsWith('---\n')) {
        if (!op.description?.trim() || op.description.length > 500 || /[\r\n]/u.test(op.description)) throw new Error('Description required');
        content = `---\nname: ${op.name}\ndescription: ${JSON.stringify(op.description)}\n---\n\n${content}\n`;
      }
      if (op.action !== 'remove_file' && (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > (file === 'SKILL.md' ? MAX_SKILL_BYTES : 64 * 1024))) throw new Error('Invalid file content');
      if (op.action === 'remove_file' && previous === undefined) throw new Error('File does not exist');
      if (op.encoding === 'base64' && (file === 'SKILL.md' || !content || Buffer.from(content, 'base64').toString('base64') !== content)) throw new Error('Invalid binary file encoding');
      const before = this.rooted(directory);
      try {
        if (op.action === 'remove_file') rmSync(path); else { writeBytes(path, Buffer.from(content!, op.encoding ?? 'utf8')); chmodSync(path, previousMode); }
        const catalog = new SkillCatalog([this.root]); catalog.discover();
        if (!catalog.skills.has(op.name) || catalog.skills.get(op.name)!.path !== join(directory, 'SKILL.md')) throw new Error('Skill name cannot be changed');
        if (creating) this.created(op.name, actor === 'curator' ? 'agent' : 'learn'); else this.activity(op.name, 'patch');
      } catch (error) {
        if (creating) rmSync(directory, { recursive: true, force: true });
        else if (previous !== undefined) { writeBytes(path, previous); chmodSync(path, previousMode); } else rmSync(path, { force: true });
        throw error;
      }
      if (!deferLedger) this.ledger.record({ actor, action: op.action, skill: op.name }, before, this.rooted(directory)); return op.name;
  }
}

export function operationFile(op: SkillOperation): string {
  const file = ['write_file', 'remove_file'].includes(op.action) ? op.file_path ?? ''
    : op.action === 'patch' && op.content === undefined ? op.file_path ?? 'SKILL.md' : 'SKILL.md';
  if (file.split(/[\\/]/u).includes('..')) throw new Error('Invalid relative file path');
  return file ? posix.normalize(file) : '';
}
