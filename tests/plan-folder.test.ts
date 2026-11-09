import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { FileMutations } from '../src/file_mutations.js';
import { projectDataDir } from '../src/paths.js';
import { AgentRuntime } from '../src/runtime.js';
import { Sandbox } from '../src/sandbox.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { buildTools } from '../src/tools.js';
import { emptyUsage, type ToolContext } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

const context: ToolContext = {
  sessionId: 's',
  signal: new AbortController().signal,
};
const refusal =
  "/session_plans/ holds only this conversation's plan, /session_plans/own-session.md. Write other documents into the workspace, where the person can open, review and commit them.";

// The plan folder of a conversation whose plan is /session_plans/own-session.md, with the
// tools the terminal has and the tools the desktop has (its backend knows only the workspace)
function world(t: TestContext, desktop: boolean) {
  const workspace = realpathSync.native(scratch(t));
  const offload = realpathSync.native(scratch(t));
  const sandbox = new Sandbox(workspace, offload);
  sandbox.ownPlan = () => ({
    file: '/session_plans/own-session.md',
    path: sandbox.resolvePath('/session_plans/own-session.md'),
  });
  const backend: FileMutations = {
    authorize() {
      throw Error('the backend has no part in the plan folder');
    },
    async read() {
      throw Error('not used');
    },
    async apply() {
      throw Error('not used');
    },
  };
  const tools = buildTools(sandbox, desktop ? { fileMutations: backend } : {});
  const run = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find((item) => item.name === name)!;
    const ready = tool.prepare ? await tool.prepare(args, context) : tool.run;
    return ready(args, context);
  };
  return { folder: join(offload, 'session_plans'), run };
}

for (const desktop of [false, true])
  test(`the plan folder takes only the conversation's own plan (${desktop ? 'desktop' : 'terminal'})`, async (t) => {
    const { folder, run } = world(t, desktop);
    // Another document there is refused, whichever tool writes it, and nothing is written
    await assert.rejects(
      run('write_file', {
        file_path: '/session_plans/proposal-review.md',
        content: '# Review\n',
      }),
      { message: refusal },
    );
    await assert.rejects(
      run('apply_patch', {
        patchText:
          '*** Begin Patch\n*** Add File: /session_plans/threat-proposal.md\n+# Threats\n*** End Patch',
      }),
      { message: refusal },
    );
    // Another conversation's plan is not this one's either
    await assert.rejects(
      run('write_file', {
        file_path: '/session_plans/other-session.md',
        content: '# Not mine\n',
      }),
      { message: refusal },
    );
    assert.equal(existsSync(join(folder, 'proposal-review.md')), false);
    assert.equal(existsSync(join(folder, 'threat-proposal.md')), false);
    assert.equal(existsSync(join(folder, 'other-session.md')), false);
    // The conversation's own plan is written and edited as before
    await run('write_file', {
      file_path: '/session_plans/own-session.md',
      content: '# Plan\n\n1. one\n',
    });
    await run('read_file', { file_path: '/session_plans/own-session.md' });
    await run('edit_file', {
      file_path: '/session_plans/own-session.md',
      old_string: '1. one',
      new_string: '1. one\n2. two',
    });
    assert.equal(
      readFileSync(join(folder, 'own-session.md'), 'utf8'),
      '# Plan\n\n1. one\n2. two\n',
    );
  });

test('a model that writes a document into the plan folder is told to write it into the workspace', async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  let runtime!: AgentRuntime;
  const model = new ScriptedModel([
    {
      message: {
        id: 'write',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'doc',
            name: 'write_file',
            args: {
              file_path: '/session_plans/proposal-review.md',
              content: '# Review\n',
            },
          },
        ],
      },
      usage: emptyUsage(),
    },
    {
      message: { id: 'done', role: 'assistant', content: 'ok' },
      usage: emptyUsage(),
    },
  ]);
  runtime = new AgentRuntime({
    home,
    workspace,
    settings: defaultSettings(),
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  runtime.setMode('auto');
  await runtime.harness.run('write the review');
  const result = String(
    model.requests[1]!.messages.find(
      (message) => message.tool_call_id === 'doc',
    )!.content,
  );
  assert.match(
    result,
    new RegExp(
      `holds only this conversation's plan, ${runtime.planFile.file.replace(/[.]/g, '\\.')}\\. Write other documents into the workspace`,
    ),
  );
  const folder = join(projectDataDir(workspace, home), 'session_plans');
  mkdirSync(folder, { recursive: true });
  assert.equal(existsSync(join(folder, 'proposal-review.md')), false);
});
