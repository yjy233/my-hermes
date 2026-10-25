import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { initializeProfile, loadSettings, type SettingsOverrides } from '../src/config.js';

function fixture(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'hermes-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}
test('config overrides and relative trusted plugins preserve profile source on re-init', t => {
  const home = fixture(t);
  const source = JSON.stringify({ mode: 'learner', provider: 'compatible', plugins: ['plugins/example.ts'] });
  writeFileSync(join(home, 'config.json'), source);
  const settings = loadSettings(home, { provider: 'demo' });
  assert.equal(settings.mode, 'learner'); assert.equal(settings.provider, 'demo');
  assert.deepEqual(settings.plugins, [join(home, 'plugins/example.ts')]);
  initializeProfile(settings); assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), source);
});
for (const value of [NaN, Infinity, true, 0, -1, 2 ** 32]) test(`invalid timeout ${String(value)} rejected before profile creation`, t => {
  const home = join(fixture(t), 'uncreated');
  assert.throws(() => loadSettings(home, { turnTimeoutMs: value } as SettingsOverrides), /turnTimeoutMs/);
  assert.equal(existsSync(home), false);
});
for (const [name, value] of [['mode', []], ['provider', []], ['model', 42], ['baseUrl', null]] as const) {
  test(`config ${name} rejects incorrect types`, t => {
    assert.throws(() => loadSettings(fixture(t), { [name]: value } as SettingsOverrides), /nonempty text/);
  });
}
test('unknown keys, malformed JSON and non-object configs fail clearly', t => {
  const home = fixture(t), path = join(home, 'config.json');
  writeFileSync(path, '{"unrecognized":true}'); assert.throws(() => loadSettings(home), /Unknown config key/);
  writeFileSync(path, '[]'); assert.throws(() => loadSettings(home), /must contain an object/);
  writeFileSync(path, 'broken'); assert.throws(() => loadSettings(home), SyntaxError);
});
