export class StepLimitExceeded extends Error { override name = 'StepLimitExceeded'; }
export class ContextBudgetExceeded extends Error { override name = 'ContextBudgetExceeded'; }
export type ProviderFailure = 'context_length' | 'access' | 'network' | 'timeout' | 'overload' | 'empty' | 'truncated' | 'invalid' | 'other';
export class ProviderError extends Error {
  override name = 'ProviderError';
  constructor(message: string, readonly kind: ProviderFailure = 'other', readonly status?: number) { super(message); }
}
export class ExerciseNotImplemented extends Error { override name = 'ExerciseNotImplemented'; }
export class TimeoutError extends Error { override name = 'TimeoutError'; }
