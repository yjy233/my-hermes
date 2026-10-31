#!/usr/bin/env node
/** 源码入口和编译后的 CLI 使用同一条执行路径。 */
import { appendFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { loadSettings, initializeProfile, type Settings } from './config.js';
import { Agent } from './core/agent.js';
import { createProvider } from './core/provider-factory.js';
import type { Emit } from './core/models.js';
import { EvolutionManager } from './evolution/index.js';
import { Gateway } from './gateway/index.js';
import { builtinSkills, checkStage, STAGES } from './lab.js';
import { loadAlgorithms, type Mode } from './learning/index.js';
import { LongTermMemory, SessionStore } from './memory/index.js';
import { ProfileLock } from './profile-lock.js';
import { SkillCatalog } from './skills/index.js';
import { loadEnvironmentFile } from './environment.js';

function parse(argv: string[]) {
  return parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    home: { type: 'string' }, mode: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' },
    'provider-mode': { type: 'string' },
    'env-path': { type: 'string' },
    'base-url': { type: 'string' }, plugin: { type: 'string', multiple: true },
    'auto-reflect': { type: 'boolean' }, 'no-auto-reflect': { type: 'boolean' },
    trace: { type: 'boolean' }, debug: { type: 'boolean' },
    message: { type: 'string', short: 'm' }, session: { type: 'string' }, user: { type: 'string' },
    connector: { type: 'string' }, 'allow-user': { type: 'string', multiple: true },
    host: { type: 'string' }, port: { type: 'string' }, stage: { type: 'string' }, all: { type: 'boolean' },
    name: { type: 'string' }, description: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean' },
  } });
}
type Parsed = ReturnType<typeof parse>;
const HELP = `my-hermes · TypeScript Agent learning lab (Node.js 24+)
Commands:
  init | doctor | sessions | history SESSION_ID
  chat [--message TEXT] [--session NAME] [--user ID]
  check | demo [--stage 0..5 | --all] [--mode reference|learner]
  gateway --connector jsonl|http [--allow-user ID] [--host 127.0.0.1] [--port 8765]
  skills list | skills read NAME
  evolve list | evolve show ID | evolve approve ID --name NAME --description TEXT
Common: --home PATH --mode MODE --provider demo|compatible|kimi --provider-mode learner|reference
        --model NAME --base-url URL --env-path PATH
        --plugin PATH (repeatable) --auto-reflect --no-auto-reflect --trace --debug
Examples: npm run dev -- chat --message '/calc (2+3)*4' --trace
          npm run check -- --all --mode reference`;

function settingsFor(values: Parsed['values']): Settings {
  if (values['auto-reflect'] && values['no-auto-reflect']) throw new Error('Choose one auto-reflect flag');
  const settings = loadSettings(values.home, {
    mode: values.mode as Mode | undefined, provider: values.provider as Settings['provider'] | undefined,
    providerMode: values['provider-mode'] as Mode | undefined,
    model: values.model, baseUrl: values['base-url'],
    autoReflect: values['auto-reflect'] ? true : values['no-auto-reflect'] ? false : undefined,
  });
  settings.plugins.push(...(values.plugin ?? []).map(path => resolve(path)));
  return settings;
}
function catalogFor(settings: Settings): SkillCatalog {
  const catalog = new SkillCatalog([builtinSkills(), resolve(settings.home, 'skills')]);
  catalog.discover(); return catalog;
}
function traceWriter(home: string): Emit {
  return (event, payload) => {
    const line = JSON.stringify({ time: new Date().toISOString(), event, ...payload });
    appendFileSync(resolve(home, 'traces.jsonl'), line + '\n', { mode: 0o600 });
    console.error(line);
  };
}
function print(value: unknown): void { console.log(JSON.stringify(value, null, 2)); }
function requirePosition(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required`); return value;
}

async function chat(gateway: Gateway, values: Parsed['values'], signal: AbortSignal): Promise<void> {
  let conversation = values.session ?? 'default';
  const send = async (text: string) => {
    const reply = await gateway.handle({ eventId: randomUUID(), channel: 'cli', conversationId: conversation,
      userId: values.user ?? 'local', text }, signal);
    console.log(reply.text);
  };
  if (values.message !== undefined) { await send(values.message); return; }
  console.log('my-hermes · /new 新会话 · /quit 退出 · /calc (2+3)*4 运行工具');
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  readline.on('close', () => { closed = true; });
  try {
    while (!closed) {
      const text = (await readline.question('you> ', { signal })).trim();
      if (text === '/quit' || text === '/exit') break;
      if (text === '/new') { conversation = randomUUID(); console.log('已创建新会话；下一条消息读取最新记忆与 Skill 索引。'); }
      else if (text) {
        try { await send(text); }
        catch (error) {
          if (signal.aborted || values.debug) throw error;
          console.error(error instanceof Error ? `${error.name}: ${error.message}` : 'Request failed');
        }
      }
    }
  } catch (error) {
    if (!closed || signal.aborted) throw error;
  } finally { readline.close(); }
}

async function execute(parsed: Parsed, signal: AbortSignal): Promise<void> {
  const { values, positionals } = parsed;
  if (values.version) { console.log('0.2.0'); return; }
  if (values.help || !positionals.length) { console.log(HELP); return; }
  const [command, action, id] = positionals;
  if (!['init', 'doctor', 'chat', 'gateway', 'check', 'demo', 'sessions', 'history', 'skills', 'evolve'].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }
  const settings = settingsFor(values);
  if (command === 'check' || command === 'demo') {
    if (values.stage && values.all) throw new Error('Use --stage or --all, not both');
    const stage = Number(values.stage ?? 1);
    if (!Number.isInteger(stage) || !STAGES[stage]) throw new Error('Stage must be 0..5');
    let failedStages = 0;
    let failedCases = 0;
    const targets = values.all ? Object.keys(STAGES).map(Number) : [stage];
    for (const target of targets) {
      signal.throwIfAborted();
      const result = await checkStage(target, settings.mode, {
        signal, debug: values.debug,
        emit: values.trace ? (event, payload) => console.error(JSON.stringify({ event, ...payload })) : undefined,
      });
      // 每个阶段向 stdout 写一条 JSON 记录，便于脚本和进度 UI 使用。
      console.log(JSON.stringify({ title: STAGES[target], ...result, cases: result.cases.map(item => ({
        name: item.name, status: item.status,
        ...(item.error ? { error: { name: item.error.name, message: item.error.message } } : {}),
      })) }));
      if (result.status === 'failed') {
        failedStages++;
        failedCases += result.failed;
        for (const item of result.cases.filter(item => item.status === 'failed')) {
          console.error(`[stage ${target}] ${item.name}: ${item.error!.name}: ${item.error!.message}`);
          if (values.debug && item.error?.stack) console.error(item.error.stack);
        }
      }
    }
    if (failedStages) throw new Error(`Acceptance failed: ${failedStages}/${targets.length} stages, ${failedCases} cases`);
    return;
  }
  if (command === 'skills' || command === 'evolve') {
    initializeProfile(settings);
    if (command === 'skills') {
      const catalog = catalogFor(settings);
      if (action === 'list') console.log(catalog.index());
      else if (action === 'read') console.log(catalog.read(requirePosition(id, 'Skill name')));
      else throw new Error('Use skills list or skills read NAME');
    } else {
      const evolution = new EvolutionManager(resolve(settings.home, 'proposals'), resolve(settings.home, 'skills'));
      if (action === 'approve') {
        const name = requirePosition(values.name, '--name'), description = requirePosition(values.description, '--description');
        if (catalogFor(settings).skills.has(name)) throw new Error(`Skill already exists: ${name}`);
        console.log(evolution.approve(requirePosition(id, 'Proposal ID'), name, description));
      } else if (action === 'list') print(evolution.listProposals());
      else if (action === 'show') {
        const proposal = evolution.listProposals().find(item => item.id === requirePosition(id, 'Proposal ID'));
        if (!proposal) throw new Error('Unknown proposal ID'); print(proposal);
      } else throw new Error('Use evolve list, show ID, or approve ID --name NAME --description TEXT');
    }
    return;
  }
  const lock = command === 'chat' || command === 'gateway' ? new ProfileLock(settings.home).acquire() : undefined;
  let store: SessionStore | undefined, gateway: Gateway | undefined;
  try {
    initializeProfile(settings);
    store = new SessionStore(resolve(settings.home, 'sessions.db'));
    if (command === 'init') { console.log(`Profile ready: ${settings.home}`); return; }
    if (command === 'doctor') {
      print({ node: process.versions.node, home: settings.home, mode: settings.mode, provider: settings.provider,
        providerMode: settings.providerMode,
        apiKeyConfigured: settings.provider === 'kimi'
          ? Boolean(process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY)
          : Boolean(process.env.MY_HERMES_API_KEY || process.env.OPENAI_API_KEY),
        skills: catalogFor(settings).skills.size, plugins: settings.plugins.map(path => ({ path, exists: existsSync(path) })) }); return;
    }
    if (command === 'sessions') { print(store.listSessions()); return; }
    if (command === 'history') {
      const sessionId = requirePosition(action, 'Session ID');
      if (!store.listSessions().some(session => session.id === sessionId)) throw new Error('Unknown session ID; run sessions first');
      print(store.loadMessages(sessionId)); return;
    }
    const provider = createProvider(settings);
    const agent = new Agent({ provider, store, memory: new LongTermMemory(resolve(settings.home, 'memory')),
      skills: catalogFor(settings), mode: settings.mode, maxSteps: settings.maxSteps, contextChars: settings.contextChars,
      turnTimeoutMs: settings.turnTimeoutMs, plugins: settings.plugins, autoReflect: settings.autoReflect,
      evolution: new EvolutionManager(resolve(settings.home, 'proposals'), resolve(settings.home, 'skills')),
      emit: values.trace ? traceWriter(settings.home) : undefined });
    gateway = new Gateway(agent, store, loadAlgorithms(settings.mode).sessionKey,
      values['allow-user'] ? new Set(values['allow-user']) : undefined);
    if (command === 'chat') { await chat(gateway, values, signal); return; }
    const connector = values.connector ?? 'jsonl';
    if (connector === 'jsonl') {
      const { runJsonl } = await import('./connectors/jsonl.js');
      const stop = () => { process.stdin.destroy(); };
      signal.addEventListener('abort', stop, { once: true });
      try { await runJsonl(gateway, process.stdin, process.stdout); signal.throwIfAborted(); }
      finally { signal.removeEventListener('abort', stop); }
    } else if (connector === 'http') {
      const { createHttpServer } = await import('./connectors/http.js');
      const host = values.host ?? '127.0.0.1', port = Number(values.port ?? 8765);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
      const server = createHttpServer(gateway, { host, token: process.env.MY_HERMES_GATEWAY_TOKEN ?? '' });
      await new Promise<void>((ready, reject) => {
        server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); ready(); });
      });
      const address = server.address();
      console.error(`HTTP connector: http://${host}:${typeof address === 'object' && address ? address.port : port}`);
      await new Promise<void>((done, reject) => {
        const stop = () => { server.close(error => error ? reject(error) : done()); server.closeAllConnections(); };
        server.once('error', reject);
        signal.addEventListener('abort', stop, { once: true });
        server.once('close', () => signal.removeEventListener('abort', stop));
        if (signal.aborted) stop();
      });
    } else throw new Error('connector must be jsonl or http');
  } finally { gateway?.close(); store?.close(); lock?.release(); }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let parsed: Parsed | undefined;
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Interrupted'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    parsed = parse(argv);
    loadEnvironmentFile(parsed.values['env-path']);
    await execute(parsed, controller.signal);
    return controller.signal.aborted ? 130 : 0;
  }
  catch (error) {
    if (controller.signal.aborted) return 130;
    console.error(parsed?.values.debug && error instanceof Error ? error.stack : error instanceof Error ? `${error.name}: ${error.message}` : 'Command failed');
    return 1;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
if (process.argv[1] && existsSync(process.argv[1]) &&
    import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  process.exitCode = await main();
}
