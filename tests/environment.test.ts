/** 验证本地凭证加载优先级，以及不依赖真实账户的完整 CLI 请求链路。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadEnvironmentFile } from '../src/environment.js';
import { loadSettings } from '../src/config.js';
import { createProvider } from '../src/core/provider-factory.js';
import { KimiProvider } from '../src/core/providers/kimi.js';

function fixture(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'hermes-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}
function invoke(root: string, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const environment: NodeJS.ProcessEnv = { ...process.env, MY_HERMES_HOME: join(root, 'profile') };
  for (const name of ['MOONSHOT_API_KEY', 'KIMI_API_KEY', 'MY_HERMES_API_KEY', 'OPENAI_API_KEY']) delete environment[name];
  Object.assign(environment, extra);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ...args,
    ], { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI test exceeded its time budget')); }, 15_000);
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test('optional .env absence is harmless, explicit missing file fails clearly', t => {
  const root = fixture(t), environment = { EXISTING: 'kept' };
  assert.equal(loadEnvironmentFile(undefined, environment, root).loaded, false);
  assert.deepEqual(environment, { EXISTING: 'kept' });
  assert.throws(() => loadEnvironmentFile('missing.env', environment, root), /Environment file not found/);
});

test('.env parses comments and quotes while preserving shell variables, including explicit empty values', t => {
  const root = fixture(t);
  writeFileSync(join(root, '.env'), '# 本地配置\nMOONSHOT_API_KEY="file-key"\nEXISTING=file\nEMPTY=file\nLITERAL="$(touch should-not-exist)"\n');
  const environment: NodeJS.ProcessEnv = { EXISTING: 'shell', EMPTY: '' };
  assert.equal(loadEnvironmentFile(undefined, environment, root).loaded, true);
  assert.equal(environment.MOONSHOT_API_KEY, 'file-key');
  assert.equal(environment.EXISTING, 'shell'); assert.equal(environment.EMPTY, '');
  assert.equal(environment.LITERAL, '$(touch should-not-exist)');
  assert.equal(existsSync(join(root, 'should-not-exist')), false);
});

test('oversized env files fail before injecting configuration', t => {
  const root = fixture(t), environment = {};
  writeFileSync(join(root, '.env'), `KEY=${'x'.repeat(64_000)}`);
  assert.throws(() => loadEnvironmentFile(undefined, environment, root), /64000/);
  assert.deepEqual(environment, {});
});

test('empty primary key allows the supported Kimi key alias', t => {
  const settings = loadSettings(join(fixture(t), 'not-created'), { provider: 'kimi' });
  assert.ok(createProvider(settings, { MOONSHOT_API_KEY: '', KIMI_API_KEY: 'mock-alias-key' }) instanceof KimiProvider);
});

test('CLI doctor auto-loads .env and prints readiness without revealing the key', async t => {
  const root = fixture(t), sentinel = 'env-doctor-sentinel';
  writeFileSync(join(root, '.env'), `MOONSHOT_API_KEY=${sentinel}\n`);
  const result = await invoke(root, ['doctor', '--provider', 'kimi']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).apiKeyConfigured, true);
  assert.ok(!result.stdout.includes(sentinel) && !result.stderr.includes(sentinel));
});

test('CLI --env-path selects a custom file and shell priority remains authoritative', async t => {
  const root = fixture(t);
  writeFileSync(join(root, '.env'), 'MOONSHOT_API_KEY=default-file-key\n');
  writeFileSync(join(root, '.env.local'), 'MOONSHOT_API_KEY=custom-file-key\n');
  const loaded = await invoke(root, ['doctor', '--provider', 'kimi', '--env-path', '.env.local']);
  assert.equal(loaded.code, 0, loaded.stderr); assert.equal(JSON.parse(loaded.stdout).apiKeyConfigured, true);
  const overridden = await invoke(root, ['doctor', '--provider', 'kimi', '--env-path', '.env.local'], { MOONSHOT_API_KEY: '', KIMI_API_KEY: '' });
  assert.equal(overridden.code, 0, overridden.stderr); assert.equal(JSON.parse(overridden.stdout).apiKeyConfigured, false);
  const missing = await invoke(root, ['doctor', '--env-path', 'missing.env']);
  assert.equal(missing.code, 1); assert.match(missing.stderr, /Environment file not found/);
});

test('CLI reads a file key and Kimi profile, executes a tool loop, and keeps credentials out of output', async t => {
  const root = fixture(t), key = 'local-cli-key-sentinel', reasoning = 'private-provider-metadata';
  const requests: { authorization?: string; body: Record<string, unknown> }[] = [];
  const server: Server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({ authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ choices: [requests.length === 1 ? {
        finish_reason: 'tool_calls', message: { role: 'assistant', content: null, reasoning_content: reasoning,
          tool_calls: [{ id: 'from-config', type: 'function', function: { name: 'calculator', arguments: '{"expression":"(2+3)*4"}' } }],
        },
      } : { finish_reason: 'stop', message: { role: 'assistant', content: '20' } }] }));
    })().catch(() => { response.statusCode = 500; response.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    mkdirSync(join(root, 'profile'));
    writeFileSync(join(root, 'profile', 'config.json'), JSON.stringify({
      provider: 'kimi', providerMode: 'learner', mode: 'reference',
      baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'kimi-k3.1-pro', providerTimeoutMs: 2000,
    }));
    writeFileSync(join(root, '.env'), `MOONSHOT_API_KEY=${key}\n`);
    const result = await invoke(root, ['chat', '--message', 'calculate', '--trace']);
    assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout.trim(), '20');
    assert.equal(requests.length, 2);
    assert.ok(requests.every(item => item.authorization === `Bearer ${key}`));
    assert.equal(requests[0].body.model, 'kimi-k3.1-pro');
    const history = requests[1].body.messages as Record<string, unknown>[];
    assert.equal(history.at(-2)?.reasoning_content, reasoning);
    assert.equal(history.at(-1)?.tool_call_id, 'from-config');
    assert.ok(!result.stdout.includes(key) && !result.stderr.includes(key));
    assert.ok(!result.stdout.includes(reasoning) && !result.stderr.includes(reasoning));
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
