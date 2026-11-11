import type { Session } from '../memory/store.js';
import type { GoalManager } from './manager.js';
export const isGoalCommand = (text: string): boolean => /^\/(?:goal|subgoal)(?:\s|$)/u.test(text);
export const isGoalRead = (text: string): boolean => /^\/goal(?:\s+(?:status|show|history|gate(?:\s+list)?))?\s*$/u.test(text) || /^\/subgoal\s*$/u.test(text);
export interface CommandResult { text: string; kick: boolean }

/** 只解析用户入口的控制命令；模型的最终文本和工具结果不会走这个分发器。 */
export async function goalCommand(manager: GoalManager, session: Session, text: string, cwd: string, signal?: AbortSignal): Promise<CommandResult> {
  const subgoal = text.startsWith('/subgoal'), argument = text.slice(subgoal ? 8 : 5).trim();
  const firstSpace = argument.search(/\s/u), verb = firstSpace < 0 ? argument : argument.slice(0, firstSpace), rest = firstSpace < 0 ? '' : argument.slice(firstSpace).trim();
  const result = (value: unknown, kick = false): CommandResult => ({ text: JSON.stringify(value, null, 2), kick });
  if (subgoal) {
    if (!argument) return result(manager.load(session.id)?.subgoals ?? []);
    return result(manager.subgoal(session.id, verb === 'clear' ? 'clear' : ['remove', 'rm'].includes(verb) ? 'remove' : 'add', ['remove', 'rm'].includes(verb) ? rest : argument));
  }
  if (['status', 'show', 'history', 'pause', 'resume', 'clear', 'unwait'].includes(verb) && rest) throw new Error(`/goal ${verb} does not take arguments; use /goal -- TEXT for a literal objective`);
  switch (verb) {
    case '': case 'status': case 'show': return result(manager.load(session.id));
    case 'history': return result(manager.store.loadMessages(session.id));
    case 'pause': return result(manager.pause(session.id));
    case 'resume': return result(manager.resume(session.id), true);
    case 'clear': return result(manager.clear(session.id));
    case 'unwait': return result(manager.unwait(session.id), true);
    case 'wait': {
      const match = /^(?:(pid|session|seconds)\s+)?(\S+)(?:\s+([\s\S]*))?$/u.exec(rest);
      if (!match) throw new Error('Use /goal wait SECONDS, /goal wait pid PID, or /goal wait session ID');
      const kind = match[1] ?? 'seconds', target = kind === 'session' ? { session_id: match[2] } : { [kind]: Number(match[2]) };
      return result(manager.wait(session.id, target, match[3]));
    }
    case 'budget': {
      const count = Number(rest); if (!Number.isSafeInteger(count) || count < 1) throw new Error('Budget must be a positive integer');
      return result(manager.change(session.id, state => { state.max_turns = count; }));
    }
    case 'gate': {
      const match = /^(add|remove|rm|clear|list)(?:\s+([\s\S]*))?$/u.exec(rest);
      if (!rest || match?.[1] === 'list') return result(manager.load(session.id)?.gates ?? []);
      if (!match) throw new Error('Use /goal gate add COMMAND, remove NUMBER, list, or clear');
      return result(match[1] === 'add' ? manager.addGate(session.id, match[2] ?? '', cwd)
        : manager.removeGate(session.id, match[1] === 'clear' ? undefined : Number(match[2])));
    }
    default: {
      let objective = ['set', '--', 'draft'].includes(verb) ? rest : argument;
      const budget = /^--turns\s+(\d+)\s+([\s\S]+)$/u.exec(objective);
      if (objective.startsWith('--turns') && !budget) throw new Error('Use --turns POSITIVE_INTEGER followed by an objective');
      if (budget) objective = budget[2];
      if (!objective.trim() || objective.length > 14_000) throw new Error('A bounded nonempty objective is required');
      let contract, warning;
      if (verb === 'draft') {
        try { contract = await manager.draft(objective, signal); }
        catch (error) { signal?.throwIfAborted(); warning = 'Contract drafting failed; starting with the explicit objective and the normal goal judge.'; }
      }
      const state = manager.set(session, objective, budget ? Number(budget[1]) : undefined, contract);
      return result(warning ? { ...state, warning } : state, true);
    }
  }
}
