/** Bounded curated Markdown, isolated by a hashed user scope. */
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { assertSafeFile, atomicWrite, canonicalDirectory, pathExists, readBoundedFile } from './files.js';

export type MemoryTarget = 'MEMORY.md' | 'USER.md';
export class LongTermMemory {
  readonly root: string;
  readonly maxChars: number;

  constructor(root: string, maxChars = 4000) {
    if (!Number.isInteger(maxChars) || maxChars <= 0) throw new Error('Memory budget must be positive');
    this.root = canonicalDirectory(root);
    this.maxChars = maxChars;
  }

  private memoryPath(scope: string, target: string): string {
    if (target !== 'MEMORY.md' && target !== 'USER.md') {
      throw new Error('Memory target must be MEMORY.md or USER.md');
    }
    if (typeof scope !== 'string' || !scope) throw new Error('Memory scope is required');
    const directory = join(this.root, createHash('sha256').update(scope).digest('hex'));
    if (pathExists(directory) && lstatSync(directory).isSymbolicLink()) {
      throw new Error('Memory scope directories cannot be symlinks');
    }
    mkdirSync(directory, { recursive: true });
    const path = join(directory, target);
    assertSafeFile(this.root, path);
    return path;
  }

  read(scope: string, target: string): string {
    const path = this.memoryPath(scope, target);
    if (!pathExists(path)) return '';
    const content = readBoundedFile(path, this.maxChars * 4);
    if (content.length > this.maxChars) throw new Error('Memory file exceeds the configured budget');
    return content;
  }

  write(scope: string, target: string, content: string): void {
    if (typeof content !== 'string' || content.length > this.maxChars) {
      throw new Error(`Memory content must be at most ${this.maxChars} characters`);
    }
    atomicWrite(this.memoryPath(scope, target), content);
  }

  snapshot(scope: string): string {
    return ['MEMORY.md', 'USER.md'].map(target => `## ${target}\n${this.read(scope, target)}`).join('\n\n');
  }
}
