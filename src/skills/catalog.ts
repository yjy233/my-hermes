/** 渐进加载：先提供元数据，收到请求后才读取有大小上限的 Markdown 正文。 */
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertSafeFile, readBoundedFile } from '../memory/files.js';

export const MAX_SKILL_BYTES = 32_000;
export interface Skill { name: string; description: string; path: string; root: string }

export function validateSkillName(name: string): void {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(name)) {
    throw new Error('Skill name must be 1-64 lowercase letters, digits, or hyphens');
  }
}

function scalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'string') throw new Error('Skill metadata must be text');
    return parsed;
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}

export class SkillCatalog {
  readonly roots: string[];
  skills = new Map<string, Skill>();

  constructor(roots: string[]) { this.roots = roots.map(root => resolve(root)); }

  discover(): Skill[] {
    const found = new Map<string, Skill>();
    for (const configuredRoot of this.roots) {
      if (!existsSync(configuredRoot)) continue;
      const root = realpathSync(configuredRoot);
      for (const directory of readdirSync(root).sort()) {
        const directoryPath = join(root, directory);
        if (lstatSync(directoryPath).isSymbolicLink()) throw new Error('Skill directories cannot be symlinks');
        const path = join(directoryPath, 'SKILL.md');
        if (!lstatSync(directoryPath).isDirectory() || !existsSync(path)) continue;
        assertSafeFile(root, path);
        const text = readBoundedFile(path, MAX_SKILL_BYTES);
        const lines = text.split(/\r?\n/);
        if (lines[0] !== '---') throw new Error(`Skill is missing frontmatter: ${path}`);
        const end = lines.indexOf('---', 1);
        if (end === -1) throw new Error(`Skill frontmatter is not closed: ${path}`);
        const metadata = new Map<string, string>();
        for (const line of lines.slice(1, end)) {
          if (!line.trim() || line.trimStart().startsWith('#')) continue;
          const colon = line.indexOf(':');
          if (colon < 1) throw new Error('Only single-line key: value skill metadata is supported');
          metadata.set(line.slice(0, colon).trim(), scalar(line.slice(colon + 1)));
        }
        const name = metadata.get('name') ?? '';
        const description = metadata.get('description') ?? '';
        validateSkillName(name);
        if (!description || description.length > 500 || /[\r\n]/.test(description)) {
          throw new Error('Skill description must be one line of 1-500 characters');
        }
        if (found.has(name)) throw new Error(`Duplicate skill: ${name}`);
        found.set(name, { name, description, path, root });
      }
    }
    this.skills = found;
    return [...found.values()];
  }

  index(): string {
    return [...this.skills.values()].map(skill => `- ${skill.name}: ${skill.description}`).join('\n');
  }

  read(name: string): string {
    validateSkillName(name);
    const skill = this.skills.get(name);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    assertSafeFile(skill.root, skill.path);
    return readBoundedFile(skill.path, MAX_SKILL_BYTES);
  }
}
