/** 兼容 Hermes 的 cron/jobs.json 引用格式。只修改技能引用，不执行或重新创建任务。 */
import { join } from 'node:path';
import { isRecord } from '../core/models.js';
import { locked, readJson, writeJson } from './files.js';
type Job = Record<string, unknown>;
export interface CronSnapshot { id: string; skill: unknown; skills: unknown }
export class SkillReferences {
  readonly path: string;
  constructor(readonly home: string) { this.path = join(home, 'cron', 'jobs.json'); }
  private load(): { document: unknown; jobs: Job[] } {
    const document: unknown = readJson(this.path, []);
    const jobs = Array.isArray(document) ? document : isRecord(document) ? document.jobs : undefined;
    if (!Array.isArray(jobs) || jobs.some(job => !isRecord(job))) throw new Error('Invalid cron/jobs.json; skill references cannot be checked');
    return { document, jobs };
  }
  private jobNames(job: Job): string[] {
    return [...new Set([...(Array.isArray(job.skills) ? job.skills : []), job.skill].filter((s): s is string => typeof s === 'string' && !!s))];
  }
  names(): Set<string> { return new Set(this.load().jobs.flatMap(job => this.jobNames(job))); }
  snapshot(): CronSnapshot[] { return this.load().jobs.map(job => ({ id: String(job.id), skill: job.skill ?? null, skills: job.skills ?? [] })); }
  rewrite(mapping: Record<string, string>): CronSnapshot[] {
    return locked(this.home, 'cron-skill-refs', () => {
      const { document, jobs } = this.load(), changed: CronSnapshot[] = [];
      for (const job of jobs) {
        const before = this.jobNames(job), after = [...new Set(before.map(name => mapping[name] ?? name))];
        if (JSON.stringify(before) === JSON.stringify(after)) continue;
        changed.push({ id: String(job.id), skill: job.skill ?? null, skills: job.skills ?? [] });
        job.skills = after; job.skill = after[0] ?? null;
      }
      if (changed.length) writeJson(this.path, document);
      return changed;
    });
  }
  restore(snapshot: CronSnapshot[]): void {
    locked(this.home, 'cron-skill-refs', () => {
      const { document, jobs } = this.load(); let changed = false;
      for (const job of jobs) {
        const old = snapshot.find(row => row.id === String(job.id));
        if (old) { job.skill = old.skill; job.skills = old.skills; changed = true; }
      }
      if (changed) writeJson(this.path, document);
    });
  }
}
