import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  EventConflictError, Gateway, PermissionDeniedError, parseInbound, type InboundMessage,
} from '../gateway/router.js';

export interface HttpOptions {
  token: string;
  host?: string;
  port?: number;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
}

class BodyTooLargeError extends Error {}
class RequestInputError extends Error {}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { cleanup(); reject(signal.reason); };
    const cleanup = (): void => signal.removeEventListener('abort', abort);
    if (signal.aborted) {
      void operation.catch(() => {});
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    void operation.then(
      (value) => { cleanup(); resolve(value); },
      (error: unknown) => { cleanup(); reject(error); },
    );
  });
}

function readBody(request: IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => {
      request.off('data', data);
      request.off('end', end);
      request.off('error', fail);
      signal.removeEventListener('abort', abort);
    };
    const fail = (error: unknown): void => { cleanup(); reject(error); };
    const data = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > maxBytes) {
        fail(new BodyTooLargeError('Request body exceeds configured byte limit'));
        request.resume();
      } else {
        chunks.push(chunk);
      }
    };
    const end = (): void => { cleanup(); resolve(Buffer.concat(chunks, size)); };
    const abort = (): void => { fail(signal.reason); request.resume(); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    request.on('data', data);
    request.on('end', end);
    request.on('error', fail);
  });
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length,
  });
  response.end(body);
}

/** Returns an unlistened server. The caller must listen on the validated loopback host. */
export function createHttpServer(gateway: Gateway, options: HttpOptions): Server {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8765;
  const maxBytes = options.maxBodyBytes ?? 64_000;
  const timeoutMs = options.requestTimeoutMs ?? 130_000;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new TypeError('Teaching HTTP connector binds only to loopback');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError('HTTP port must be 0..65535');
  }
  if (typeof options.token !== 'string' || !options.token
      || /[\u0000-\u001f\u007f]/u.test(options.token)) {
    throw new TypeError('HTTP bearer token is required and cannot contain controls');
  }
  if (!gateway.allowedUsers?.size) throw new TypeError('HTTP connector requires a user allowlist');
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_048_576) {
    throw new TypeError('maxBodyBytes must be 1..1048576');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_478_647) {
    throw new TypeError('requestTimeoutMs must be positive and within the Node timer range');
  }
  const expected = Buffer.from(`Bearer ${options.token}`);
  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });
  server.maxHeadersCount = 50;
  server.headersTimeout = Math.min(10_000, timeoutMs);
  server.requestTimeout = timeoutMs + 5000;

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException('HTTP request timed out', 'TimeoutError'));
    }, timeoutMs);
    timeout.unref();
    const disconnected = (): void => {
      if (!response.writableEnded) {
        controller.abort(new DOMException('HTTP client disconnected', 'AbortError'));
      }
    };
    request.once('aborted', disconnected);
    response.once('close', disconnected);
    try {
      if (request.method === 'GET' && request.url === '/health') {
        json(response, 200, { status: 'ok' });
        return;
      }
      if (request.method !== 'POST' || request.url !== '/message') {
        request.resume();
        json(response, 404, { error: 'Not found' });
        return;
      }
      const supplied = Buffer.from(request.headers.authorization ?? '');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        request.resume();
        json(response, 401, { error: 'Invalid bearer token' });
        return;
      }
      const declared = request.headers['content-length'];
      if (declared && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)) {
        request.resume();
        json(response, 413, { error: 'Request body exceeds configured byte limit' });
        return;
      }
      const body = await readBody(request, maxBytes, controller.signal);
      let message: InboundMessage;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
        message = parseInbound(JSON.parse(text) as unknown);
      } catch (error: unknown) {
        throw new RequestInputError(error instanceof Error ? error.message : 'Invalid message');
      }
      const operation = gateway.handle(message, controller.signal);
      // Even a misbehaving custom agent that ignores AbortSignal cannot delay the HTTP timeout.
      const reply = await withAbort(operation, controller.signal);
      json(response, 200, reply);
    } catch (error: unknown) {
      if (timedOut) json(response, 504, { error: 'Agent request timed out' });
      else if (error instanceof PermissionDeniedError) json(response, 403, { error: error.message });
      else if (error instanceof EventConflictError) json(response, 409, { error: error.message });
      else if (error instanceof BodyTooLargeError) json(response, 413, { error: error.message });
      else if (error instanceof RequestInputError) {
        json(response, 400, { error: error.message });
      } else json(response, 500, { error: 'Agent request failed' });
    } finally {
      clearTimeout(timeout);
      request.off('aborted', disconnected);
      response.off('close', disconnected);
    }
  }
  return server;
}
