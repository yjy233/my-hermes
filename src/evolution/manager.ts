/** 可追溯的候选 → 显式审核 → Skill；不自动修改源码。 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { SkillRepository } from '../curator/repository.js';
import { collectFiles, locked } from '../curator/files.js';
import { assertSafeFile, atomicWrite, canonicalDirectory, pathExists, readBoundedFile } from '../memory/files.js';
import { MAX_SKILL_BYTES, SkillCatalog, validateSkillName } from '../skills/catalog.js';
import { MAX_PROPOSAL_CHARS, type ReflectionLibrary, type SkillUpdate } from './reflection.js';

export interface Proposal {
  id: string;
  sessionId: string;
  content: string;
  createdAt: string;
  status: 'pending' | 'approved';
  skillName?: string;
  approvedAt?: string;
  action?: 'create' | 'update';
  baseHash?: string;
  previousContent?: string;
}

export class EvolutionManager {
  readonly root: string;
  readonly skillsRoot: string;

  constructor(root: string, skillsRoot: string, readonly repository = new SkillRepository(dirname(skillsRoot))) {
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
    const value: unknown = JSON.parse(readBoundedFile(this.proposalPath(id), 128_000));
    if (!value || typeof value !== 'object') throw new Error('Invalid proposal file');
    const proposal = value as Proposal;
    if (proposal.id !== id || !['pending', 'approved'].includes(proposal.status)
        || typeof proposal.content !== 'string' || !proposal.content.trim() || proposal.content.length > MAX_PROPOSAL_CHARS
        || typeof proposal.sessionId !== 'string' || !proposal.sessionId || proposal.sessionId.length > 200
        || typeof proposal.createdAt !== 'string') throw new Error('Invalid proposal data');
    if (proposal.action !== undefined && !['create', 'update'].includes(proposal.action)) throw new Error('Invalid proposal action');
    if (proposal.action === 'update') {
      validateSkillName(proposal.skillName!);
      if (typeof proposal.previousContent !== 'string' || Buffer.byteLength(proposal.previousContent) > MAX_SKILL_BYTES ||
          createHash('sha256').update(proposal.previousContent).digest('hex') !== proposal.baseHash) throw new Error('Invalid update snapshot');
    }
    return proposal;
  }

  /** 只暴露当前 profile 的技能；不修改内置或外部技能目录。每次 read 都读取磁盘的新版本。 */
  library(): ReflectionLibrary {
    const catalog = () => { const skills = new SkillCatalog([this.skillsRoot]); skills.discover(); return skills; };
    return {
      list: () => this.repository.rows().filter(row => !row.locked && !row.disabled && !['external', 'installed', 'bundled'].includes(row.provenance)).map(({ name, description }) => ({ name, description })),
      read: name => {
        const row = this.repository.get(name);
        if (row.locked || ['external', 'installed', 'bundled'].includes(row.provenance)) throw new Error('Skill is protected from reflection updates');
        const skills = catalog(), content = skills.read(name);
        return { name, description: skills.skills.get(name)!.description, content,
          hash: createHash('sha256').update(content).digest('hex') };
      },
    };
  }

  propose(sessionId: string, draft: string | SkillUpdate): string {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) {
      throw new Error('A bounded source session ID is required');
    }
    const content = typeof draft === 'string' ? draft : draft.content;
    if (typeof content !== 'string' || !content.trim() || content.length > MAX_PROPOSAL_CHARS) {
      throw new Error('Proposal content must be 1-6000 characters');
    }
    const id = randomUUID().replaceAll('-', '');
    const proposal: Proposal = { id, sessionId, content, createdAt: new Date().toISOString(), status: 'pending', action: 'create' };
    if (typeof draft !== 'string') {
      if (draft.action !== 'update') throw new Error('Invalid proposal action');
      const snapshot = this.library().read(draft.name);
      if (snapshot.hash !== draft.baseHash) throw new Error('Skill changed since review; read and review it again');
      Object.assign(proposal, { action: 'update', skillName: draft.name, baseHash: snapshot.hash, previousContent: snapshot.content });
    }
    atomicWrite(this.proposalPath(id), `${JSON.stringify(proposal, null, 2)}\n`);
    return id;
  }

  listProposals(): Proposal[] {
    return readdirSync(this.root).filter(name => name.endsWith('.json')).sort()
      .map(name => this.read(name.slice(0, -5))).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): Proposal { return this.read(id); }

  approve(id: string, name?: string, description?: string): string {
    return locked(this.skillsRoot, 'mutation', () => {
      const proposal = this.read(id), target = proposal.action === 'update' ? proposal.skillName! : name;
      const row = target ? this.repository.rows().find(row => row.name === target) : undefined;
      if (row?.locked) throw new Error('Skill is locked');
      const before = row ? collectFiles(dirname(row.path)).map(file => ({ ...file, path: relative(this.skillsRoot, join(dirname(row.path), file.path)) })) : [];
      const path = this.approveUnlocked(id, name, description);
      const actual = target!;
      try { if (proposal.action === 'update') this.repository.activity(actual, 'patch'); else this.repository.created(actual, 'agent'); }
      catch (error) { this.repository.ledger.warnings.push(`Usage telemetry: ${String(error)}`); }
      const after = collectFiles(dirname(path)).map(file => ({ ...file, path: relative(this.skillsRoot, join(dirname(path), file.path)) }));
      this.repository.ledger.record({ actor: 'agent', action: proposal.action === 'update' ? 'patch' : 'create', skill: actual, session_id: proposal.sessionId }, before, after);
      return path;
    });
  }

  private approveUnlocked(id: string, name?: string, description?: string): string {
    const proposal = this.read(id);
    if (proposal.status !== 'pending') throw new Error('Proposal has already been approved');
    if (proposal.action === 'update') return this.approveUpdate(proposal, name, description);
    if (name === undefined) throw new Error('A name is required for a new Skill');
    validateSkillName(name);
    if (typeof description !== 'string' || !description || description.length > 500 || /[\r\n]/.test(description)) {
      throw new Error('Description must be one line of 1-500 characters');
    }
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

  private approveUpdate(proposal: Proposal, name?: string, description?: string): string {
    if (name !== undefined && name !== proposal.skillName) throw new Error('Update target cannot be renamed');
    if (description !== undefined && (!description || description.length > 500 || /[\r\n]/.test(description))) {
      throw new Error('Description must be one line of 1-500 characters');
    }
    const snapshot = this.library().read(proposal.skillName!);
    if (snapshot.hash !== proposal.baseHash) throw new Error('Skill changed since proposal; review it again before approval');
    const skills = new SkillCatalog([this.skillsRoot]); skills.discover();
    const path = skills.skills.get(snapshot.name)!.path;
    const lines = snapshot.content.split(/\r?\n/), end = lines.indexOf('---', 1);
    const header = lines.slice(1, end).filter(line => !/^\s*(source-proposal|source-session):/.test(line));
    if (description !== undefined) {
      const index = header.findIndex(line => /^\s*description:/.test(line));
      header[index] = `description: ${JSON.stringify(description)}`;
    }
    const text = ['---', ...header, `source-proposal: ${proposal.id}`,
      `source-session: ${JSON.stringify(proposal.sessionId)}`, '---', '', proposal.content.trim(), ''].join('\n');
    if (Buffer.byteLength(text) > MAX_SKILL_BYTES) throw new Error('Approved skill exceeds catalog size limit');
    assertSafeFile(this.skillsRoot, path);
    atomicWrite(path, text);
    try {
      atomicWrite(this.proposalPath(proposal.id), JSON.stringify({ ...proposal, status: 'approved', approvedAt: new Date().toISOString() }, null, 2) + '\n');
    } catch (error) {
      atomicWrite(path, snapshot.content);
      throw error;
    }
    return path;
  }
}
