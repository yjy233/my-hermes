/** 预算沿用本项目的序列化字符计数；不把字符数伪装成模型 token 数。 */
export interface CompressionSettings {
  enabled: boolean;
  threshold: number;
  protectFirst: number;
  protectLast: number;
  summaryChars: number;
  timeoutMs: number;
  abortOnFailure: boolean;
  summaryModel: string;
}

export const DEFAULT_COMPRESSION: Readonly<CompressionSettings> = Object.freeze({
  enabled: true, threshold: 0.5, protectFirst: 3, protectLast: 20,
  summaryChars: 6000, timeoutMs: 30_000, abortOnFailure: false, summaryModel: '',
});

export function compressionSettings(value: unknown = {}): CompressionSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('compression must be an object');
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(DEFAULT_COMPRESSION, key)) throw new Error(`Unknown compression key: ${key}`);
  }
  const settings = { ...DEFAULT_COMPRESSION, ...value };
  if (typeof settings.enabled !== 'boolean' || typeof settings.abortOnFailure !== 'boolean' ||
      typeof settings.summaryModel !== 'string') throw new Error('Invalid compression settings');
  if (!Number.isFinite(settings.threshold) || settings.threshold < 0.1 || settings.threshold > 0.95) {
    throw new Error('compression.threshold must be between 0.1 and 0.95');
  }
  for (const key of ['protectFirst', 'protectLast', 'summaryChars', 'timeoutMs'] as const) {
    if (!Number.isSafeInteger(settings[key]) || settings[key] < 1) throw new Error(`compression.${key} must be a positive integer`);
  }
  if (settings.summaryChars < 256 || settings.timeoutMs > 2_147_483_647) throw new Error('Invalid compression budget');
  return settings;
}

export type SummaryFailure = 'access' | 'network' | 'timeout' | 'overload' | 'empty' | 'truncated' | 'invalid' | 'other';
/** 仅保存诊断类别和计数，不保存远端错误正文或提示词。摘要本身属于会话的工作上下文。 */
export interface CompressionState {
  cooldownUntil: number;
  failures: number;
  lastFailure?: SummaryFailure;
  nextAttemptChars: number;
}
export function initialCompressionState(): CompressionState {
  return { cooldownUntil: 0, failures: 0, nextAttemptChars: 0 };
}
