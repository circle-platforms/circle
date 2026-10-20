import { webFetch, webSearch } from './websearch.js';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { glob } from 'glob';
import type { Tool, ToolContext } from './types.js';
import { Sandbox } from './sandbox.js';
import { loadToolPrompt } from './system_prompt.js';
import { applyPatch, patchFilePaths } from './apply_patch.js';
import { QUESTION_SCHEMA } from './questions.js';
import { JobRegistry, jobLine, jobNotice } from './jobs.js';
import { readTextWindow, readTextContentWindow } from './file_read.js';
import { FileMutationTools, type FileMutations } from './file_mutations.js';
import { mediaType, readMedia } from './media.js';
import { GREP_SCHEMA, grepSearch } from './grep_tool.js';
import { takeScreenshot, type ScreenshotOptions } from './screenshot.js';
export interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}
export interface ToolHooks {
  fileMutations?: FileMutations;
  jobs?: JobRegistry;
  jobOwner?: (context: ToolContext) => import('./jobs.js').JobOwner;
  /** Only the runtime may turn original arguments into public command display. */
  displayCommand?: (rawCommand: string, context: ToolContext) => string;
  todos?: (todos: Todo[]) => void;
  question?: (
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<string>;
  plan?: (enabled: boolean, context: ToolContext) => Promise<string>;
  task?: (
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<string>;
  skill?: (name: string, signal?: AbortSignal) => Promise<string>;
  compact?: (hint: string, context: ToolContext) => Promise<string>;
  /** Offer `screenshot`; tests give it their own runner. */
  screenshot?: Omit<ScreenshotOptions, 'app' | 'target'>;
  /**
   * Describes image files with the run's side vision model; adds the `vision` tool and
   * the picture descriptions of the tools above when set.
   */
  vision?: (
    paths: string[],
    question: string,
    context: ToolContext,
  ) => Promise<{ model: string; text: string }>;
}
const string = (args: Record<string, unknown>, ...keys: string[]): string => {
  for (const key of keys)
    if (typeof args[key] === 'string') return args[key] as string;
  throw new Error(`missing string parameter: ${keys.join(' / ')}`);
};
const schema = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const text = (description: string) => ({ type: 'string', description });
const integer = (description: string, minimum = 1) => ({
  type: 'integer',
  minimum,
  description,
});
export function buildTools(sandbox: Sandbox, hooks: ToolHooks = {}): Tool[] {
  const read = new Set<string>();
  const mutations = hooks.fileMutations
    ? new FileMutationTools(sandbox, hooks.fileMutations)
    : undefined;
  const tools: Tool[] = [];
  // A read as the desktop allows it: Circle's own offloaded output (history, large results,
  // job logs, saved pictures) is read directly, since it is never a workspace or granted
  // external file; anything else asks the native backend, and an external grant covers an
  // existing text file only. Without a native backend (the terminal) every read is allowed.
  const authorizeRead = async (
    path: string,
    context: ToolContext,
  ): Promise<FileMutationTools | undefined> => {
    const native = sandbox.isOffloadOutput(path) ? undefined : mutations;
    if (native) await native.authorize(path, context, 'read');
    if (
      native &&
      !sandbox.isInside(path) &&
      (statSync(path).isDirectory() || mediaType(path))
    )
      throw Error(
        'native external file grants support existing text files only',
      );
    return native;
  };
  // Plan mode's plan is Circle's own file in the data folder, as the offloaded output
  // read_file reads is: it is written directly, and the workspace's file backend, which
  // knows only granted files, has no part in it.
  const writesPlan = (tool: string, args: Record<string, unknown>): boolean => {
    try {
      const paths =
        tool === 'apply_patch'
          ? patchFilePaths(string(args, 'patchText'), sandbox)
          : [sandbox.resolvePath(string(args, 'file_path', 'path'))];
      return (
        paths.length > 0 && paths.every((path) => sandbox.isPlanFile(path))
      );
    } catch {
      return false;
    }
  };
  // What these write stays on disk: a %NAME% there is text, never a variable's value.
  const FILE_WRITERS = new Set(['write_file', 'edit_file', 'apply_patch']);
  // What these take becomes a model's input or the conversation's: a secret stays its name
  const MODEL_INPUT = new Set([
    'task',
    'question',
    'write_todos',
    'plan_enter',
    'plan_exit',
    'skill',
    'compact_conversation',
  ]);
  const add = (
    name: string,
    effect: Tool['effect'],
    parameters: Record<string, unknown>,
    run: Tool['run'],
  ): Tool => {
    const tool: Tool = {
      name,
      effect,
      parameters,
      description: loadToolPrompt(name),
      run,
      ...(FILE_WRITERS.has(name)
        ? { variables: false }
        : MODEL_INPUT.has(name)
          ? { variables: 'plain' as const }
          : {}),
    };
    tools.push(tool);
    return tool;
  };
  add(
    'read_file',
    'read',
    schema(
      {
        file_path: text('Path to read'),
        offset: {
          type: 'integer',
          default: 0,
          description:
            'Lines to skip, 0 indexed; negative values start at the first line',
        },
        limit: {
          type: 'integer',
          default: 2000,
          description: 'Maximum lines; non-positive values request no lines',
        },
      },
      ['file_path'],
    ),
    async (args, context) => {
      const path = sandbox.resolvePath(
        string(args, 'file_path', 'filePath', 'path'),
      );
      sandbox.checkCredentialPath(path);
      const native = await authorizeRead(path, context);
      if (statSync(path).isDirectory())
        return readdirSync(path, { withFileTypes: true })
          .map((entry) => entry.name + (entry.isDirectory() ? '/' : ''))
          .join('\n');
      if (mediaType(path)) {
        if (!context.emitAttachments)
          throw new Error('this caller does not accept media attachments');
        // A model that cannot read pictures gets the side vision model's words for one.
        // A PDF is no picture: it goes as an attachment, as it always did.
        if (
          context.imageInput === false &&
          hooks.vision &&
          mediaType(path) !== 'application/pdf'
        ) {
          try {
            const described = await hooks.vision([path], '', context);
            return `${path} as the side vision model ${described.model} describes it:\n\n${described.text}`;
          } catch (error) {
            context.signal.throwIfAborted();
            return `${path} is an image the model in use does not read, and the side vision model could not describe it: ${
              error instanceof Error ? error.message : String(error)
            }. The picture stays on disk.`;
          }
        }
        const { attachment, size } = await readMedia(path, context.signal);
        context.emitAttachments([attachment]);
        read.add(path);
        return `Read ${attachment.filename} (${attachment.mime_type}${size ? ', ' + size : ''}) as an attachment.`;
      }
      const offset = Math.max(0, Math.trunc(Number(args.offset ?? 0)));
      const limit = Math.max(0, Math.trunc(Number(args.limit ?? 2000)));
      const content = native
        ? readTextContentWindow(
            (await native.read(path, context)).content!,
            offset,
            limit,
          )
        : await readTextWindow(
            path,
            offset,
            limit,
            context.signal,
            sandbox.isJobOutput(path),
          );
      read.add(path);
      return content;
    },
  );
  add(
    'write_file',
    'write',
    schema(
      { file_path: text('Path to write'), content: text('File contents') },
      ['file_path', 'content'],
    ),
    async (args, context) => {
      if (mutations && !writesPlan('write_file', args))
        return (await mutations.prepareWrite(args, context))(args, context);
      const path = sandbox.resolvePath(string(args, 'file_path', 'path'));
      sandbox.checkMutablePath(path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, string(args, 'content'));
      return `Wrote ${path}`;
    },
  );
  add(
    'edit_file',
    'write',
    schema(
      {
        file_path: text('Path to edit'),
        old_string: text('Exact text to replace'),
        new_string: text('Replacement'),
        replace_all: { type: 'boolean' },
      },
      ['file_path', 'old_string', 'new_string'],
    ),
    async (args, context) => {
      if (mutations && !writesPlan('edit_file', args))
        return (await mutations.prepareEdit(args, context))(args, context);
      const path = sandbox.resolvePath(string(args, 'file_path', 'path'));
      sandbox.checkMutablePath(path);
      if (!read.has(path))
        throw new Error('read_file must be called before editing this file');
      const content = readFileSync(path, 'utf8');
      const old = string(args, 'old_string', 'oldString');
      const replacement = string(args, 'new_string', 'newString');
      if (!old) throw new Error('old_string cannot be empty');
      const count = content.split(old).length - 1;
      if (!count) throw new Error('oldString not found in content');
      if (count > 1 && !args.replace_all && !args.replaceAll)
        throw new Error(
          'Found multiple matches for oldString. Provide more surrounding lines or use replaceAll.',
        );
      writeFileSync(
        path,
        args.replace_all || args.replaceAll
          ? content.replaceAll(old, replacement)
          : content.replace(old, replacement),
      );
      return `Edited ${path}`;
    },
  );
  add(
    'apply_patch',
    'write',
    schema({ patchText: text('Patch in Begin Patch / End Patch format') }, [
      'patchText',
    ]),
    async (args, context) =>
      mutations && !writesPlan('apply_patch', args)
        ? (await mutations.preparePatch(args, context))(args, context)
        : applyPatch(string(args, 'patchText'), sandbox),
  );
  if (mutations)
    for (const [name, prepare] of [
      ['write_file', mutations.prepareWrite],
      ['edit_file', mutations.prepareEdit],
      ['apply_patch', mutations.preparePatch],
    ] as const) {
      const tool = tools.find((tool) => tool.name === name)!;
      // The plan file has nothing to snapshot: the tool writes it when it runs
      tool.prepare = async (args, context) =>
        writesPlan(name, args) ? tool.run : prepare(args, context);
    }
  add('ls', 'read', schema({ path: text('Directory') }), async (args) => {
    const path = sandbox.resolvePath(String(args.path || '.'));
    return readdirSync(path, { withFileTypes: true })
      .map((entry) => entry.name + (entry.isDirectory() ? '/' : ''))
      .join('\n');
  });
  add(
    'glob',
    'read',
    schema({ pattern: text('Glob pattern'), path: text('Search directory') }, [
      'pattern',
    ]),
    async (args) => {
      const cwd = sandbox.resolvePath(String(args.path || '.'));
      const matches = await glob(string(args, 'pattern'), {
        cwd,
        nodir: true,
        dot: true,
        ignore: ['**/.git/**', '**/node_modules/**'],
        follow: false,
      });
      return matches
        .sort()
        .slice(0, 5000)
        .map((path) => join(cwd, path))
        .join('\n');
    },
  );
  add('grep', 'read', GREP_SCHEMA, async (args, context) =>
    grepSearch(sandbox, args, context.signal),
  );
  add(
    'execute',
    'execute',
    schema(
      {
        command: text('Shell command'),
        timeout: integer(
          'Timeout in seconds; 0 disables a background deadline',
          0,
        ),
        background: {
          type: 'boolean',
          description:
            'Run as a background job; a notice arrives when it ends. Do not poll or sleep.',
        },
      },
      ['command'],
    ),
    async (args, context) => {
      if (hooks.jobs) {
        const notificationOwner = hooks.jobOwner?.(context) ?? {
          sessionId: context.sessionId,
          startedBy: 'model' as const,
        };
        const rawCommand = context.rawArgs?.command;
        const owner = {
          ...notificationOwner,
          origin: {
            executionSessionId: context.sessionId,
            toolCallId: context.callId,
            ...(typeof rawCommand === 'string' && hooks.displayCommand
              ? { displayCommand: hooks.displayCommand(rawCommand, context) }
              : {}),
            ...(context.secretNames
              ? { secretNames: [...context.secretNames] }
              : {}),
          },
        };
        const command = string(args, 'command');
        if (args.background === true) {
          context.signal.throwIfAborted();
          const job = await hooks.jobs.startShell(
            command,
            owner,
            args.timeout === undefined ? undefined : Number(args.timeout),
            context.signal,
          );
          return `In background: ${jobLine(job)}. A notice will arrive when it ends; do not poll or sleep.`;
        }
        const result = await hooks.jobs.execute(
          command,
          owner,
          context.signal,
          args.timeout === undefined ? undefined : Number(args.timeout),
        );
        return result.job
          ? result.output
          : `${result.output}\nExit code: ${result.exit_code}`;
      }
      if (args.background === true)
        throw new Error('background commands are not available here');
      const result = await sandbox.execute(
        string(args, 'command'),
        context.signal,
        Math.max(1, Number(args.timeout) || 120) * 1000,
      );
      return `${result.output}\nExit code: ${result.exit_code}`;
    },
  );
  if (hooks.jobs) {
    add('list_jobs', 'read', schema({}), async (_args, context) => {
      const owner = hooks.jobOwner?.(context) ?? {
        sessionId: context.sessionId,
      };
      const mine = hooks.jobs!.list(owner.sessionId);
      const others = hooks
        .jobs!.list()
        .filter(
          (job) =>
            job.sessionId !== owner.sessionId && job.status === 'running',
        );
      return (
        (mine.map(jobLine).join('\n') ||
          'No background jobs in this conversation.') +
        (others.length
          ? `\n${others.length} more running in other conversations.`
          : '')
      );
    });
    add(
      'stop_job',
      'read',
      schema({ job_id: text('Job id, such as j3') }, ['job_id']),
      async (args) => {
        const id = string(args, 'job_id');
        await hooks.jobs!.stop(id);
        return `Stopped ${id}.`;
      },
    );
    tools.at(-1)!.approval = false;
    add(
      'wait_jobs',
      'read',
      schema(
        {
          job_ids: { type: 'array', items: { type: 'string' } },
          timeout_s: { type: 'integer', minimum: 1, maximum: 600 },
        },
        ['job_ids'],
      ),
      async (args, context) => {
        const jobs = await hooks.jobs!.wait(
          args.job_ids as string[],
          Number(args.timeout_s) || 300,
          context.signal,
        );
        const ended = jobs.filter((job) => job.status !== 'running');
        const owner = hooks.jobOwner?.(context) ?? {
          sessionId: context.sessionId,
        };
        hooks.jobs!.takeNotices(
          owner.sessionId,
          ended.map((job) => job.id),
        );
        return ended.length
          ? ended.map(jobNotice).join('\n\n') +
              (jobs.some((job) => job.status === 'running')
                ? '\nStill running: ' +
                  jobs
                    .filter((job) => job.status === 'running')
                    .map((job) => job.id)
                    .join(', ')
                : '')
          : 'Still running: ' + jobs.map(jobLine).join('\n');
      },
    );
  }
  add(
    'write_todos',
    'read',
    schema(
      {
        todos: {
          type: 'array',
          items: schema(
            {
              content: text('Step'),
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
              },
            },
            ['content', 'status'],
          ),
        },
      },
      ['todos'],
    ),
    async (args) => {
      if (
        !Array.isArray(args.todos) ||
        args.todos.some(
          (todo) =>
            typeof todo?.content !== 'string' ||
            !['pending', 'in_progress', 'completed'].includes(todo.status),
        )
      )
        throw new Error('invalid todo list');
      hooks.todos?.(args.todos as Todo[]);
      return 'Updated todo list.';
    },
  );
  if (hooks.question) add('question', 'read', QUESTION_SCHEMA, hooks.question);
  if (hooks.plan) {
    add('plan_enter', 'read', schema({}), async (_args, context) =>
      hooks.plan!(true, context),
    );
    add('plan_exit', 'read', schema({}), async (_args, context) =>
      hooks.plan!(false, context),
    );
  }
  if (hooks.task)
    add(
      'task',
      'read',
      // As in deepagents' task schema, both fields are required.
      schema(
        {
          description: text(
            'A detailed description of the task for the subagent to perform autonomously. ' +
              'Include all necessary context and specify the expected output format.',
          ),
          subagent_type: text(
            'The type of subagent to use. Must be one of the available agent types listed in the tool description.',
          ),
          background: {
            type: 'boolean',
            description:
              'Run the subagent in the background and return at once with a job id; ' +
              'Circle adds its report when it ends. For independent work you do not ' +
              'need before your next step.',
          },
        },
        ['description', 'subagent_type'],
      ),
      hooks.task,
    );
  if (hooks.skill)
    add(
      'skill',
      'read',
      schema({ name: text('Skill name') }, ['name']),
      async (args, context) =>
        hooks.skill!(string(args, 'name'), context.signal),
    );
  if (hooks.compact)
    add(
      'compact_conversation',
      'read',
      schema({ hint: text('Summary guidance') }),
      async (args, context) => hooks.compact!(String(args.hint || ''), context),
    );
  add(
    'webfetch',
    'read',
    schema(
      {
        url: text('URL to fetch'),
        format: { type: 'string', enum: ['markdown', 'text', 'html'] },
      },
      ['url'],
    ),
    async (args, context) =>
      webFetch(
        string(args, 'url'),
        String(args.format || 'markdown'),
        context.signal,
      ),
  );
  add(
    'websearch',
    'read',
    schema(
      {
        query: text('Search query'),
        num_results: { type: 'integer', minimum: 1, maximum: 10 },
      },
      ['query'],
    ),
    async (args, context) =>
      context.webSearch
        ? context.webSearch(
            string(args, 'query'),
            Number(args.num_results) || 5,
          )
        : webSearch(
            string(args, 'query'),
            context.signal,
            Number(args.num_results) || 5,
          ),
  );
  if (hooks.screenshot) {
    const screenshot = add(
      'screenshot',
      'execute',
      schema({
        app: text(
          'Name of the application whose front window to take, such as "Safari"; leave out for the whole main screen',
        ),
      }),
      async (args, context) => {
        const app =
          typeof args.app === 'string' && args.app.trim()
            ? args.app.trim()
            : undefined;
        const folder = join(sandbox.offloadRoot ?? tmpdir(), 'screenshots');
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        const target = join(
          folder,
          new Date().toISOString().replace(/[:.]/g, '-') + '.png',
        );
        // Nothing is taken for a model that could not look at it, unless the side vision
        // model will describe what was taken
        if (context.imageInput === false && !hooks.vision)
          throw new Error(
            'the model in use does not read images; no side vision model is configured (CIRCLE_VISION_BASE_URL, CIRCLE_VISION_KEY, CIRCLE_VISION_MODEL)',
          );
        const of = app ? `the front window of ${app}` : 'the main screen';
        const hint = await takeScreenshot({
          ...hooks.screenshot,
          app,
          target,
          signal: context.signal,
        });
        if (context.imageInput === false) {
          const saved =
            `Screenshot of ${of} saved as ${target}.` +
            (hint ? `\n${hint}` : '');
          try {
            const described = await hooks.vision!(
              [target],
              `This is a screenshot of ${of}. Describe the applications, windows and text a coding agent would care about.`,
              context,
            );
            return `${saved}\nDescribed by the side vision model ${described.model}:\n${described.text}`;
          } catch (error) {
            context.signal.throwIfAborted();
            return `${saved}\nThe side vision model could not describe it: ${
              error instanceof Error ? error.message : String(error)
            }`;
          }
        }
        if (!context.emitAttachments)
          throw new Error('this caller does not accept media attachments');
        const { attachment, size } = await readMedia(target, context.signal);
        context.emitAttachments([attachment]);
        return (
          `Screenshot of ${of} (${size}), saved as ${target}.` +
          (hint ? `\n${hint}` : '')
        );
      },
    );
    // The card says who sees the picture: for a model that cannot read images the side
    // vision model does, and the model gets its words
    if (hooks.vision)
      screenshot.approvalFacts = (_args, _sessionId, _shown, imageInput) =>
        imageInput === false ? { seen_by: 'side vision model' } : undefined;
  }
  if (hooks.vision)
    add(
      'vision',
      'read',
      schema(
        {
          path: text('Path to the picture to describe'),
          question: text(
            'What to look for and report; the side vision model answers only this',
          ),
        },
        ['path'],
      ),
      async (args, context) => {
        const path = sandbox.resolvePath(
          string(args, 'path', 'file_path', 'filePath'),
        );
        sandbox.checkCredentialPath(path);
        const type = mediaType(path);
        if (!type) throw new Error('not a picture file');
        if (type === 'application/pdf')
          throw new Error('the vision model reads pictures, not PDFs');
        // What read_file may not read does not go to the side vision model either
        await authorizeRead(path, context);
        if (!statSync(path).isFile()) throw new Error(`no such file: ${path}`);
        const described = await hooks.vision!(
          [path],
          typeof args.question === 'string' ? args.question : '',
          context,
        );
        return `${path} as the side vision model ${described.model} describes it:\n\n${described.text}`;
      },
    );
  add(
    'delete',
    'write',
    schema({ file_path: text('Path to delete') }, ['file_path']),
    async (args, context) => {
      context.signal.throwIfAborted();
      const path = sandbox.resolvePath(string(args, 'file_path', 'path'));
      sandbox.checkMutablePath(path);
      rmSync(path, { recursive: true });
      return `Deleted ${path}`;
    },
  );

  return tools;
}
