import type { LongTermMemory, SessionStore } from '../memory/index.js';
import type { SkillCatalog } from '../skills/catalog.js';
import type { Algorithms } from '../learning/types.js';
import { ToolRegistry, type JsonSchema } from './tools.js';

/** A tiny expression parser, never eval/new Function. Complexity and magnitude are bounded. */
export function calculate(expression: string): number {
  if (typeof expression !== 'string' || expression.length > 200) throw new Error('Expression too long');
  const tokens = expression.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|\/\/|[()+*/%\-]|[^\s]/g) ?? [];
  if (!tokens.length || tokens.length > 80) throw new Error('Expression too complex or empty');
  let position = 0, depth = 0;
  const bounded = (value: number): number => {
    if (!Number.isFinite(value) || Math.abs(value) > 1e15) throw new Error('Number outside calculator limits');
    return value;
  };
  const primary = (): number => {
    if (++depth > 40) throw new Error('Expression nesting too deep');
    const token = tokens[position++];
    let value: number;
    if (token === '+' || token === '-') value = (token === '-' ? -1 : 1) * primary();
    else if (token === '(') {
      value = sum();
      if (tokens[position++] !== ')') throw new Error('Unclosed parentheses');
    } else if (token && /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(token)) value = Number(token);
    else throw new Error('Only numbers and + - * / // % parentheses are supported');
    depth--; return bounded(value);
  };
  const product = (): number => {
    let value = primary();
    while (['*', '/', '//', '%'].includes(tokens[position])) {
      const operation = tokens[position++], right = primary();
      if (operation !== '*' && right === 0) throw new Error('Division by zero');
      value = bounded(operation === '*' ? value * right : operation === '/' ? value / right :
        operation === '//' ? Math.floor(value / right) : value - Math.floor(value / right) * right);
    }
    return value;
  };
  const sum = (): number => {
    let value = product();
    while (tokens[position] === '+' || tokens[position] === '-') {
      const operation = tokens[position++], right = product();
      value = bounded(operation === '+' ? value + right : value - right);
    }
    return value;
  };
  const result = sum();
  if (position !== tokens.length) throw new Error('Unexpected expression token');
  return result;
}

export function objectSchema(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}
export function buildRegistry(memory: LongTermMemory, store: SessionStore, skills: SkillCatalog,
  scope: string, algorithms: Algorithms): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({ name: 'calculator', description: 'Compute bounded arithmetic, e.g. (2+3)*4.',
    parameters: objectSchema({ expression: { type: 'string', maxLength: 200 } }),
    handler: args => calculate(args.expression as string) });
  const target: JsonSchema = { type: 'string', enum: ['MEMORY.md', 'USER.md'] };
  registry.register({ name: 'memory_read', description: "Read this user's long-term memory document.",
    parameters: objectSchema({ target }), handler: args => memory.read(scope, args.target as string) });
  registry.register({ name: 'memory_write', description: 'Replace a bounded memory document. Read and curate before writing.',
    parameters: objectSchema({ target, content: { type: 'string', maxLength: 4000 } }),
    handler: args => {
      memory.write(scope, args.target as string, args.content as string);
      return `Updated ${args.target}; a new session receives the updated prompt snapshot.`;
    } });
  registry.register({ name: 'history_search', description: 'Search previous sessions for the same user only.',
    parameters: objectSchema({ query: { type: 'string', maxLength: 300 } }),
    handler: args => algorithms.selectMemories(args.query as string, store.search(args.query as string, scope, 20), 5) });
  registry.register({ name: 'skill_read', description: 'Read the full body of a named skill in the skill index.',
    parameters: objectSchema({ name: { type: 'string', maxLength: 64 } }),
    handler: args => skills.read(args.name as string) });
  return registry;
}
