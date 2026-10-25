import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
cpSync(new URL('../src/data', import.meta.url), new URL('../dist/data', import.meta.url), {
  recursive: true,
});
// Compiled plugins run with plain Node, including when installed under node_modules.
const exampleDirectory = new URL('../dist/examples/plugins/', import.meta.url);
mkdirSync(exampleDirectory, { recursive: true });
const source = readFileSync(new URL('../examples/plugins/word-count.ts', import.meta.url), 'utf8');
writeFileSync(new URL('word-count.js', exampleDirectory), transpileModule(source, {
  compilerOptions: { module: ModuleKind.ES2022, target: ScriptTarget.ES2023 },
}).outputText);
chmodSync(new URL('../dist/cli.js', import.meta.url), 0o755);
