import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { isRecord } from './core/models.js';
import type { Mode } from './learning/types.js';
import { KIMI_DEFAULT_BASE_URL, KIMI_DEFAULT_MODEL } from './core/providers/kimi-shared.js';
import { compressionSettings, DEFAULT_COMPRESSION, type CompressionSettings } from './core/compression/settings.js';

export interface Settings {
  home: string; mode: Mode; providerMode: Mode; provider: 'demo' | 'compatible' | 'kimi'; model: string; baseUrl: string;
  maxSteps: number; contextChars: number; turnTimeoutMs: number; providerTimeoutMs: number; autoReflect: boolean; plugins: string[];
  /** 主运行链路使用 Hermes 式嵌套配置；扁平字段仅作为旧配置兼容别名。 */
  compression: CompressionSettings;
  compressionEnabled: boolean; compressionThreshold: number; compressionTargetRatio: number;
  compressionSummaryChars: number; compressionTailMessages: number; compressionToolChars: number;
  compressionTimeoutMs: number; compressionMemoryFlush: boolean;
}
export type SettingsOverrides = Partial<Omit<Settings, 'home' | 'compression'>> & { compression?: Partial<CompressionSettings> };
type LegacyCompressionKey = 'compressionEnabled' | 'compressionThreshold' | 'compressionTargetRatio'
  | 'compressionSummaryChars' | 'compressionTailMessages' | 'compressionToolChars' | 'compressionTimeoutMs';
const LEGACY_DEFAULTS = {
  compressionEnabled: DEFAULT_COMPRESSION.enabled, compressionThreshold: DEFAULT_COMPRESSION.threshold,
  compressionTargetRatio: 0.25, compressionSummaryChars: DEFAULT_COMPRESSION.summaryChars,
  compressionTailMessages: DEFAULT_COMPRESSION.protectLast, compressionToolChars: 1200,
  compressionTimeoutMs: DEFAULT_COMPRESSION.timeoutMs,
};
// 新初始化的文件只写一份规范配置，不同时写入两套可以互相覆盖的压缩参数。
const DEFAULTS: Omit<Settings, 'home' | LegacyCompressionKey> = {
  mode: 'reference', providerMode: 'learner', provider: 'demo', model: 'local-model', baseUrl: 'http://127.0.0.1:11434/v1',
  maxSteps: 8, contextChars: 24_000, turnTimeoutMs: 120_000, providerTimeoutMs: 30_000, autoReflect: false, plugins: [],
  compression: DEFAULT_COMPRESSION, compressionMemoryFlush: true,
};

/**
 * 每一层先把旧字段翻译为规范字段，再由同层显式的 compression 字段覆盖。
 * 文件层处理完后再应用 CLI 层，因此 CLI 的 enabled 覆盖不会抹掉文件里的其他设置。
 */
function compressionLayer(source: Record<string, unknown>): Partial<CompressionSettings> {
  const mapped: Partial<CompressionSettings> = {};
  const shared = {
    compressionEnabled: 'enabled', compressionThreshold: 'threshold', compressionSummaryChars: 'summaryChars',
    compressionTailMessages: 'protectLast', compressionTimeoutMs: 'timeoutMs',
  } as const;
  for (const [oldKey, nextKey] of Object.entries(shared)) {
    if (Object.hasOwn(source, oldKey)) Object.assign(mapped, { [nextKey]: source[oldKey] });
  }
  if (source.compression === undefined) return mapped;
  // 单独验证嵌套对象，拒绝数组、null 和未知键；其默认值不参与这一层的覆盖。
  compressionSettings(source.compression);
  return { ...mapped, ...source.compression as Partial<CompressionSettings> };
}

/** 兼容字段同样严格校验，不能因为被新版字段覆盖就悄悄接受坏配置。 */
function validateLegacy(source: Record<string, unknown>): void {
  for (const name of ['compressionEnabled', 'compressionMemoryFlush']) {
    if (Object.hasOwn(source, name) && typeof source[name] !== 'boolean') throw new Error(`${name} must be boolean`);
  }
  if (Object.hasOwn(source, 'compressionThreshold') && (typeof source.compressionThreshold !== 'number'
      || !Number.isFinite(source.compressionThreshold) || source.compressionThreshold < 0.1 || source.compressionThreshold > 0.95)) {
    throw new Error('compressionThreshold must be finite and in [0.1, 0.95]');
  }
  if (Object.hasOwn(source, 'compressionTargetRatio') && (typeof source.compressionTargetRatio !== 'number'
      || !Number.isFinite(source.compressionTargetRatio) || source.compressionTargetRatio <= 0 || source.compressionTargetRatio >= 1)) {
    throw new Error('compressionTargetRatio must be finite and in (0, 1)');
  }
  for (const [name, minimum, maximum] of [
    ['compressionSummaryChars', 256, 16_000], ['compressionTailMessages', 1, Number.MAX_SAFE_INTEGER],
    ['compressionToolChars', 80, Number.MAX_SAFE_INTEGER], ['compressionTimeoutMs', 1, 2_147_483_647],
  ] as const) {
    if (Object.hasOwn(source, name) && (!Number.isSafeInteger(source[name])
        || (source[name] as number) < minimum || (source[name] as number) > maximum)) {
      throw new Error(`${name} must be a safe integer in [${minimum}, ${maximum}]`);
    }
  }
}

export function loadSettings(home?: string, overrides: SettingsOverrides = {}): Settings {
  const root = resolve(home ?? process.env.MY_HERMES_HOME ?? '.hermes-lab');
  const path = resolve(root, 'config.json');
  const raw: unknown = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  if (!isRecord(raw)) throw new Error('config.json must contain an object');
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(DEFAULTS, key) && !Object.hasOwn(LEGACY_DEFAULTS, key)) throw new Error(`Unknown config key: ${key}`);
  }
  const explicit = Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined));
  const source = { ...raw };
  validateLegacy(source); validateLegacy(explicit);
  // 切换 Provider 时选用对应默认值，避免意外把 Kimi 请求发往本地模型 URL。
  if (explicit.provider !== undefined && explicit.provider !== (source.provider ?? DEFAULTS.provider)) {
    delete source.model; delete source.baseUrl;
  }
  const selected = explicit.provider ?? source.provider ?? DEFAULTS.provider;
  const preset = selected === 'kimi' ? { model: KIMI_DEFAULT_MODEL, baseUrl: KIMI_DEFAULT_BASE_URL } : {};
  const data: Record<string, unknown> = { ...DEFAULTS, ...LEGACY_DEFAULTS, ...preset, ...source, ...explicit };
  const compression = compressionSettings({ ...compressionLayer(source), ...compressionLayer(explicit) });
  data.compression = compression;
  // 兼容调用者读取旧属性时看到的值必须与实际运行链路一致。
  data.compressionEnabled = compression.enabled;
  data.compressionThreshold = compression.threshold;
  data.compressionSummaryChars = compression.summaryChars;
  data.compressionTailMessages = compression.protectLast;
  data.compressionTimeoutMs = compression.timeoutMs;
  if (!Object.hasOwn(source, 'compressionTargetRatio') && !Object.hasOwn(explicit, 'compressionTargetRatio')) {
    data.compressionTargetRatio = Math.min(LEGACY_DEFAULTS.compressionTargetRatio, compression.threshold / 2);
  }
  if ((data.compressionTargetRatio as number) >= compression.threshold) {
    throw new Error('compressionTargetRatio must be below the resolved compression threshold');
  }
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
  if (typeof data.providerTimeoutMs !== 'number' || !Number.isFinite(data.providerTimeoutMs) ||
      data.providerTimeoutMs <= 0 || data.providerTimeoutMs > 2_147_483_647) throw new Error('providerTimeoutMs must be positive and finite (<=2147483647)');
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
