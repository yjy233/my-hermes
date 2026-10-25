import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ProfileLock } from '../src/profile-lock.js';

test('same profile excludes another owner, different profile works and release is reusable', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hermes-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lock = new ProfileLock(join(root, 'one')).acquire();
  try {
    assert.throws(() => lock.acquire(), /already acquired/u);
    assert.throws(() => new ProfileLock(join(root, 'one')).acquire(), /already in use/u);
    const other = new ProfileLock(join(root, 'two')).acquire();
    other.release();
  } finally { lock.release(); }
  assert.equal(existsSync(lock.path), false);
  lock.acquire().release();
  lock.release();
});

test('stale locks are explicit and owner token prevents deleting a replaced lock', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hermes-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stale = join(root, '.runtime.lock');
  mkdirSync(stale);
  writeFileSync(join(stale, 'owner.json'), JSON.stringify({ pid: 999999999, token: 'old' }));
  assert.throws(() => new ProfileLock(root).acquire(), /manually remove/u);
  rmSync(stale, { recursive: true });
  const lock = new ProfileLock(root).acquire();
  const ownerPath = join(lock.path, 'owner.json');
  const original = readFileSync(ownerPath);
  writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, token: 'changed' }));
  assert.throws(() => lock.release(), /ownership changed/u);
  assert.equal(existsSync(lock.path), true);
  writeFileSync(ownerPath, original);
  lock.release();
});

test('real subprocess cannot acquire another process profile and lock releases after errors', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hermes-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = dirname(dirname(fileURLToPath(import.meta.url)));
  const source = `
    import { ProfileLock } from './src/profile-lock.ts';
    try { const lock = new ProfileLock(process.argv[1]).acquire();
      console.log('acquired'); lock.release();
    } catch { console.log('locked'); }
  `;
  const child = (): string => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, root], {
      cwd: project, encoding: 'utf-8', timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const lock = new ProfileLock(root);
  assert.throws(() => {
    lock.acquire();
    try { assert.equal(child(), 'locked'); throw new Error('test'); }
    finally { lock.release(); }
  }, /test/u);
  assert.equal(child(), 'acquired');
});
