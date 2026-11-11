import type { Settings } from '../config.js';
import type { Provider } from '../core/models.js';
import { DemoProvider, OpenAICompatibleProvider } from '../core/providers.js';
import { KimiProvider } from '../core/providers/kimi.js';
import { ReferenceKimiProvider } from '../core/providers/kimi-reference.js';
import { KIMI_DEFAULT_BASE_URL, KIMI_DEFAULT_MODEL } from '../core/providers/kimi-shared.js';

/** 裁判可单独选模型；默认 4096 输出 token，为思考模型留足生成 JSON 的预算。 */
export function createGoalProvider(settings: Settings, environment: NodeJS.ProcessEnv = process.env): Provider {
  const route = settings.auxiliary.goal_judge ?? {}, provider = route.provider ?? settings.provider;
  const changed = provider !== settings.provider;
  const model = route.model ?? (changed ? provider === 'kimi' ? KIMI_DEFAULT_MODEL : 'local-model' : settings.model);
  const baseUrl = route.baseUrl ?? (changed ? provider === 'kimi' ? KIMI_DEFAULT_BASE_URL : 'http://127.0.0.1:11434/v1' : settings.baseUrl);
  let instance: Provider | undefined;
  return { complete: (...args) => {
    // status / 普通聊天没有活动目标时不会实例化裁判或要求它的 API key。
    instance ??= provider === 'demo' ? new DemoProvider() : provider === 'compatible'
      ? new OpenAICompatibleProvider({ model, baseUrl, timeoutMs: settings.goals.judge_timeout_ms, maxTokens: route.max_tokens ?? 4096, apiKey: environment.MY_HERMES_API_KEY ?? environment.OPENAI_API_KEY })
      : new (settings.providerMode === 'reference' ? ReferenceKimiProvider : KimiProvider)({ model, baseUrl, timeoutMs: settings.goals.judge_timeout_ms,
        maxTokens: route.max_tokens ?? 4096, apiKey: environment.MOONSHOT_API_KEY || environment.KIMI_API_KEY || '' });
    return instance.complete(...args);
  } };
}
