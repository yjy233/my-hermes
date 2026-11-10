import { ToolRegistry } from '../core/tools.js';
import { reflectionBody, type ReflectionLibrary, type ReflectionResult, type SkillSnapshot } from './reflection.js';

/** 复盘专用工具，不连接终端、记忆写入或批准操作；所有候选先留在本次调用的内存里。 */
export function reviewTools(library?: ReflectionLibrary) {
  const registry = new ToolRegistry();
  const read = new Map<string, SkillSnapshot>();
  let draft: ReflectionResult = null;
  let listed = false;
  if (library) {
    registry.register({ name: 'skills_list', description: '列出当前 profile 可提出更新的技能。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: () => { const skills = library.list(); listed = true; return skills; },
    });
    registry.register({ name: 'skill_view', description: '读取完整 Skill；更新前必须在本次复盘中重新读取。',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
      handler: args => {
        const snapshot = library.read(args.name as string);
        // 不能在工具结果被截断后仍将其视作完整读取；过大的技能留给人工处理。
        const result = { name: snapshot.name, description: snapshot.description, content: snapshot.content };
        if (JSON.stringify({ ok: true, result }).length > registry.maxOutputChars) throw new Error('Skill too large to review completely');
        read.set(snapshot.name, snapshot);
        return result;
      },
    });
    registry.register({ name: 'skill_manage', description: '提出 create/update 候选；update 需先 skill_view。正文为完整 Markdown，不含 frontmatter。',
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: ['create', 'update'] }, name: { type: 'string' },
        content: { type: 'string', maxLength: 6000 },
      }, required: ['action', 'content'], additionalProperties: false },
      handler: args => {
        if (draft !== null) throw new Error('Only one candidate per review');
        const content = reflectionBody(args.content as string);
        if (!content) throw new Error('Use a final null response to skip a candidate');
        if (args.action === 'create') {
          if (!listed) throw new Error('Call skills_list before proposing a new skill');
          draft = content;
        }
        else {
          const snapshot = read.get(args.name as string);
          if (!snapshot) throw new Error('Call skill_view for this skill before updating it');
          draft = { action: 'update', name: snapshot.name, baseHash: snapshot.hash, content };
        }
        return { status: 'candidate', action: args.action };
      },
    });
  }
  return { registry, draft: () => draft };
}
