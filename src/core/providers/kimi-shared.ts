/** 公共配置校验与默认值，供 Kimi 实现和参考实现共用。 */
export const KIMI_DEFAULT_BASE_URL = 'https://api.moonshot.cn/v1';
export const KIMI_DEFAULT_MODEL = 'kimi-k3.1-pro';
export interface KimiProviderOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}
export type ResolvedKimiOptions = Required<KimiProviderOptions>;
export function resolveKimiOptions(options: KimiProviderOptions): ResolvedKimiOptions {
  if (typeof options.apiKey !== 'string' || !options.apiKey.trim() || /[\s\u0000-\u001f\u007f]/u.test(options.apiKey)) {
    throw new Error('Kimi API key required: set MOONSHOT_API_KEY or KIMI_API_KEY locally');
  }
  const resolved: ResolvedKimiOptions = {
    apiKey: options.apiKey, baseUrl: options.baseUrl ?? KIMI_DEFAULT_BASE_URL,
    model: options.model ?? KIMI_DEFAULT_MODEL, timeoutMs: options.timeoutMs ?? 30_000,
    maxResponseBytes: options.maxResponseBytes ?? 2_000_000,
  };
  const url = new URL(resolved.baseUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Kimi baseUrl must be an HTTP(S) API root without credentials, query, or fragment');
  }
  if (!resolved.model.trim() || !Number.isFinite(resolved.timeoutMs) || resolved.timeoutMs <= 0 ||
      resolved.timeoutMs > 2_147_483_647 || !Number.isSafeInteger(resolved.maxResponseBytes) || resolved.maxResponseBytes < 1) {
    throw new Error('Invalid Kimi model or request budget');
  }
  return resolved;
}
