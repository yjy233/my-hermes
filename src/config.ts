import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { isRecord } from './core/models.js';
import type { Mode } from './learning/types.js';
import { KIMI_DEFAULT_BASE_URL, KIMI_DEFAULT_MODEL } from './core/providers/kimi-shared.js';

export interface Settings {
  home: string; mode: Mode; providerMode: Mode; provider: 'demo' | 'compatible' | 'kimi'; model: string; baseUrl: string;
  maxSteps: number; contextChars: number; turnTimeoutMs: number; autoReflect: boolean; plugins: string[];
}
export type SettingsOverrides = Partial<Omit<Settings, 'home'>>;
const DEFAULTS: Omit<Settings, 'home'> = {
  mode: 'reference', providerMode: 'learner', provider: 'demo', model: 'local-model', baseUrl: 'http://127.0.0.1:11434/v1',
  maxSteps: 8, contextChars: 24_000, turnTimeoutMs: 120_000, autoReflect: false, plugins: [],
};
export function loadSettings(home?: string, overrides: SettingsOverrides = {}): Settings {
  const root = resolve(home ?? process.env.MY_HERMES_HOME ?? '.hermes-lab');
  const path = resolve(root, 'config.json');
  const raw: unknown = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  if (!isRecord(raw)) throw new Error('config.json must contain an object');
  for (const key of Object.keys(raw)) if (!Object.hasOwn(DEFAULTS, key)) throw new Error(`Unknown config key: ${key}`);
  const explicit = Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined));
  const source = { ...raw };
  // 切换 Provider 时选用对应默认值，避免意外把 Kimi 请求发往本地模型 URL。
  if (explicit.provider !== undefined && explicit.provider !== (source.provider ?? DEFAULTS.provider)) {
    delete source.model; delete source.baseUrl;
  }
  const selected = explicit.provider ?? source.provider ?? DEFAULTS.provider;
  const preset = selected === 'kimi' ? { model: KIMI_DEFAULT_MODEL, baseUrl: KIMI_DEFAULT_BASE_URL } : {};
  const data: Record<string, unknown> = { ...DEFAULTS, ...preset, ...source, ...explicit };
  for (const name of ['mode', 'providerMode', 'provider', 'model', 'baseUrl']) {
    if (typeof data[name] !== 'string' || !(data[name] as string).trim()) throw new Error(`${name} must be nonempty text`);
  }
  if (!['reference', 'learner'].includes(data.mode as string)) throw new Error('mode must be reference or learner');
  if (!['reference', 'learner'].includes(data.providerMode as string)) throw new Error('providerMode must be reference or learner');
  if (!['demo', 'compatible', 'kimi'].includes(data.provider as string)) throw new Error('provider must be demo, compatible or kimi');
  if (!Number.isSafeInteger(data.maxSteps) || (data.maxSteps as number) < 1) throw new Error('maxSteps must be a positive integer');
  if (!Number.isSafeInteger(data.contextChars) || (data.contextChars as number) < 1000) throw new Error('contextChars must be an integer >=1000');
  if (typeof data.turnTimeoutMs !== 'number' || !Number.isFinite(data.turnTimeoutMs) ||
      data.turnTimeoutMs <= 0 || data.turnTimeoutMs > 2_147_483_647) throw new Error('turnTimeoutMs must be positive and finite (<=2147483647)');
  if (typeof data.autoReflect !== 'boolean') throw new Error('autoReflect must be boolean');
  if (!Array.isArray(data.plugins) || data.plugins.some(path => typeof path !== 'string' || !path.trim())) throw new Error('plugins must be explicit trusted file paths');
  return { ...data, home: root, plugins: data.plugins.map((path: string) => isAbsolute(path) ? path : resolve(root, path)) } as Settings;
}
export function initializeProfile(settings: Settings): void {
  mkdirSync(settings.home, { recursive: true });
  for (const name of ['memory', 'skills', 'proposals']) mkdirSync(resolve(settings.home, name), { recursive: true });
  const path = resolve(settings.home, 'config.json');
  if (!existsSync(path)) writeFileSync(path, JSON.stringify(DEFAULTS, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
