import { commandAllowed } from './approvals.js';
import type { SkillInfo } from './skills.js';
import type { Effect } from './types.js';

export const CLAUDE_TOOL_NAMES: Readonly<Record<string, string>> = {
  Bash: 'execute',
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'edit_file',
  Glob: 'glob',
  Grep: 'grep',
  WebFetch: 'webfetch',
  WebSearch: 'websearch',
  Task: 'task',
  Agent: 'task',
  Skill: 'skill',
  TodoWrite: 'write_todos',
  AskUserQuestion: 'question',
};
const ALWAYS_OFFERED = new Set(['compact_conversation']);

export interface ToolGrant {
  tool: string;
  patterns?: string[];
}

export interface SkillTools {
  skill: string;
  allowed: ToolGrant[];
  withheld: string[];
  problems: string[];
}

const ENTRY = /^([^()\s]+)(?:\(([\s\S]*)\))?$/;

// Legacy Claude Code `cmd:*` syntax covers both the bare command and `cmd *`.
function commandPatterns(pattern: string): string[] {
  const text = pattern.trim();
  return text.endsWith(':*')
    ? [text.slice(0, -2), `${text.slice(0, -2)} *`]
    : [text];
}

export function resolveSkillTools(
  skill: Pick<SkillInfo, 'name' | 'allowed_tools' | 'disallowed_tools'>,
  known: ReadonlyMap<string, Effect>,
): SkillTools {
  const problems: string[] = [];
  const grants = new Map<string, Set<string> | true>();
  const withheld = new Set<string>();
  const parse = (
    field: string,
    entries: string[] | undefined,
    apply: (tool: string, pattern: string | undefined, entry: string) => void,
  ): void => {
    const missing: string[] = [];
    for (const entry of entries ?? []) {
      const found = ENTRY.exec(entry);
      if (!found || found[2]?.trim() === '') {
        problems.push(`${skill.name} ${field} ${entry}: not a tool name`);
        continue;
      }
      const name = found[1]!;
      const tool = Object.hasOwn(CLAUDE_TOOL_NAMES, name)
        ? CLAUDE_TOOL_NAMES[name]!
        : name;
      if (!known.has(tool)) missing.push(name);
      else apply(tool, found[2]?.trim(), entry);
    }
    if (missing.length)
      problems.push(
        `${skill.name} names tools that do not exist in ${field}: ${missing.join(', ')}`,
      );
  };
  parse('allowed-tools', skill.allowed_tools, (tool, pattern, entry) => {
    if (pattern === undefined) grants.set(tool, true);
    else if (tool !== 'execute') {
      if (known.get(tool) !== 'read')
        problems.push(
          `${skill.name} allowed-tools ${entry}: only execute takes a pattern`,
        );
    } else {
      const have = grants.get(tool);
      if (have === true) return;
      const patterns = have ?? new Set<string>();
      for (const one of commandPatterns(pattern)) patterns.add(one);
      grants.set(tool, patterns);
    }
  });
  parse('disallowed-tools', skill.disallowed_tools, (tool, pattern, entry) => {
    if (pattern !== undefined)
      problems.push(
        `${skill.name} disallowed-tools ${entry}: a whole tool is withheld, never part of its calls`,
      );
    else if (ALWAYS_OFFERED.has(tool))
      problems.push(`${skill.name} disallowed-tools ${entry}: always offered`);
    else withheld.add(tool);
  });
  return {
    skill: skill.name,
    allowed: [...grants].map(([tool, patterns]) =>
      patterns === true ? { tool } : { tool, patterns: [...patterns] },
    ),
    withheld: [...withheld],
    problems: problems.map((line) => `${line} · not applied`),
  };
}

export const grantNames = (grant: ToolGrant): string[] =>
  grant.patterns
    ? grant.patterns.map((pattern) => `${grant.tool}(${pattern})`)
    : [grant.tool];

export function describeSkillTools(
  tools: SkillTools,
  later: boolean,
): string[] {
  const when = later ? 'for your next message' : 'until your next message';
  const granted = tools.allowed.flatMap(grantNames);
  return [
    ...(granted.length ? [`pre-approved ${when}: ${granted.join(', ')}`] : []),
    ...(tools.withheld.length
      ? [`not offered ${when}: ${tools.withheld.join(', ')}`]
      : []),
    ...tools.problems,
  ];
}

interface Scope {
  now: Map<string, SkillTools>;
  next: Map<string, SkillTools>;
}

export class SkillScopes {
  private readonly scopes = new Map<string, Scope>();
  constructor(private readonly workspace: string) {}
  private scope(sessionId: string): Scope {
    let scope = this.scopes.get(sessionId);
    if (!scope) {
      scope = { now: new Map(), next: new Map() };
      this.scopes.set(sessionId, scope);
    }
    return scope;
  }
  load(sessionId: string, tools: SkillTools, when: 'now' | 'next'): void {
    const scope = this.scope(sessionId);
    const target = when === 'now' ? scope.now : scope.next;
    if (tools.allowed.length || tools.withheld.length)
      target.set(tools.skill, tools);
    else target.delete(tools.skill);
  }
  message(sessionId: string): void {
    const scope = this.scopes.get(sessionId);
    if (!scope) return;
    scope.now = scope.next;
    scope.next = new Map();
  }
  withheld(sessionId: string): ReadonlySet<string> | undefined {
    const now = this.scopes.get(sessionId)?.now;
    if (!now?.size) return undefined;
    const names = new Set<string>();
    for (const tools of now.values())
      for (const name of tools.withheld) names.add(name);
    return names.size ? names : undefined;
  }
  allows(
    sessionId: string,
    tool: string,
    args: Record<string, unknown>,
  ): boolean {
    const now = this.scopes.get(sessionId)?.now;
    if (!now?.size) return false;
    for (const tools of now.values())
      for (const grant of tools.allowed) {
        if (grant.tool !== tool) continue;
        if (!grant.patterns) return true;
        if (
          typeof args.command === 'string' &&
          commandAllowed(args.command, grant.patterns, this.workspace)
        )
          return true;
      }
    return false;
  }
  state(sessionId: string): { now: string[]; next: string[] } {
    const scope = this.scopes.get(sessionId);
    return {
      now: [...(scope?.now.keys() ?? [])],
      next: [...(scope?.next.keys() ?? [])],
    };
  }
  drop(sessionId: string): void {
    this.scopes.delete(sessionId);
  }
  clear(): void {
    this.scopes.clear();
  }
}
