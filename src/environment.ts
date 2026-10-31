/** 从本地 .env 读取配置；已有的系统环境变量优先，不输出任何变量值。 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

export interface EnvironmentFileResult { path: string; loaded: boolean; }
export function loadEnvironmentFile(path?: string, environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()): EnvironmentFileResult {
  const location = resolve(cwd, path ?? '.env');
  if (!existsSync(location)) {
    if (path !== undefined) throw new Error(`Environment file not found: ${location}`);
    return { path: location, loaded: false };
  }
  const info = statSync(location);
  if (!info.isFile() || info.size > 64_000) throw new Error('Environment file must be a file of at most 64000 bytes');
  const data = parseEnv(readFileSync(location, 'utf8'));
  for (const [name, value] of Object.entries(data)) {
    // 与常见 dotenv 行为一致：文件只补充不存在的环境变量，包括显式设置的空值也不覆盖。
    if (environment[name] === undefined) environment[name] = value;
  }
  return { path: location, loaded: true };
}
