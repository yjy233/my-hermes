import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { assertContained, atomicWrite, pathExists, readBoundedFile } from '../memory/files.js';

export const EXCLUDED = new Set(['.archive', '.curator_backups', '.curator_ledger.jsonl', '.hub', '.locks', '.git',
  'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.pending']);
export const digest = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
export const identifier = (): string => new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);

export function safePath(root: string, name: string): string {
  if (!name || name.includes('\0') || isAbsolute(name) || name.split(/[\\/]/u).some(part => part === '..')) throw new Error('Invalid relative path');
  const path = resolve(root, name);
  assertContained(root, path);
  // 检查每层已有父目录；不能通过中间的 symlink 绕过技能根目录。
  let current = root;
  for (const part of relative(root, path).split(/[\\/]/u)) {
    current = join(current, part);
    if (pathExists(current) && lstatSync(current).isSymbolicLink()) throw new Error('Symlinks are not supported in skill packages');
  }
  return path;
}

export function readJson<T>(path: string, fallback: T): T {
  if (!pathExists(path)) return structuredClone(fallback);
  return JSON.parse(readBoundedFile(path, 32 * 1024 * 1024)) as T;
}
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, JSON.stringify(value, null, 2) + '\n');
}
export function writeBytes(path: string, data: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.write-${randomUUID()}`);
  try { writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 }); renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
}

export interface PackageFile { path: string; data: Buffer; mode: number }
export function collectFiles(root: string, exclude = EXCLUDED): PackageFile[] {
  if (!existsSync(root)) return [];
  const result: PackageFile[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      if (exclude.has(name) || name.startsWith('.write-') || name.startsWith('.rollback-')) continue;
      const path = join(directory, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Symlink in skill tree: ${relative(root, path)}`);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) {
        if (stat.size > 64 * 1024 * 1024) throw new Error('Skill file exceeds backup budget');
        result.push({ path: relative(root, path).split('\\').join('/'), data: readFileSync(path), mode: stat.mode & 0o777 });
      } else throw new Error('Unsupported entry in skill tree');
    }
  };
  walk(root);
  return result;
}

/** 原子 mkdir 锁带所有权 token；只回收已确认死亡进程留下的锁。 */
export function acquireFileLock(root: string, name: string): (() => void) | null {
  const directory = join(root, '.locks'); mkdirSync(directory, { recursive: true });
  const path = safePath(directory, name), token = randomUUID();
  if (existsSync(path)) {
    const owner = readJson<{ pid?: number }>(join(path, 'owner.json'), {});
    if (!Number.isSafeInteger(owner.pid) || owner.pid! <= 0) return null;
    try { process.kill(owner.pid!, 0); return null; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return null; }
    rmSync(path, { recursive: true, force: true });
  }
  try { mkdirSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null; throw error; }
  try { writeJson(join(path, 'owner.json'), { pid: process.pid, token, createdAt: new Date().toISOString() }); }
  catch (error) { rmSync(path, { recursive: true, force: true }); throw error; }
  return () => {
    if (readJson<{ token?: string }>(join(path, 'owner.json'), {}).token === token) rmSync(path, { recursive: true, force: true });
  };
}

export function locked<T>(root: string, name: string, work: () => T): T {
  const release = acquireFileLock(root, name);
  if (!release) throw new Error(`Skill state is busy: ${name}`);
  try { return work(); } finally { release(); }
}
