import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  prepareWorkflowScript,
  WorkflowScriptError,
  type WorkflowMeta,
} from './workflow_script.js';

/** One saved workflow: a script file a project, the person or an installed pack keeps. */
export interface WorkflowFile {
  /** The name it runs by: `meta.name`, or `<pack>:<meta.name>` for a pack's. */
  name: string;
  meta: WorkflowMeta;
  path: string;
  source_label: string;
  pack?: string;
}
/** What was found, and why a file was passed over. */
export interface WorkflowSources {
  workflows: WorkflowFile[];
  problems: string[];
}

/** The folders saved workflows are read from, lowest priority first: a project's replaces your own of the same name. */
export function workflowFolders(
  workspace: string,
  home: string,
): [string, string][] {
  return [
    [join(home, 'workflows'), 'Circle'],
    [join(workspace, '.circle', 'workflows'), 'Project Circle'],
  ];
}

/** The `.js` files of one folder, each a workflow by its meta, and why any is passed over. */
export function readWorkflowFolder(
  root: string,
  label: string,
  pack?: string,
): WorkflowSources {
  const workflows: WorkflowFile[] = [];
  const problems: string[] = [];
  let names: string[];
  try {
    names = readdirSync(root)
      .filter((name) => name.endsWith('.js'))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return { workflows, problems };
  }
  const taken = new Set<string>();
  for (const file of names) {
    const path = join(root, file);
    let source: string;
    try {
      if (!statSync(path).isFile()) continue;
      source = readFileSync(path, 'utf8');
    } catch (error) {
      problems.push(`${path}: cannot be read (${String(error)})`);
      continue;
    }
    let meta: WorkflowMeta;
    try {
      ({ meta } = prepareWorkflowScript(source, path));
    } catch (error) {
      problems.push(
        error instanceof WorkflowScriptError
          ? error.message.startsWith(path)
            ? error.message
            : `${path}: ${error.message}`
          : `${path}: ${String(error)}`,
      );
      continue;
    }
    const name = pack ? `${pack}:${meta.name}` : meta.name;
    if (taken.has(name)) {
      problems.push(
        `${path}: another file in ${root} is the workflow '${name}'`,
      );
      continue;
    }
    taken.add(name);
    workflows.push({
      name,
      meta,
      path: existsSync(path) ? realpathSync(path) : path,
      source_label: label,
      ...(pack ? { pack } : {}),
    });
  }
  return { workflows, problems };
}

/**
 * The saved workflows: your own in the data folder's `workflows/`, the project's in
 * `.circle/workflows/` (which wins on a shared name), and each installed pack's `workflows/`,
 * named `<pack>:<name>`. A folder without a `pack.json` is no pack.
 */
export function discoverWorkflows(options: {
  workspace: string;
  home: string;
  packsRoot?: string;
}): WorkflowSources {
  const byName = new Map<string, WorkflowFile>();
  const problems: string[] = [];
  for (const [root, label] of workflowFolders(
    options.workspace,
    options.home,
  )) {
    const found = readWorkflowFolder(root, label);
    for (const workflow of found.workflows) byName.set(workflow.name, workflow);
    problems.push(...found.problems);
  }
  let packs: string[] = [];
  try {
    packs = options.packsRoot ? readdirSync(options.packsRoot).sort() : [];
  } catch {
    /* No packs installed. */
  }
  for (const pack of packs) {
    const folder = join(options.packsRoot!, pack, 'workflows');
    if (
      !existsSync(join(options.packsRoot!, pack, 'pack.json')) ||
      !existsSync(folder)
    )
      continue;
    const found = readWorkflowFolder(folder, `Pack ${pack}`, pack);
    for (const workflow of found.workflows)
      if (!byName.has(workflow.name)) byName.set(workflow.name, workflow);
    problems.push(...found.problems);
  }
  return {
    workflows: [...byName.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
    problems,
  };
}
