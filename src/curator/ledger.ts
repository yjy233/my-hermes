/** 每次变更保存内容寻址的二进制快照；正常记录尽力而为，撤销前的安全记录必须成功。 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, chmodSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWrite, readBoundedFile } from '../memory/files.js';
import { collectFiles, digest, identifier, locked, readJson, safePath, writeBytes, type PackageFile } from './files.js';
import type { SkillSettings } from './settings.js';

export type Actor = 'agent' | 'curator' | 'user';
export interface FileRef { path: string; sha256: string; mode: number }
export interface LedgerEntry {
  id: string; at: string; actor: Actor; action: string; skill: string; session_id?: string; absorbed_into?: string;
  before: FileRef[]; after: FileRef[]; reverses?: string;
}
export class SkillLedger {
  readonly path: string;
  readonly blobs: string;
  warnings: string[] = [];
  constructor(readonly root: string, readonly settings: SkillSettings) {
    this.path = join(root, '.curator_ledger.jsonl');
    this.blobs = join(dirname(root), '.curator_backups', 'blobs');
  }
  capture(files: PackageFile[]): FileRef[] {
    return files.map(file => {
      const sha256 = digest(file.data), path = safePath(this.blobs, sha256);
      if (!existsSync(path)) writeBytes(path, file.data);
      return { path: file.path, sha256, mode: file.mode };
    });
  }
  materialize(refs: FileRef[]): PackageFile[] {
    return refs.map(ref => {
      if (!/^[a-f0-9]{64}$/.test(ref.sha256)) throw new Error('Invalid ledger blob hash');
      const blob = safePath(this.blobs, ref.sha256);
      const bytes = existsSync(blob) ? readFileSync(blob) : undefined;
      if (!bytes || digest(bytes) !== ref.sha256) throw new Error(`Missing or corrupt ledger blob: ${ref.sha256}`);
      safePath(this.root, ref.path);
      return { path: ref.path, data: bytes, mode: ref.mode };
    });
  }
  entries(): LedgerEntry[] {
    if (!existsSync(this.path)) return [];
    return readBoundedFile(this.path, 256 * 1024 * 1024).split('\n').filter(Boolean).flatMap(line => {
      try { const value = JSON.parse(line) as LedgerEntry; return value.id && Array.isArray(value.before) && Array.isArray(value.after) ? [value] : []; }
      catch { return []; }
    });
  }
  record(meta: Omit<LedgerEntry, 'id' | 'at' | 'before' | 'after'>, before: PackageFile[], after: PackageFile[], strict = false): string | undefined {
    if (!this.settings.ledger && !strict) return;
    try {
      return locked(this.root, 'ledger', () => {
        mkdirSync(this.root, { recursive: true });
        const unchanged = new Set(before.filter(a => after.some(b => b.path === a.path && b.mode === a.mode && digest(b.data) === digest(a.data))).map(f => f.path));
        const entry: LedgerEntry = { ...meta, id: identifier(), at: new Date().toISOString(),
          before: this.capture(before.filter(f => !unchanged.has(f.path))), after: this.capture(after.filter(f => !unchanged.has(f.path))) };
        // 写入前先验明 ledger 路径不是符号链接。
        safePath(this.root, '.curator_ledger.jsonl');
        let prefix = '';
        if (existsSync(this.path) && statSync(this.path).size) {
          const descriptor = openSync(this.path, 'r'), last = Buffer.alloc(1);
          try { readSync(descriptor, last, 0, 1, statSync(this.path).size - 1); } finally { closeSync(descriptor); }
          if (last[0] !== 10) prefix = '\n';
        }
        appendFileSync(this.path, prefix + JSON.stringify(entry) + '\n', { mode: 0o600, flush: true });
        this.compactUnlocked(); return entry.id;
      });
    } catch (error) {
      if (strict) throw error;
      this.warnings.push(`Ledger: ${String(error)}`); return;
    }
  }
  compact(): void { locked(this.root, 'ledger', () => this.compactUnlocked()); }
  private compactUnlocked(): void {
    if (!existsSync(this.path)) return;
    let lines = readBoundedFile(this.path, 256 * 1024 * 1024).split('\n').filter(Boolean);
    const limit = this.settings.ledger_max_bytes;
    if (limit && Buffer.byteLength(lines.join('\n')) > limit) {
      lines = lines.map(line => {
        try {
          const entry = JSON.parse(line) as LedgerEntry;
          if (!Array.isArray(entry.before) || !Array.isArray(entry.after)) return line;
          const same = new Set(entry.before.filter(a => entry.after.some(b => b.path === a.path && b.sha256 === a.sha256 && b.mode === a.mode)).map(a => a.path));
          return JSON.stringify({ ...entry, before: entry.before.filter(f => !same.has(f.path)), after: entry.after.filter(f => !same.has(f.path)) });
        } catch { return line; }
      });
      // 最新一条及损坏的尾行保留；不在这里悄悄修复坏记录。
      while (lines.length > 1 && Buffer.byteLength(lines.join('\n')) > Math.floor(limit * 0.8)) {
        let lastValid = -1;
        for (let i = 0; i < lines.length; i++) { try { if (JSON.parse(lines[i]).id) lastValid = i; } catch { /* preserve */ } }
        if (lastValid <= 0) break;
        lines.shift();
      }
      atomicWrite(this.path, lines.join('\n') + '\n');
    }
    const live = new Set(this.entries().flatMap(entry => [...entry.before, ...entry.after].map(file => file.sha256)));
    if (existsSync(this.blobs)) for (const name of readdirSync(this.blobs)) {
      if (/^[a-f0-9]{64}$/.test(name) && !live.has(name) && Date.now() - statSync(join(this.blobs, name)).mtimeMs > 3_600_000) rmSync(join(this.blobs, name));
    }
  }
  undo(id: string): string {
    if (!this.settings.ledger) throw new Error('Enable skills.ledger before undo; a safety record is required');
    return locked(this.root, 'mutation', () => {
      const entry = this.entries().find(item => item.id === id);
      if (!entry) throw new Error('Unknown ledger entry');
      const restore = this.materialize(entry.before); // 先校验所有 blob，避免还原半途才发现丢失。
      const paths = new Set([...entry.before, ...entry.after].map(file => file.path));
      const before = collectFiles(this.root, new Set()).filter(file => paths.has(file.path));
      const safety = this.record({ actor: 'user', action: 'rollback', skill: entry.skill, reverses: id }, before, restore, true)!;
      try {
        for (const path of paths) rmSync(safePath(this.root, path), { force: true });
        for (const file of restore) { const path = safePath(this.root, file.path); writeBytes(path, file.data); chmodSync(path, file.mode); }
      } catch (error) {
        for (const path of paths) rmSync(safePath(this.root, path), { force: true });
        for (const file of before) { const path = safePath(this.root, file.path); writeBytes(path, file.data); chmodSync(path, file.mode); }
        throw error;
      }
      for (const path of paths) {
        let parent = dirname(safePath(this.root, path));
        while (parent !== this.root) {
          try { rmdirSync(parent); } catch { break; }
          parent = dirname(parent);
        }
      }
      return safety;
    });
  }
}
