import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { ProviderError } from '../src/core/errors.js';
import { OpenAICompatibleProvider } from '../src/core/providers.js';
import { KimiProvider } from '../src/core/providers/kimi.js';
import { ReferenceKimiProvider } from '../src/core/providers/kimi-reference.js';

test('real HTTP provider adapters classify overflow, quota, transient failures and truncated summaries without leaking bodies', async t => {
  let status = 400;
  let body: unknown = { error: { code: 'context_length_exceeded', message: 'private-body-sentinel' } };
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const options = { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'mock', apiKey: 'local-mock-key' };
  for (const provider of [new KimiProvider(options), new ReferenceKimiProvider(options), new OpenAICompatibleProvider(options)]) {
    for (const [nextStatus, code, kind] of [
      [400, 'context_length_exceeded', 'context_length'],
      [429, 'insufficient_quota', 'access'],
      [429, 'rate_limit_exceeded', 'timeout'],
      [403, 'overloaded', 'access'],
      [503, 'overloaded', 'overload'],
      [500, 'server_error', 'network'],
    ] as const) {
      status = nextStatus; body = { error: { code, message: 'private-body-sentinel' } };
      await assert.rejects(() => provider.complete([{ role: 'user', content: 'hello' }], []), error => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.kind, kind); assert.equal(error.status, status);
        assert.doesNotMatch(error.message, /private-body-sentinel/);
        return true;
      });
    }
    status = 200;
    body = { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '## Goal\npartial summary' } }] };
    await assert.rejects(() => provider.complete([{ role: 'user', content: 'summarize' }], []), error =>
      error instanceof ProviderError && error.kind === 'truncated');
  }
});
