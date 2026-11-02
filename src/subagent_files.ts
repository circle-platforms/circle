import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseFrontmatter } from './skills.js';
import type { SubagentSpec } from './extensions.js';

/** One subagent defined by a markdown file. */
export interface SubagentFileInfo {
  spec: SubagentSpec;
  /** The tool names the file lists; undefined means the default set. */
  tools?: string[];
  path: string;
  source_label: string;
}

/** What was found, and why a file was passed over. */
export interface SubagentSources {
  agents: SubagentFileInfo[];
  problems: string[];
}

// Lowest priority first: a later folder replaces an earlier one of the same name, so a
// project's agent beats your own, as it does for skills. Extensions come last of all and
// are merged by the runtime.
export function subagentSources(
  workspace: string,
  home: string,
  userHome = homedir(),
): [string, string][] {
  const sources: [string, string][] = [
    [join(userHome, '.agents/agents'), 'Agents'],
    [join(userHome, '.claude/agents'), 'Claude'],
    [join(home, 'agents'), 'Circle'],
  ];
  for (const [path, label] of [
    ['.agents/agents', 'Project Agents'],
    ['.claude/agents', 'Project Claude'],
    ['.circle/agents', 'Project Circle'],
  ] as const)
    sources.push([join(workspace, path), label]);
  const unique = new Map<string, string>();
  for (const [path, label] of sources)
    try {
      if (statSync(path).isDirectory()) unique.set(realpathSync(path), label);
    } catch {
      /* No agents folder here. */
    }
  return [...unique];
}

const NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** The files in one folder, by name, ignoring everything else. */
function markdownFiles(directory: string): string[] {
  let found: string[];
  try {
    found = readdirSync(directory);
  } catch {
    return [];
  }
  return found
    .filter((name) => name.toLowerCase().endsWith('.md'))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Read the folders of agent definitions. A file that cannot be used is reported in
 * `problems` rather than dropped quietly, so `/agents` can say what is wrong with it.
 */
export function discoverSubagents(
  workspace: string,
  home: string,
  userHome = homedir(),
): SubagentSources {
  const agents: SubagentFileInfo[] = [];
  const problems: string[] = [];
  for (const [root, label] of subagentSources(workspace, home, userHome)) {
    const takenHere = new Set<string>();
    for (const file of markdownFiles(root)) {
      const path = join(root, file);
      let text: string;
      try {
        if (!statSync(path).isFile()) continue;
        text = readFileSync(path, 'utf8');
      } catch (error) {
        problems.push(`${path}: cannot be read (${String(error)})`);
        continue;
      }
      const { meta, body } = parseFrontmatter(text);
      const stem = file.replace(/\.md$/i, '');
      const claimed = (meta.name || stem).trim();
      if (!NAME.test(claimed)) {
        problems.push(
          `${path}: '${claimed}' is not a name (letters, digits, _ and -, up to 64)`,
        );
        continue;
      }
      if (takenHere.has(claimed)) {
        problems.push(`${path}: two files in ${root} claim '${claimed}'`);
        continue;
      }
      const description = (meta.description || '').trim();
      if (!description) {
        problems.push(`${path}: no description`);
        continue;
      }
      const prompt = body.trim();
      if (!prompt) {
        problems.push(`${path}: no prompt after the --- lines`);
        continue;
      }
      const listed = (meta.tools || '')
        .split(/[,;\s]+/)
        .map((word) => word.trim())
        .filter(Boolean);
      takenHere.add(claimed);
      agents.push({
        spec: {
          name: claimed,
          description: description.slice(0, 1024),
          system_prompt: prompt,
          ...(meta.model?.trim() ? { model: meta.model.trim() } : {}),
        },
        ...(meta.tools?.trim() ? { tools: listed } : {}),
        path: existsSync(path) ? realpathSync(path) : path,
        source_label: label,
      });
    }
  }
  // Later folders replace earlier ones, in the order the folders are read.
  const byName = new Map<string, SubagentFileInfo>();
  for (const agent of agents) byName.set(agent.spec.name, agent);
  return { agents: [...byName.values()], problems };
}
