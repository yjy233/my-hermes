import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
cpSync(new URL('../src/data', import.meta.url), new URL('../dist/data', import.meta.url), {
  recursive: true,
});
// 编译后的插件可直接由 Node 运行，安装到 node_modules 中时也一样。
const exampleDirectory = new URL('../dist/examples/plugins/', import.meta.url);
mkdirSync(exampleDirectory, { recursive: true });
const source = readFileSync(new URL('../examples/plugins/word-count.ts', import.meta.url), 'utf8');
writeFileSync(new URL('word-count.js', exampleDirectory), transpileModule(source, {
  compilerOptions: { module: ModuleKind.ES2022, target: ScriptTarget.ES2023 },
}).outputText);
chmodSync(new URL('../dist/cli.js', import.meta.url), 0o755);
