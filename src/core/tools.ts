import { abortReason, withTimeout } from './async.js';
import { assertFiniteJson, isRecord, type Message, type ToolCall, type ToolSchema } from './models.js';

/** Deliberately small JSON Schema subset; unsupported constraints fail at registration. */
export type JsonSchema = Record<string, unknown>;
export interface ToolContext { signal: AbortSignal; }
export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
  handler: (args: Record<string, unknown>, context: ToolContext) => unknown | Promise<unknown>;
  timeoutMs?: number;
}
const TYPES = new Set(['object', 'array', 'string', 'boolean', 'integer', 'number', 'null']);
const KEYS = new Set(['type', 'description', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'maxLength', 'maxItems']);

export function validateSchema(schema: unknown): asserts schema is JsonSchema {
  if (!isRecord(schema) || typeof schema.type !== 'string' || !TYPES.has(schema.type)) {
    throw new Error('Tool schema must declare a supported JSON type');
  }
  for (const key of Object.keys(schema)) if (!KEYS.has(key)) throw new Error(`Unsupported schema constraint: ${key}`);
  if (schema.type === 'object') {
    const properties = schema.properties ?? {};
    if (!isRecord(properties)) throw new Error('Schema properties must be an object');
    const required = schema.required ?? [];
    if (!Array.isArray(required) || required.some(key => typeof key !== 'string' || !Object.hasOwn(properties, key))) {
      throw new Error('Required must name declared properties');
    }
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
      throw new Error('Only boolean additionalProperties is supported');
    }
    for (const child of Object.values(properties)) validateSchema(child);
  }
  if (schema.type === 'array') validateSchema(schema.items);
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) throw new Error('enum must be an array');
  for (const key of ['maxLength', 'maxItems']) {
    const bound = schema[key];
    if (bound !== undefined && (typeof bound !== 'number' || !Number.isSafeInteger(bound) || bound < 0)) {
      throw new Error(`${key} must be a nonnegative safe integer`);
    }
  }
  assertFiniteJson(schema);
}

export function validate(value: unknown, schema: JsonSchema, path = 'arguments'): void {
  const kind = schema.type;
  const valid = kind === 'object' ? isRecord(value) : kind === 'array' ? Array.isArray(value) :
    kind === 'null' ? value === null : kind === 'integer' ? Number.isSafeInteger(value) :
    kind === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === kind;
  if (!valid) throw new Error(`${path}: expected ${String(kind)}`);
  if (schema.enum && !(schema.enum as unknown[]).some(item => JSON.stringify(item) === JSON.stringify(value))) {
    throw new Error(`${path}: invalid enum value`);
  }
  if (kind === 'object') {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const key of (schema.required ?? []) as string[]) {
      if (!Object.hasOwn(record, key)) throw new Error(`${path}.${key}: required`);
    }
    for (const [key, item] of Object.entries(record)) {
      if (Object.hasOwn(properties, key)) validate(item, properties[key], `${path}.${key}`);
      else if (schema.additionalProperties !== true) throw new Error(`${path}: unexpected property ${key}`);
    }
  }
  if (kind === 'array') {
    const items = value as unknown[];
    if (items.length > (schema.maxItems as number ?? 100)) throw new Error(`${path}: too many items`);
    for (const item of items) validate(item, schema.items as JsonSchema, `${path}[]`);
  }
  if (kind === 'string' && (value as string).length > (schema.maxLength as number ?? 16_000)) {
    throw new Error(`${path}: too long`);
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  constructor(readonly maxOutputChars = 12_000) {
    if (!Number.isSafeInteger(maxOutputChars) || maxOutputChars < 200) throw new Error('Tool output budget must be >=200');
  }
  register(tool: Tool): void {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name)) throw new Error('Invalid tool name');
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    const timeout = tool.timeoutMs ?? 10_000;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2_147_483_647) throw new Error('Invalid tool timeout');
    if (typeof tool.description !== 'string' || typeof tool.handler !== 'function') throw new Error('Invalid tool definition');
    validateSchema(tool.parameters);
    if (tool.parameters.type !== 'object') throw new Error('Tool parameters must be an object schema');
    this.tools.set(tool.name, tool);
  }
  schemas(): ToolSchema[] {
    return [...this.tools.values()].map(tool => ({ type: 'function', function: {
      name: tool.name, description: tool.description, parameters: structuredClone(tool.parameters),
    } }));
  }
  async execute(call: ToolCall, signal?: AbortSignal): Promise<Message> {
    signal?.throwIfAborted();
    let content: string;
    try {
      const tool = this.tools.get(call.name);
      if (!tool) throw new Error(`Unknown tool: ${call.name}`);
      assertFiniteJson(call.arguments);
      validate(call.arguments, tool.parameters);
      const result = await withTimeout(async toolSignal => {
        toolSignal.throwIfAborted();
        return tool.handler(call.arguments, { signal: toolSignal });
      }, tool.timeoutMs ?? 10_000, signal);
      signal?.throwIfAborted();
      assertFiniteJson(result);
      content = this.boundedJson({ ok: true, result }, 'result');
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      content = this.boundedJson({
        ok: false, error: error instanceof Error ? error.name.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64) : 'ToolError',
        message: error instanceof Error ? error.message : String(error),
      }, 'message');
    }
    return { role: 'tool', content, toolCallId: call.id };
  }
  private boundedJson(payload: Record<string, unknown>, textKey: string): string {
    const full = JSON.stringify(payload);
    if (full.length <= this.maxOutputChars) return full;
    const text = typeof payload[textKey] === 'string' ? payload[textKey] as string : JSON.stringify(payload[textKey]);
    const bounded = { ...payload, truncated: true, [textKey]: '' };
    let low = 0, high = Math.min(text.length, this.maxOutputChars), best = JSON.stringify(bounded);
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      bounded[textKey] = text.slice(0, middle);
      const candidate = JSON.stringify(bounded);
      if (candidate.length <= this.maxOutputChars) { best = candidate; low = middle + 1; }
      else high = middle - 1;
    }
    return best;
  }
}
