/** 测试 Kimi 练习实现的选择、安全默认值，以及思考元数据保留协议。 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { loadSettings } from '../src/config.js';
import { createProvider } from '../src/core/provider-factory.js';
import { KimiProvider } from '../src/core/providers/kimi.js';
import { ReferenceKimiProvider } from '../src/core/providers/kimi-reference.js';
import { KIMI_DEFAULT_BASE_URL, KIMI_DEFAULT_MODEL } from '../src/core/providers/kimi-shared.js';
import { ExerciseNotImplemented } from '../src/core/errors.js';
import { fromWireMessage, messageSize, toWireMessage, validateModelResponse, type Message } from '../src/core/models.js';
import { runLoop } from '../src/learning/reference.js';
import { ToolRegistry } from '../src/core/tools.js';
import { providerCases } from '../src/stages/provider.js';
import { runStageCases } from '../src/stages/runner.js';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'hermes-kimi-tests-'));
const noProfile = join(fixtureRoot, 'uncreated-profile');
after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

test('Kimi provider is a separate exercise, with reference Core not silently solving L0', async () => {
  const settings = loadSettings(noProfile, { provider: 'kimi', mode: 'reference' });
  assert.equal(settings.providerMode, 'learner');
  const provider = createProvider(settings, { MOONSHOT_API_KEY: 'mock-key' });
  assert.ok(provider instanceof KimiProvider);
  await assert.rejects(provider.complete([{ role: 'user', content: 'hello' }], []), ExerciseNotImplemented);
  const answer = createProvider({ ...settings, mode: 'learner', providerMode: 'reference' }, { KIMI_API_KEY: 'mock-key' });
  assert.ok(answer instanceof ReferenceKimiProvider);
});

test('Kimi credentials are explicit and generic OpenAI keys are not silently reused', () => {
  const settings = loadSettings(noProfile, { provider: 'kimi' });
  assert.throws(() => createProvider(settings, { OPENAI_API_KEY: 'wrong-provider' }), /MOONSHOT_API_KEY/);
  assert.throws(() => createProvider(settings, { MOONSHOT_API_KEY: 'bad\nkey' }), /API key/);
  assert.throws(() => loadSettings(noProfile, { providerMode: 'invalid' as 'learner' }), /providerMode/);
});

test('switching an initialized local profile to Kimi selects API/model presets without overwriting config', () => {
  const root = mkdtempSync(join(tmpdir(), 'hermes-kimi-settings-'));
  try {
    const path = join(root, 'config.json');
    const original = JSON.stringify({ provider: 'demo', model: 'local-model', baseUrl: 'http://127.0.0.1:11434/v1' });
    writeFileSync(path, original);
    const settings = loadSettings(root, { provider: 'kimi' });
    assert.equal(settings.model, KIMI_DEFAULT_MODEL);
    assert.equal(settings.baseUrl, KIMI_DEFAULT_BASE_URL);
    const explicit = loadSettings(root, { provider: 'kimi', model: 'custom-model', baseUrl: 'http://127.0.0.1:9999/v1' });
    assert.equal(explicit.model, 'custom-model'); assert.equal(explicit.baseUrl, 'http://127.0.0.1:9999/v1');
    assert.equal(readFileSync(path, 'utf8'), original);
    writeFileSync(path, JSON.stringify({ provider: 'kimi' }));
    assert.equal(loadSettings(root).model, KIMI_DEFAULT_MODEL);
    assert.equal(loadSettings(root).baseUrl, KIMI_DEFAULT_BASE_URL);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('thinking metadata round-trips wire messages and contributes to context budgets', () => {
  const message: Message = { role: 'assistant', content: '', reasoningContent: 'provider metadata sentinel', toolCalls: [
    { id: 'call-1', name: 'calculator', arguments: { expression: '2+2' } },
  ] };
  assert.equal(toWireMessage(message).reasoning_content, message.reasoningContent);
  assert.deepEqual(fromWireMessage(toWireMessage(message)), message);
  assert.ok(messageSize(message) > messageSize({ ...message, reasoningContent: '' }));
  assert.throws(() => fromWireMessage({ role: 'assistant', content: 'final', reasoning_content: 42 }), /reasoning/);
  assert.throws(() => validateModelResponse({ content: 'final', reasoningContent: 'x'.repeat(32_001) }), /32000/);
});

test('Core carries returned provider metadata into the next tool request without displaying it as final text', async () => {
  const observed: Message[][] = [];
  const registry = new ToolRegistry();
  registry.register({ name: 'calculator', description: 'Example', parameters: { type: 'object' }, handler: () => 4 });
  const delta = await runLoop({ async complete(messages) {
    observed.push(structuredClone(messages));
    return observed.length === 1 ? { content: '', reasoningContent: 'metadata-not-final-text', toolCalls: [
      { id: 'calc', name: 'calculator', arguments: {} },
    ] } : { content: '4', reasoningContent: 'final metadata' };
  } }, registry, [{ role: 'user', content: 'calculate' }], 3, () => {});
  assert.equal(observed[1][1].reasoningContent, 'metadata-not-final-text');
  assert.equal(delta.at(-1)?.content, '4');
  assert.equal(delta.at(-1)?.reasoningContent, 'final metadata');
});

test('stage 0 reference validates Kimi against local HTTP without live credentials', async () => {
  const result = await runStageCases(0, 'reference', providerCases('reference'));
  assert.equal(result.status, 'passed', JSON.stringify(result.cases));
  assert.ok(result.total >= 10);
});

test('stage 0 learner leaves implementation contracts unimplemented rather than falling back', async () => {
  const result = await runStageCases(0, 'learner', providerCases('learner'));
  assert.equal(result.status, 'failed');
  assert.ok(result.cases.some(item => item.error?.name === 'ExerciseNotImplemented'));
  assert.ok(result.cases.filter(item => item.status === 'failed').every(item => item.error?.message.includes('L0')));
});

test('the learner Core stage catches discarded reasoning even when ordinary tools still work', async () => {
  const { checkStage } = await import('../src/lab.js');
  const { loadAlgorithms } = await import('../src/learning/index.js');
  const reference = loadAlgorithms('reference');
  const result = await checkStage(1, 'learner', {}, {
    ...reference,
    async runLoop(...args) {
      // 同时从后续模型请求和返回的待持久化消息中移除思考元数据。
      const [provider, registry, messages, maxSteps, emit, signal] = args;
      const withoutMetadata = (entries: Message[]) => entries.map(({ reasoningContent: _ignored, ...message }) => message);
      const delta = await reference.runLoop({ complete: (context, tools, parent) =>
        provider.complete(withoutMetadata(context), tools, parent),
      }, registry, messages, maxSteps, emit, signal);
      return withoutMetadata(delta);
    },
  });
  assert.equal(result.status, 'failed');
  assert.ok(result.cases.some(item => item.name === 'L1/preserve-provider-reasoning' && item.status === 'failed'));
  assert.ok(result.passed > 0);
});
