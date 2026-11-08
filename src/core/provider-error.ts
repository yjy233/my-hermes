import { ProviderError, type ProviderFailure } from './errors.js';

/** 只从有界错误正文识别上下文溢出；正文、URL 和凭证都不进入异常或 trace。 */
export async function httpProviderError(response: Response, label: string, signal?: AbortSignal): Promise<ProviderError> {
  let kind: ProviderFailure = [401, 402, 403].includes(response.status) ? 'access'
    : response.status === 408 || response.status === 429 ? 'timeout'
    : response.status === 503 ? 'overload' : response.status >= 500 ? 'network' : 'other';
  const reader = response.body?.getReader();
  if (reader) {
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if ([400, 413, 422, 429].includes(response.status)) {
        while (size < 8192) {
          signal?.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) break;
          const part = value.subarray(0, 8192 - size);
          chunks.push(part); size += part.byteLength;
        }
        const text = new TextDecoder().decode(Buffer.concat(chunks));
        if (/insufficient_quota|quota_exceeded|billing_hard_limit_reached|credit balance.{0,30}(low|insufficient)/i.test(text)) {
          kind = 'access';
        } else if (/context_length_exceeded|maximum context length|context window.{0,40}(exceed|limit)|too many (input )?tokens|prompt.{0,30}(too long|too large)/i.test(text)) {
          kind = 'context_length';
        }
      }
    } catch {
      signal?.throwIfAborted();
    } finally {
      try { await reader.cancel(); } catch { /* HTTP 状态已知，取消失败不能覆盖它。 */ }
      reader.releaseLock();
    }
  }
  return new ProviderError(`${label} HTTP ${response.status}`, kind, response.status);
}
