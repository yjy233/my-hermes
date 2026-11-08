import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
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

test('旧配置补齐高级压缩默认值，初始化不覆盖用户已有配置', t => {
  const home = fixture(t), source = '{"mode":"reference","provider":"demo"}';
  writeFileSync(join(home, 'config.json'), source);
  const settings = loadSettings(home);
  assert.equal(settings.compressionEnabled, true);
  assert.equal(settings.compressionThreshold, 0.5);
  assert.equal(settings.compressionTargetRatio, 0.25);
  assert.equal(settings.compressionSummaryChars, 6000);
  assert.equal(settings.compressionTailMessages, 20);
  assert.equal(settings.compressionToolChars, 1200);
  assert.equal(settings.compressionTimeoutMs, 30_000);
  assert.equal(settings.compressionMemoryFlush, true);
  assert.deepEqual(settings.compression, { enabled: true, threshold: 0.5, protectFirst: 3, protectLast: 20,
    summaryChars: 6000, timeoutMs: 30_000, abortOnFailure: false, summaryModel: '' });
  initializeProfile(settings);
  assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), source);
});

test('高级压缩配置拒绝非法类型、无效预算和不低于触发线的目标比例', t => {
  const home = fixture(t);
  const invalid: Record<string, unknown[]> = {
    compressionEnabled: [0, 'true', null],
    compressionMemoryFlush: [1, 'false', null],
    compressionThreshold: [0, -1, 0.09, 0.96, 1, 1.01, NaN, Infinity, '0.75'],
    compressionTargetRatio: [0, -1, 0.75, 1, NaN, Infinity, '0.5'],
    compressionSummaryChars: [0, 255, 16_001, 256.5, NaN, Infinity],
    compressionTailMessages: [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1],
    compressionToolChars: [79, -1, 80.5, Infinity, Number.MAX_SAFE_INTEGER + 1],
    compressionTimeoutMs: [0, -1, NaN, Infinity, 2 ** 32, '20000'],
  };
  for (const [name, values] of Object.entries(invalid)) {
    for (const value of values) {
      assert.throws(() => loadSettings(home, { [name]: value } as SettingsOverrides),
        new RegExp(name), `${name} 不应接受 ${String(value)}`);
    }
  }
  assert.throws(() => loadSettings(home, { compressionThreshold: 0.4, compressionTargetRatio: 0.4 }),
    /compressionTargetRatio/);
});

test('高级压缩接受有效边界，显式关闭仍保留其余配置', t => {
  const settings = loadSettings(fixture(t), {
    compressionEnabled: false, compressionMemoryFlush: false,
    compressionThreshold: 0.95, compressionTargetRatio: 0.94,
    compressionSummaryChars: 256, compressionTailMessages: 1,
    compressionToolChars: 80, compressionTimeoutMs: 2_147_483_647,
  });
  assert.equal(settings.compressionEnabled, false);
  assert.equal(settings.compressionMemoryFlush, false);
  assert.equal(settings.compressionThreshold, 0.95);
  assert.equal(settings.compressionSummaryChars, 256);
  assert.equal(settings.compressionToolChars, 80);
  assert.equal(settings.compressionTailMessages, 1);
  assert.equal(settings.compressionTimeoutMs, 2_147_483_647);
  assert.equal(loadSettings(fixture(t), { compressionSummaryChars: 16_000 }).compressionSummaryChars, 16_000);
});

test('高级压缩示例可直接通过配置校验且不包含密钥', t => {
  const source = readFileSync(new URL('../examples/config/context.json', import.meta.url), 'utf8');
  const home = fixture(t);
  writeFileSync(join(home, 'config.json'), source);
  const settings = loadSettings(home);
  assert.equal(settings.compressionEnabled, true);
  assert.equal(settings.contextChars, 48_000);
  assert.equal(settings.provider, 'demo');
  assert.equal(/api.?key|secret|token/iu.test(source), false);
});

test('旧扁平配置映射到规范配置，同层嵌套字段优先，进程覆盖最高', t => {
  const home = fixture(t);
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    compressionEnabled: false, compressionThreshold: 0.75, compressionSummaryChars: 1800,
    compressionTailMessages: 8, compressionTimeoutMs: 1234, compressionMemoryFlush: false,
    compression: { enabled: true, threshold: 0.6, protectFirst: 2, summaryModel: 'summary-model' },
  }));
  const settings = loadSettings(home);
  assert.deepEqual(settings.compression, { enabled: true, threshold: 0.6, protectFirst: 2, protectLast: 8,
    summaryChars: 1800, timeoutMs: 1234, abortOnFailure: false, summaryModel: 'summary-model' });
  assert.equal(settings.compressionEnabled, true);
  assert.equal(settings.compressionThreshold, 0.6);
  assert.equal(settings.compressionMemoryFlush, false);
  const overridden = loadSettings(home, { compression: { enabled: false, protectLast: 4 } });
  assert.equal(overridden.compression.enabled, false);
  assert.equal(overridden.compression.protectLast, 4);
  assert.equal(overridden.compression.summaryModel, 'summary-model');
  assert.equal(overridden.compression.summaryChars, 1800);
});

test('嵌套压缩设置严格拒绝未知键及无效值，旧格式也不能以新字段遮盖坏值', t => {
  const home = fixture(t);
  for (const compression of [null, [], { unknown: true }, { threshold: 1 }, { protectLast: 0 },
    { abortOnFailure: 'false' }, { summaryModel: null }]) {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ compression }));
    assert.throws(() => loadSettings(home));
  }
  writeFileSync(join(home, 'config.json'), JSON.stringify({ compressionThreshold: 1, compression: { threshold: 0.5 } }));
  assert.throws(() => loadSettings(home), /compressionThreshold/);
});

test('CLI 压缩模式覆盖仅影响当前进程，doctor 可检查配置且不调用模型', t => {
  const root = fixture(t), home = join(root, 'profile');
  const environment: NodeJS.ProcessEnv = { ...process.env, MY_HERMES_HOME: home };
  // 在临时工作目录运行，不加载仓库里的实际 .env，也不继承真实凭证。
  for (const name of ['MOONSHOT_API_KEY', 'KIMI_API_KEY', 'MY_HERMES_API_KEY', 'OPENAI_API_KEY']) {
    delete environment[name];
  }
  const invoke = (mode: string) => spawnSync(process.execPath, [
    '--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
    'doctor', '--compression', mode,
  ], { cwd: root, env: environment, encoding: 'utf8', timeout: 15_000 });
  const basic = invoke('basic');
  assert.equal(basic.status, 0, basic.stderr);
  assert.equal(JSON.parse(basic.stdout).compression.enabled, false);
  const saved = readFileSync(join(home, 'config.json'), 'utf8');
  assert.equal(JSON.parse(saved).compression.enabled, true, '本次覆盖不改变初始化默认值');
  assert.equal(Object.hasOwn(JSON.parse(saved), 'compressionEnabled'), false, '新文件只写规范配置');
  const advanced = invoke('advanced');
  assert.equal(advanced.status, 0, advanced.stderr);
  assert.equal(JSON.parse(advanced.stdout).compression.enabled, true);
  assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), saved);
  const invalid = invoke('unknown');
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /compression must be basic or advanced/);
});
