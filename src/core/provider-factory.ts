import type { Settings } from '../config.js';
import type { Provider } from './models.js';
import { DemoProvider, OpenAICompatibleProvider } from './providers.js';
import { KimiProvider } from './providers/kimi.js';
import { ReferenceKimiProvider } from './providers/kimi-reference.js';

/** Provider 的实现模式与 Core 算法的学习模式独立选择。 */
export function createProvider(settings: Settings, environment: NodeJS.ProcessEnv = process.env): Provider {
  if (settings.provider === 'demo') return new DemoProvider();
  if (settings.provider === 'compatible') return new OpenAICompatibleProvider({
    baseUrl: settings.baseUrl, model: settings.model,
    timeoutMs: settings.providerTimeoutMs,
    apiKey: environment.MY_HERMES_API_KEY ?? environment.OPENAI_API_KEY,
  });
  if (settings.provider === 'kimi') {
    const ProviderClass = settings.providerMode === 'reference' ? ReferenceKimiProvider : KimiProvider;
    return new ProviderClass({ baseUrl: settings.baseUrl, model: settings.model,
      timeoutMs: settings.providerTimeoutMs,
      apiKey: environment.MOONSHOT_API_KEY || environment.KIMI_API_KEY || '' });
  }
  throw new Error('Unknown provider');
}
