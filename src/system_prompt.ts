import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import { currentBranch } from './git_info.js';
import type { RunOptions } from './run_options.js';
import { formatMemorySources, readCappedText } from './memory_sources.js';
const prompts = fileURLToPath(new URL('./prompts/', import.meta.url));
export function readPrompt(...parts: string[]): string {
  return readFileSync(join(prompts, ...parts), 'utf8').trim();
}
export function loadToolPrompt(name: string): string {
  const path = join(prompts, 'tools', name + '.md');
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : name;
}
export function selectSessionPromptName(model: string): string {
  const name = model.toLowerCase();
  if (name.includes('muse')) return 'meta';
  if (name.includes('beast')) return 'beast';
  if (name.includes('gpt'))
    return name.includes('gpt-6')
      ? 'gpt-astra'
      : name.includes('codex')
        ? 'codex'
        : name.includes('copilot') && name.includes('gpt-5')
          ? 'copilot-gpt-5'
          : 'gpt';
  if (/^o[13]|\/o[13]/.test(name)) return 'gpt';
  if (/gemini/.test(name)) return 'gemini';
  if (/claude|anthropic|sonnet|opus|haiku/.test(name)) return 'anthropic';
  if (name.includes('trinity')) return 'trinity';
  if (/kimi|moonshot/.test(name)) return 'kimi';
  return 'default';
}
export function discoverContextFiles(workspace: string): [string, string][] {
  const files: [string, string][] = [];
  const seen = new Set<string>();
  const root = resolve(workspace);
  for (let directory = root; ; directory = dirname(directory)) {
    for (const name of [
      'AGENTS.override.md',
      'AGENTS.md',
      'AGENTS.MD',
      'CLAUDE.md',
      'CLAUDE.MD',
    ]) {
      const path = join(directory, name);
      try {
        // bigint: see fileIdentity in memory_sources.ts
        const stat = statSync(path, { bigint: true });
        const identity = `${stat.dev}:${stat.ino}`;
        if (!stat.isFile() || seen.has(identity)) continue;
        seen.add(identity);
        files.push([path, readCappedText(path)]);
      } catch {
        /* No instruction file here. */
      }
    }
    if (
      dirname(directory) === directory ||
      (existsSync(join(directory, '.git')) && directory !== root)
    )
      break;
  }
  return files;
}
function sessionPrompt(model: string): string {
  let session = readPrompt('session', selectSessionPromptName(model) + '.md')
    .replaceAll('{{MODEL_NAME}}', model)
    .replaceAll('You are circle,', 'You are Circle,')
    .replaceAll('trained by Meta MSL', 'used by Circle');
  for (const [from, to] of [
    ['TodoWrite', 'write_todos'],
    ['WebFetch', 'webfetch'],
    ['WebSearch', 'websearch'],
    ['`Bash`', '`execute`'],
    ['`Read`', '`read_file`'],
    ['`Write`', '`write_file`'],
    ['`Edit`', '`edit_file`'],
    ['`Glob`', '`glob`'],
    ['`Grep`', '`grep`'],
  ])
    session = session.replaceAll(from!, to!);
  // Worked examples are long and untested. The rules above them stay.
  return session
    .replace(/<example>[\s\S]*?<\/example>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
// `.circle/<name>` in the project, else `<name>` in the data folder, as 0.5.0 read them.
function promptFile(
  workspace: string,
  home: string | undefined,
  name: string,
): string | undefined {
  for (const path of [
    join(workspace, '.circle', name),
    ...(home ? [join(home, name)] : []),
  ]) {
    try {
      if (statSync(path).isFile()) return readFileSync(path, 'utf8');
    } catch {
      /* Missing or unreadable: try the next one. */
    }
  }
  return undefined;
}
/** Circle's own instructions replaced, and the text added at the end: what the command
 * line gave, else SYSTEM.md and APPEND_SYSTEM.md (the project's `.circle` folder first,
 * then the data folder). */
export function promptOverrides(
  workspace: string,
  home: string | undefined,
  options: Pick<RunOptions, 'system_prompt' | 'append_system_prompt'>,
): { base?: string; append: string[] } {
  const base =
    options.system_prompt !== undefined
      ? options.system_prompt
      : promptFile(workspace, home, 'SYSTEM.md');
  const append = options.append_system_prompt.length
    ? options.append_system_prompt
    : [promptFile(workspace, home, 'APPEND_SYSTEM.md') ?? ''];
  return {
    base: base?.trim() ? base.trim() : undefined,
    append: append.filter((text) => text.trim()).map((text) => text.trim()),
  };
}
export interface PromptCatalog {
  userHome?: string;
  localContext?: boolean;
  skills?: { name: string; description: string }[];
  extensionTools?: { name: string; description: string }[];
  /** The user's variables, values included. */
  variables?: Record<string, string>;
  /** Names of the saved secrets: the model never sees a value. */
  secrets?: string[];
}
export function buildSystemPrompt(
  workspace: string,
  model: string,
  protocol: string,
  options: RunOptions,
  home?: string,
  catalog: PromptCatalog = {},
): string {
  const { base, append } =
    catalog.localContext === false
      ? { base: undefined, append: [] }
      : promptOverrides(workspace, home, options);
  const sections = base
    ? [base]
    : [
        sessionPrompt(model),
        readPrompt('circle_guidelines.md'),
        readPrompt('circle_paths.md'),
      ];
  const files =
    options.no_context_files || catalog.localContext === false
      ? []
      : discoverContextFiles(workspace);
  if (!options.no_context_files) {
    if (files.length)
      sections.push(
        '<project_context>\n' +
          files
            .map(
              ([path, text]) =>
                `<project_instructions path="${path}">\n${text}\n</project_instructions>`,
            )
            .join('\n\n') +
          '\n</project_context>',
      );
  }
  const memory =
    catalog.localContext === false
      ? ''
      : formatMemorySources(
          workspace,
          home,
          files.map(([path]) => path),
          options.no_context_files,
          catalog.userHome,
        );
  if (memory) sections.push(memory);
  // The model otherwise probes for AGENTS.md beside a README read, and the
  // missing file shows up as a failed read_file. These files are already in
  // the prompt when they exist.
  if (!options.no_context_files && catalog.localContext !== false)
    sections.push(
      'Do not call read_file to discover instruction files (AGENTS.md, CLAUDE.md, AGENTS.override.md, MEMORY.md). Any of those that exist are already included in this prompt.',
    );
  sections.push(
    `<env>\n  Working directory: ${workspace}\n  Platform: ${platform()}\n  Today's date: ${new Date().toISOString().slice(0, 10)}\n  Is directory a git repo: ${currentBranch(workspace) ? 'yes' : 'no'}\n  Model: ${model}\n  Protocol: ${protocol}\n</env>`,
  );
  sections.push(...append);
  if (catalog.skills?.length)
    sections.push(
      'Available skills:\n' +
        catalog.skills
          .map((skill) => `- ${skill.name}: ${skill.description}`)
          .join('\n'),
    );
  const variables = Object.entries(catalog.variables ?? {});
  if (variables.length || catalog.secrets?.length)
    sections.push(
      '<variables>\n' +
        "Variables the user keeps in Circle. Write %NAME% in a tool's arguments (a command, a browser field, an MCP tool's input) and Circle puts the value in when the tool runs. Files you write keep %NAME% as text." +
        (variables.length
          ? '\n' +
            variables.map(([name, value]) => `- ${name} = ${value}`).join('\n')
          : '') +
        (catalog.secrets?.length
          ? `\nSecrets, which you know only by name: ${catalog.secrets.join(', ')}. Use them the same way; where a tool's output has a secret's value you read %NAME% instead, unless that value is text you or the user wrote in this conversation.`
          : '') +
        '\n</variables>',
    );
  if (catalog.extensionTools?.length)
    sections.push(
      'Extension tools:\n' +
        catalog.extensionTools
          .map((tool) => `${tool.name}: ${tool.description}`)
          .join('\n'),
    );
  return sections.join('\n\n');
}
