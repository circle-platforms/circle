import { installedPersonalPacks } from './knowledge/packs.js';
import { DEFAULT_CREDENTIAL_FILES, matchPattern } from './file_patterns.js';
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  type Dirent,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  source_label: string;
  personal_home?: string;
  allowed_tools?: string[];
  disallowed_tools?: string[];
}

export function splitFrontmatter(text: string): {
  block?: string;
  body: string;
} {
  const match = text.match(
    /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[^\r\n]*(?:\r?\n|$)/,
  );
  return match
    ? { block: match[1] ?? '', body: text.slice(match[0].length) }
    : { body: text };
}

const unquoted = (text: string): string => text.replace(/^['"]|['"]$/g, '');

function listItem(text: string): string {
  const quoted = text.match(/^(['"])(.*?)\1(?:\s+#.*)?$/);
  return quoted ? quoted[2]! : text.replace(/\s+#.*$/, '').trim();
}

export function splitOutside(
  raw: string,
  separator: (char: string) => boolean,
): string[] {
  const parts: string[] = [];
  let part = '';
  let depth = 0;
  for (const char of raw) {
    if (char === '(') depth++;
    else if (char === ')' && depth > 0) depth--;
    if (depth === 0 && separator(char)) {
      if (part.trim()) parts.push(part.trim());
      part = '';
    } else part += char;
  }
  if (part.trim()) parts.push(part.trim());
  return parts;
}

export function splitToolList(raw: string): string[] {
  return [
    ...new Set(splitOutside(raw, (char) => char === ',' || /\s/.test(char))),
  ];
}

export function parseFrontmatter(text: string): {
  meta: Record<string, string>;
  lists: Record<string, string[]>;
  body: string;
} {
  const { block, body } = splitFrontmatter(text);
  if (block === undefined) return { meta: {}, lists: {}, body: text };
  const meta: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    // Only top-level keys belong to frontmatter metadata; indented keys belong to nested blocks such as hooks.
    const entry = line.match(/^([^:\s][^:]*):\s*(.*)$/);
    if (!entry) continue;
    const key = entry[1]!.trim().toLowerCase();
    const value = entry[2]!.trim();
    if (/^[>|][-+]?$/.test(value)) {
      const folded: string[] = [];
      while (
        i + 1 < lines.length &&
        (/^\s/.test(lines[i + 1]!) || !lines[i + 1]!.trim())
      )
        folded.push(lines[++i]!);
      meta[key] = value.startsWith('>')
        ? folded
            .map((item) => item.trim())
            .filter(Boolean)
            .join(' ')
        : folded.join('\n').trim();
      continue;
    }
    if (!value) {
      const items: string[] = [];
      let next = i;
      while (next + 1 < lines.length) {
        const following = lines[next + 1]!;
        const item = following.match(/^\s*-(?:\s+(.*))?$/);
        if (item) items.push(listItem((item[1] ?? '').trim()));
        else if (following.trim() && !following.trimStart().startsWith('#'))
          break;
        next++;
      }
      if (items.length) {
        lists[key] = items.filter(Boolean);
        meta[key] = '';
        i = next;
        continue;
      }
    }
    const flow = value.match(/^\[(.*)\]$/);
    if (flow)
      lists[key] = splitOutside(flow[1]!, (char) => char === ',').map(listItem);
    meta[key] = unquoted(value);
  }
  return { meta, lists, body };
}

function toolEntries(
  meta: Record<string, string>,
  lists: Record<string, string[]>,
  key: string,
): string[] | undefined {
  const entries = [
    ...new Set((lists[key] ?? [meta[key] ?? '']).flatMap(splitToolList)),
  ];
  return entries.length ? entries : undefined;
}

export function builtinSkillsRoot(): string {
  return fileURLToPath(new URL('./builtin_skills/', import.meta.url));
}

export const BUILTIN_SKILL_SOURCE = 'Built-in';

export function skillSources(
  workspace: string,
  home: string,
  userHome = homedir(),
  builtin: string | false = builtinSkillsRoot(),
): [string, string][] {
  const sources: [string, string][] = [
    ...(builtin ? [[builtin, BUILTIN_SKILL_SOURCE] as [string, string]] : []),
    [join(userHome, '.agents/skills'), 'Agents'],
    [join(userHome, '.claude/skills'), 'Claude'],
    [join(userHome, '.config/opencode/skills'), 'OpenCode'],
    [join(userHome, '.pi/agent/skills'), 'Pi'],
    [join(home, 'skills'), 'Circle'],
  ];
  for (const [path, label] of [
    ['.agents/skills', 'Project Agents'],
    ['.opencode/skills', 'Project OpenCode'],
    ['.pi/skills', 'Project Pi'],
    ['.claude/skills', 'Project Claude'],
    ['.circle/skills', 'Project Circle'],
    ['.agent/skills', 'Project'],
  ])
    sources.push([join(workspace, path!), label!]);
  const unique = new Map<string, string>();
  for (const [path, label] of sources)
    try {
      if (statSync(path).isDirectory()) unique.set(realpathSync(path), label);
    } catch {
      /* Missing skill root. */
    }
  return [...unique];
}

function folders(directory: string): string[] {
  let found: Dirent[];
  try {
    found = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return found
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .filter((name) => {
      try {
        return statSync(join(directory, name)).isDirectory();
      } catch {
        return false;
      }
    });
}

export function discoverSkills(
  workspace: string,
  home: string,
  userHome = homedir(),
  builtin: string | false = builtinSkillsRoot(),
): SkillInfo[] {
  const byName = new Map<string, SkillInfo>(
    installedPersonalPacks(home).map((pack) => [
      pack.name,
      {
        name: pack.name,
        description: pack.manifest.description,
        path: pack.path,
        source_label: 'Personal pack',
        personal_home: home,
      },
    ]),
  );
  for (const [root, label] of skillSources(
    workspace,
    home,
    userHome,
    builtin,
  )) {
    const directories: string[] = [];
    for (const child of folders(root)) {
      const directory = join(root, child);
      if (existsSync(join(directory, 'SKILL.md'))) directories.push(directory);
      else
        for (const nested of folders(directory))
          if (existsSync(join(directory, nested, 'SKILL.md')))
            directories.push(join(directory, nested));
    }
    for (const directory of directories) {
      let path: string;
      let text: string;
      try {
        path = realpathSync(join(directory, 'SKILL.md'));
        text = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      const { meta, lists } = parseFrontmatter(text);
      let name = (meta.name || basename(directory)).toLowerCase().trim();
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
        name = basename(directory)
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 64);
      if (name) {
        const allowed = toolEntries(meta, lists, 'allowed-tools');
        const disallowed = toolEntries(meta, lists, 'disallowed-tools');
        byName.set(name, {
          name,
          description: (
            meta.description || `Skill from ${basename(directory)}`
          ).slice(0, 1024),
          path,
          source_label: label,
          ...(allowed ? { allowed_tools: allowed } : {}),
          ...(disallowed ? { disallowed_tools: disallowed } : {}),
        });
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findSkill(
  name: string,
  catalog: SkillInfo[],
): SkillInfo | undefined {
  return catalog.find((skill) => skill.name === name.trim().toLowerCase());
}

export function loadSkillBody(
  name: string,
  catalog: SkillInfo[],
  reference?: string,
  credentialFiles: readonly string[] = DEFAULT_CREDENTIAL_FILES,
): string {
  const skill = findSkill(name, catalog);
  if (!skill)
    throw new Error(
      `skill '${name}' not found. Available: ${catalog.map((skill) => skill.name).join(', ') || '(none)'}`,
    );
  if (
    skill.source_label === 'Personal pack' &&
    !installedPersonalPacks(skill.personal_home!).some(
      (pack) => pack.path === skill.path,
    )
  )
    throw new Error('personal pack changed, disabled or unavailable');
  let path = skill.path;
  if (reference !== undefined) {
    if (isAbsolute(reference) || reference.split(/[/\\]/).includes('..'))
      throw Error('reference must stay inside the skill references directory');
    const root = realpathSync(dirname(skill.path));
    path = realpathSync(resolve(root, 'references', reference));
    const rel = relative(root, path);
    if (isAbsolute(rel) || !rel.startsWith('references' + sep))
      throw Error('reference must stay inside the skill references directory');
    if (
      [basename(reference), basename(path)].some((name) =>
        credentialFiles.some((pattern) =>
          matchPattern(pattern, name, process.platform !== 'linux'),
        ),
      )
    )
      throw Error('skill reference is a credential file');
  }
  const text = readFileSync(path, 'utf8')
    .trim()
    .replaceAll('${CIRCLE_SKILL_DIR}', dirname(skill.path));
  return `<skill_content name="${skill.name}">\n${text}\n\nBase directory for this skill: ${dirname(skill.path)}\nRelative paths in this skill are relative to this base directory.\n</skill_content>`;
}
