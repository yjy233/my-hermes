/** 独立实现的 USTAR + gzip 快照；不调用 shell，不接受链接或越界路径。 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { collectFiles, digest, EXCLUDED, identifier, locked, pruneEmptyDirectories, readJson, safePath, writeBytes, writeJson, type PackageFile } from './files.js';
import type { SkillRepository } from './repository.js';
import type { CronSnapshot } from './cron.js';
const MAX_BYTES = 256 * 1024 * 1024;
export interface Snapshot { id: string; created_at: string; reason: string; skill_count: number; sha256: string; cron: CronSnapshot[] }
export function pack(files: PackageFile[]): Buffer {
  const chunks: Buffer[] = [];
  let total = 1024;
  for (const file of files) {
    total += 512 + Math.ceil(file.data.length / 512) * 512;
    if (total > MAX_BYTES) throw new Error('Snapshot exceeds 256 MiB');
    const header = Buffer.alloc(512);
    let name = file.path, prefix = '';
    if (Buffer.byteLength(name) > 100) {
      const splits = [...name.matchAll(/\//g)].map(match => match.index).reverse();
      const split = splits.find(index => Buffer.byteLength(name.slice(0, index)) <= 155 && Buffer.byteLength(name.slice(index + 1)) <= 100);
      if (split === undefined) throw new Error('Path too long for USTAR');
      prefix = name.slice(0, split); name = name.slice(split + 1);
    }
    header.write(name, 0, 100); header.write(prefix, 345, 155);
    const octal = (offset: number, length: number, value: number) => header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
    octal(100, 8, file.mode); octal(108, 8, 0); octal(116, 8, 0); octal(124, 12, file.data.length); octal(136, 12, 0);
    header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257, 6); header.write('00', 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    chunks.push(header, file.data, Buffer.alloc((512 - file.data.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024)); return gzipSync(Buffer.concat(chunks));
}
export function unpack(bytes: Buffer, root: string): PackageFile[] {
  const tar = gunzipSync(bytes, { maxOutputLength: MAX_BYTES }), files: PackageFile[] = [], seen = new Set<string>();
  let offset = 0;
  const text = (buffer: Buffer, start: number, length: number) => buffer.subarray(start, start + length).toString('utf8').split('\0')[0];
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512); offset += 512;
    if (header.every(byte => byte === 0)) return files;
    const check = Number.parseInt(text(header, 148, 8).trim(), 8);
    const computed = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    if (check !== computed || text(header, 257, 6) !== 'ustar' || ![0, 48].includes(header[156])) throw new Error('Invalid or unsupported snapshot entry');
    const prefix = text(header, 345, 155), path = (prefix ? prefix + '/' : '') + text(header, 0, 100);
    safePath(root, path);
    if (path.split(/[\\/]/u).some(part => EXCLUDED.has(part)) || seen.has(path)) throw new Error('Excluded or duplicate snapshot entry');
    seen.add(path);
    const size = Number.parseInt(text(header, 124, 12), 8), mode = Number.parseInt(text(header, 100, 8), 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > tar.length || !Number.isSafeInteger(mode)) throw new Error('Invalid snapshot size/mode');
    files.push({ path, mode: mode & 0o777, data: Buffer.from(tar.subarray(offset, offset + size)) });
    offset += Math.ceil(size / 512) * 512;
  }
  throw new Error('Truncated snapshot');
}
export class SkillBackups {
  readonly root: string;
  constructor(readonly repo: SkillRepository) { this.root = safePath(repo.root, '.curator_backups'); }
  list(): Snapshot[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root).filter(id => existsSync(safePath(this.root, `${id}/manifest.json`)))
      .map(id => readJson<Snapshot>(safePath(this.root, `${id}/manifest.json`), {} as Snapshot)).sort((a, b) => b.id.localeCompare(a.id));
  }
  snapshot(reason = 'manual', protect?: string): Snapshot | null {
    if (!this.repo.config.backup.enabled) return null;
    return locked(this.repo.root, 'mutation', () => this.snapshotUnlocked(reason, protect));
  }
  private snapshotUnlocked(reason: string, protect?: string): Snapshot {
    const id = identifier(), bytes = pack(collectFiles(this.repo.root));
    const snapshot: Snapshot = { id, reason, created_at: this.repo.now().toISOString(), skill_count: this.repo.rows().filter(row => row.root === this.repo.root).length,
      sha256: digest(bytes), cron: this.repo.references.snapshot() };
    const path = safePath(this.root, id); mkdirSync(path, { recursive: true });
    try { writeBytes(join(path, 'skills.tar.gz'), bytes); writeJson(join(path, 'manifest.json'), snapshot); }
    catch (error) { rmSync(path, { recursive: true, force: true }); throw error; }
    this.prune(protect); return snapshot;
  }
  prune(protect?: string): void {
    for (const snapshot of this.list().slice(this.repo.config.backup.keep)) if (snapshot.id !== protect) rmSync(safePath(this.root, snapshot.id), { recursive: true });
  }
  rollback(id?: string): Snapshot {
    if (!this.repo.config.backup.enabled) throw new Error('Enable curator.backup before rollback; a safety snapshot is required');
    return locked(this.repo.root, 'mutation', () => {
      const snapshot = id ? this.list().find(item => item.id === id) : this.list()[0];
      if (!snapshot) throw new Error('Unknown snapshot');
      const bytes = readFileSync(safePath(this.root, `${snapshot.id}/skills.tar.gz`));
      if (digest(bytes) !== snapshot.sha256) throw new Error('Snapshot checksum mismatch');
      const restore = unpack(bytes, this.repo.root); // 全部验证后才触碰当前树。
      const before = collectFiles(this.repo.root), cron = this.repo.references.snapshot();
      const safety = this.snapshotUnlocked(`pre-rollback:${snapshot.id}`, snapshot.id);
      const stage = safePath(this.repo.root, `.rollback-${identifier()}`), moved: string[] = [], written: string[] = [];
      mkdirSync(stage);
      try {
        // 先把当前文件 rename 到 staging。安装失败时可直接 rename 回去，磁盘满也不必重写旧字节。
        for (const file of before) {
          const target = safePath(stage, file.path); mkdirSync(dirname(target), { recursive: true });
          renameSync(safePath(this.repo.root, file.path), target); moved.push(file.path);
        }
        for (const file of restore) {
          const path = safePath(this.repo.root, file.path); written.push(file.path);
          writeBytes(path, file.data); chmodSync(path, file.mode);
        }
        this.repo.references.restore(snapshot.cron);
      } catch (error) {
        try {
          for (const path of written) if (existsSync(safePath(this.repo.root, path)) && statSync(safePath(this.repo.root, path)).isFile()) rmSync(safePath(this.repo.root, path));
          for (const path of moved) {
            const target = safePath(this.repo.root, path);
            if (existsSync(target) && statSync(target).isDirectory()) rmdirSync(target);
            mkdirSync(dirname(target), { recursive: true }); renameSync(safePath(stage, path), target);
          }
          this.repo.references.restore(cron); rmSync(stage, { recursive: true });
        } catch (recoveryError) {
          throw new Error(`Rollback failed (${String(error)}); recovery failed (${String(recoveryError)}). Staging retained: ${stage}; safety snapshot: ${safety.id}`);
        }
        throw error;
      }
      this.repo.ledger.record({ actor: 'user', action: 'rollback', skill: '*', reverses: snapshot.id }, before, restore);
      pruneEmptyDirectories(this.repo.root);
      try { rmSync(stage, { recursive: true }); } catch (error) { this.repo.ledger.warnings.push(`Rollback staging cleanup: ${String(error)}`); }
      return safety;
    });
  }
}

/** 合并时配套文件可能已迁移；归档/清除的审计快照从最近整库备份补全缺项，磁盘版本优先。 */
export function completePackageBefore(repo: SkillRepository, directory: string, name: string, current: PackageFile[]): PackageFile[] {
  try {
    const latest = new SkillBackups(repo).list()[0]; if (!latest) return current;
    const root = safePath(repo.root, '.curator_backups'), bytes = readFileSync(safePath(root, `${latest.id}/skills.tar.gz`));
    if (digest(bytes) !== latest.sha256) throw new Error('Backup checksum mismatch');
    const files = unpack(bytes, repo.root);
    const skill = files.find(file => file.path.endsWith('/SKILL.md') && new RegExp(`^name:\\s*["']?${name}["']?\\s*$`, 'm').test(file.data.toString()));
    if (!skill) return current;
    const oldPrefix = skill.path.slice(0, -'SKILL.md'.length), nextPrefix = directory.slice(repo.root.length + 1).split('\\').join('/') + '/';
    const live = new Set(current.map(file => file.path));
    return [...current, ...files.filter(file => file.path.startsWith(oldPrefix)).map(file => ({ ...file, path: nextPrefix + file.path.slice(oldPrefix.length) })).filter(file => !live.has(file.path))];
  } catch (error) { repo.ledger.warnings.push(`Complete package capture: ${String(error)}`); return current; }
}
