import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { Gateway, parseInbound } from '../gateway/router.js';

const MAX_LINE_BYTES = 64_000;

/** Bounded byte-level framing; discard an oversized line until its next newline. */
export async function runJsonl(gateway: Gateway, input: Readable, output: Writable): Promise<void> {
  let parts: Buffer[] = [];
  let bytes = 0;
  let overflow = false;
  let number = 0;
  const write = async (value: unknown): Promise<void> => {
    if (!output.write(`${JSON.stringify(value)}\n`)) await once(output, 'drain');
  };
  const finish = async (): Promise<void> => {
    number += 1;
    try {
      if (overflow) throw new TypeError(`JSONL line exceeds ${MAX_LINE_BYTES} bytes`);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts, bytes));
      if (!text.trim()) return;
      await write(await gateway.handle(parseInbound(JSON.parse(text) as unknown)));
    } catch (error: unknown) {
      const known = error instanceof Error && (
        error instanceof TypeError || error instanceof SyntaxError
        || ['EventConflictError', 'PermissionDeniedError', 'ExerciseNotImplemented'].includes(error.name)
      );
      await write({
        error: {
          type: known ? error.name : 'RequestFailed',
          message: known ? error.message : 'Agent request failed',
        }, line: number,
      });
    } finally {
      parts = [];
      bytes = 0;
      overflow = false;
    }
  };
  for await (const raw of input) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      const size = end - start;
      if (!overflow && bytes + size <= MAX_LINE_BYTES) {
        // Copy the slice so a tiny line cannot retain an arbitrarily large input chunk.
        if (size) parts.push(Buffer.from(chunk.subarray(start, end)));
        bytes += size;
      } else {
        parts = [];
        bytes = 0;
        overflow = true;
      }
      if (newline === -1) break;
      await finish();
      start = newline + 1;
    }
  }
  if (bytes || overflow) await finish();
}
