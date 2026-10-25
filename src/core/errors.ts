export class StepLimitExceeded extends Error { override name = 'StepLimitExceeded'; }
export class ContextBudgetExceeded extends Error { override name = 'ContextBudgetExceeded'; }
export class ProviderError extends Error { override name = 'ProviderError'; }
export class ExerciseNotImplemented extends Error { override name = 'ExerciseNotImplemented'; }
export class TimeoutError extends Error { override name = 'TimeoutError'; }
