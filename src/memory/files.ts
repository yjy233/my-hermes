/** 本地文件读写的基础操作；这些检查不构成操作系统级沙箱。 */
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export function pathExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function canonicalDirectory(path: string): string {
  mkdirSync(path, { recursive: true });
  return realpathSync(path);
}

export function assertContained(root: string, path: string): void {
  const difference = relative(root, resolve(path));
  if (difference === '..' || difference.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
      || isAbsolute(difference)) {
    throw new Error('File path escapes its configured root');
  }
}

export function assertSafeFile(root: string, path: string): void {
  assertContained(root, path);
  assertContained(root, realpathSync(dirname(path)));
  if (pathExists(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error('File path escapes its root through a symlink');
  }
}

export function readBoundedFile(path: string, maxBytes: number): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error('Expected a regular file');
    if (stat.size > maxBytes) throw new Error(`File exceeds the ${maxBytes}-byte budget`);
    return readFileSync(descriptor, 'utf8');
  } finally { closeSync(descriptor); }
}

export function atomicWrite(path: string, content: string): void {
  const temporary = join(dirname(path), `.write-${randomUUID()}`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
