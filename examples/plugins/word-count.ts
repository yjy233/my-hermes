/** Explicit trusted extension; TypeScript type imports are erased at runtime. */
import type { PluginContext } from '../../src/plugins/manager.js';

export function register(context: PluginContext): void {
  context.registerTool({
    name: 'word_count', description: 'Count whitespace-separated words in a text.',
    parameters: {
      type: 'object', properties: { text: { type: 'string', maxLength: 4000 } },
      required: ['text'], additionalProperties: false,
    },
    handler: ({ text }) => {
      const content = text as string;
      return { words: content.trim() ? content.trim().split(/\s+/u).length : 0, characters: content.length };
    },
  });
}
