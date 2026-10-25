import { randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

/** 通过原子 mkdir 实现跨平台的 profile 占用检查，不推测是否可以回收某个 PID。 */
export class ProfileLock {
  readonly home: string;
  readonly path: string;
  private token: string | undefined;

  constructor(home: string) {
    this.home = resolve(home);
    this.path = join(this.home, '.runtime.lock');
  }

  acquire(): this {
    if (this.token) throw new Error(`Profile lock is already acquired: ${this.home}`);
    mkdirSync(this.home, { recursive: true });
    try {
      mkdirSync(this.path, { mode: 0o700 });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      throw new Error(
        `Profile already in use or stale lock: ${this.home}. `
        + 'Stop and verify the previous process has exited, then manually remove '
        + `${this.path}; stale locks are never reclaimed automatically.`,
      );
    }
    const token = randomUUID();
    try {
      const descriptor = openSync(join(this.path, 'owner.json'), 'wx', 0o600);
      try {
        writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, token })}\n`);
      } finally {
        closeSync(descriptor);
      }
      this.token = token;
      return this;
    } catch (error: unknown) {
      const metadata = join(this.path, 'owner.json');
      if (existsSync(metadata)) unlinkSync(metadata);
      rmdirSync(this.path);
      throw error;
    }
  }

  release(): void {
    if (!this.token) return;
    const token = this.token;
    const metadata = join(this.path, 'owner.json');
    const owner = JSON.parse(readFileSync(metadata, 'utf-8')) as { token?: unknown };
    if (owner.token !== token) {
      throw new Error(`Profile lock ownership changed; refusing to remove ${this.path}`);
    }
    unlinkSync(metadata);
    rmdirSync(this.path);
    this.token = undefined;
  }
}
