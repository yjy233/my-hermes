import { isRecord } from '../core/models.js';

export interface CuratorSettings {
  enabled: boolean; interval_hours: number; min_idle_hours: number;
  stale_after_days: number; archive_after_days: number; consolidate: boolean;
  prune_builtins: boolean; archive_ttl_days: number;
  backup: { enabled: boolean; keep: number };
}
export interface SkillSettings {
  ledger: boolean; ledger_max_bytes: number; write_approval: boolean;
  disabled: string[]; external_dirs: string[];
}
export const DEFAULT_CURATOR: CuratorSettings = {
  enabled: true, interval_hours: 168, min_idle_hours: 2,
  stale_after_days: 14, archive_after_days: 30, consolidate: false,
  prune_builtins: false, archive_ttl_days: 0, backup: { enabled: true, keep: 2 },
};
export const DEFAULT_SKILLS: SkillSettings = {
  ledger: true, ledger_max_bytes: 5 * 1024 * 1024, write_approval: false, disabled: [], external_dirs: [],
};

function shape(value: unknown, defaults: object, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown ${label} key: ${key}`);
  return value;
}
export function curatorSettings(value: unknown = {}): CuratorSettings {
  const input = shape(value, DEFAULT_CURATOR, 'curator');
  const backup = shape(input.backup ?? {}, DEFAULT_CURATOR.backup, 'curator.backup');
  const settings = { ...DEFAULT_CURATOR, ...input, backup: { ...DEFAULT_CURATOR.backup, ...backup } } as CuratorSettings;
  for (const key of ['enabled', 'consolidate', 'prune_builtins'] as const) {
    if (typeof settings[key] !== 'boolean') throw new Error(`curator.${key} must be boolean`);
  }
  for (const key of ['interval_hours', 'min_idle_hours', 'stale_after_days', 'archive_after_days', 'archive_ttl_days'] as const) {
    if (!Number.isFinite(settings[key]) || settings[key] < (['min_idle_hours', 'archive_ttl_days'].includes(key) ? 0 : 1)) {
      throw new Error(`Invalid curator.${key}`);
    }
  }
  if (typeof settings.backup.enabled !== 'boolean' || !Number.isSafeInteger(settings.backup.keep) || settings.backup.keep < 1) {
    throw new Error('Invalid curator.backup settings');
  }
  return settings;
}
export function skillSettings(value: unknown = {}): SkillSettings {
  const settings = { ...DEFAULT_SKILLS, ...shape(value, DEFAULT_SKILLS, 'skills') } as SkillSettings;
  for (const key of ['ledger', 'write_approval'] as const) if (typeof settings[key] !== 'boolean') throw new Error(`skills.${key} must be boolean`);
  if (!Number.isSafeInteger(settings.ledger_max_bytes) || settings.ledger_max_bytes < 0) throw new Error('Invalid skills.ledger_max_bytes');
  for (const key of ['disabled', 'external_dirs'] as const) {
    if (!Array.isArray(settings[key]) || settings[key].some(item => typeof item !== 'string' || !item.trim())) throw new Error(`Invalid skills.${key}`);
    settings[key] = [...settings[key]];
  }
  return settings;
}
