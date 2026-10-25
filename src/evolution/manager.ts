/** 可追溯的候选 → 显式审核 → Skill；不自动修改源码。 */
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertSafeFile, atomicWrite, canonicalDirectory, pathExists, readBoundedFile } from '../memory/files.js';
import { MAX_SKILL_BYTES, validateSkillName } from '../skills/catalog.js';

export interface Proposal {
  id: string;
  sessionId: string;
  content: string;
  createdAt: string;
  status: 'pending' | 'approved';
  skillName?: string;
  approvedAt?: string;
}

export class EvolutionManager {
  readonly root: string;
  readonly skillsRoot: string;

  constructor(root: string, skillsRoot: string) {
    this.root = canonicalDirectory(root);
    this.skillsRoot = canonicalDirectory(skillsRoot);
  }

  private proposalPath(id: string): string {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid proposal ID');
    const path = join(this.root, `${id}.json`);
    assertSafeFile(this.root, path);
    return path;
  }

  private read(id: string): Proposal {
    const value: unknown = JSON.parse(readBoundedFile(this.proposalPath(id), 64_000));
    if (!value || typeof value !== 'object') throw new Error('Invalid proposal file');
    const proposal = value as Proposal;
    if (proposal.id !== id || !['pending', 'approved'].includes(proposal.status)
        || typeof proposal.content !== 'string' || !proposal.content.trim() || proposal.content.length > 6000
        || typeof proposal.sessionId !== 'string' || !proposal.sessionId || proposal.sessionId.length > 200
        || typeof proposal.createdAt !== 'string') throw new Error('Invalid proposal data');
    return proposal;
  }

  propose(sessionId: string, content: string): string {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) {
      throw new Error('A bounded source session ID is required');
    }
    if (typeof content !== 'string' || !content.trim() || content.length > 6000) {
      throw new Error('Proposal content must be 1-6000 characters');
    }
    const id = randomUUID().replaceAll('-', '');
    const proposal: Proposal = { id, sessionId, content, createdAt: new Date().toISOString(), status: 'pending' };
    atomicWrite(this.proposalPath(id), `${JSON.stringify(proposal, null, 2)}\n`);
    return id;
  }

  listProposals(): Proposal[] {
    return readdirSync(this.root).filter(name => name.endsWith('.json')).sort()
      .map(name => this.read(name.slice(0, -5))).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  approve(id: string, name: string, description: string): string {
    validateSkillName(name);
    if (typeof description !== 'string' || !description || description.length > 500 || /[\r\n]/.test(description)) {
      throw new Error('Description must be one line of 1-500 characters');
    }
    const proposal = this.read(id);
    if (proposal.status !== 'pending') throw new Error('Proposal has already been approved');
    const directory = join(this.skillsRoot, name);
    if (pathExists(directory)) throw new Error(`Skill already exists: ${name}`);
    const text = '---\n' + `name: ${name}\ndescription: ${JSON.stringify(description)}\n`
      + `source-proposal: ${id}\nsource-session: ${JSON.stringify(proposal.sessionId)}\n---\n\n`
      + `${proposal.content.trim()}\n`;
    if (Buffer.byteLength(text) > MAX_SKILL_BYTES) throw new Error('Approved skill exceeds catalog size limit');
    mkdirSync(directory); // 以独占方式创建目录，防止覆盖其他已批准的 Skill。
    const path = join(directory, 'SKILL.md');
    try {
      const descriptor = openSync(path, 'wx', 0o600);
      try { writeFileSync(descriptor, text, 'utf8'); fsyncSync(descriptor); }
      finally { closeSync(descriptor); }
      const approved: Proposal = {
        ...proposal, status: 'approved', skillName: name, approvedAt: new Date().toISOString(),
      };
      atomicWrite(this.proposalPath(id), `${JSON.stringify(approved, null, 2)}\n`);
    } catch (error) {
      if (pathExists(path)) unlinkSync(path);
      rmdirSync(directory);
      throw error;
    }
    return path;
  }
}
