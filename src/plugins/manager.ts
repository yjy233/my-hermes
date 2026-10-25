/** Explicit trusted JavaScript/TypeScript plugins; not a security sandbox. */
import { realpathSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ToolRegistry, type Tool } from '../core/tools.js';

export type HookPayload = Record<string, unknown>;
export type PluginHook = (payload: HookPayload) => unknown;

export class PluginContext {
  readonly tools: Tool[] = [];
  readonly hooks: Array<[string, PluginHook]> = [];

  registerTool(tool: Tool): void { this.tools.push(tool); }

  on(event: string, handler: PluginHook): void {
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(event)) throw new Error('Invalid plugin event name');
    if (typeof handler !== 'function' || handler.constructor.name === 'AsyncFunction') {
      throw new Error('Plugin hooks must be synchronous callables');
    }
    this.hooks.push([event, handler]);
  }
}

export class PluginManager {
  readonly loaded: string[] = [];
  private readonly hooks = new Map<string, PluginHook[]>();

  constructor(private readonly registry: ToolRegistry) {}

  async load(paths: string[]): Promise<void> {
    for (const entry of paths) {
      const path = realpathSync(entry);
      if (!statSync(path).isFile() || !['.ts', '.js', '.mjs'].includes(extname(path))) {
        throw new Error(`Plugin must be a JavaScript or TypeScript file: ${path}`);
      }
      if (this.loaded.includes(path)) throw new Error(`Plugin is already loaded: ${path}`);
      // A stable URL lets Node cache one module per file, rather than one per turn.
      // Successful imports require a process restart after source edits.
      const module: unknown = await import(pathToFileURL(path).href);
      if (!module || typeof module !== 'object' || !('register' in module)
          || typeof module.register !== 'function') {
        throw new Error('Plugin must export register(context)');
      }
      const context = new PluginContext();
      await module.register(context);
      const scratch = new ToolRegistry();
      const existing = new Set(this.registry.schemas().map(schema => schema.function.name));
      for (const tool of context.tools) {
        if (existing.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
        scratch.register(tool);
      }
      for (const tool of context.tools) this.registry.register(tool);
      for (const [event, handler] of context.hooks) {
        const handlers = this.hooks.get(event) ?? [];
        handlers.push(handler);
        this.hooks.set(event, handlers);
      }
      this.loaded.push(path);
    }
  }

  emit(event: string, payload: HookPayload): void {
    for (const handler of this.hooks.get(event) ?? []) {
      try {
        const result = handler({ ...payload });
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
          // Observe accidental async rejection before reporting the contract error.
          void Promise.resolve(result).catch(() => undefined);
          throw new Error('Plugin hooks cannot return promises');
        }
      } catch (error) {
        const kind = error instanceof Error ? error.name : 'UnknownError';
        console.warn(`Plugin hook ${JSON.stringify(event)} failed (${kind})`);
      }
    }
  }
}
