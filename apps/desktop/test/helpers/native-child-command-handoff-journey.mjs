import { commandLineOf, runsUnder } from './process-tree.mjs';
import assert from 'node:assert/strict';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { journeyNodeCommand } from './native-journey-platform.mjs';
import { assertRenderedTerminalMatch } from './native-terminal-rendered-match.mjs';
import { terminalActionEnabled } from './native-terminal-journey.mjs';

export const childCommandParentPrompt =
  'NATIVE_CHILD_COMMAND_HANDOFF: delegate one owned interactive command';
export const childCommandTaskPrompt =
  'NATIVE_CHILD_COMMAND_WORKER: preserve the original PTY identity';
export const childCommandTaskId = 'native-child-command-worker';
export const childCommandToolCallId = 'native-child-handoff-execute';
export const childCommandInput = 'NATIVE_CHILD_HANDOFF_INPUT\r';
const acceptance =
  'Inspect original child process identity and parent draft continuity';
const files = {
  source: 'native-child-command-handoff.cjs',
  pid: 'native-child-command-pid',
  starts: 'native-child-command-starts',
  input: 'native-child-command-input',
};
const answer = (id, content, tool_calls) => ({
  message: {
    id,
    role: 'assistant',
    content,
    ...(tool_calls ? { tool_calls } : {}),
  },
});
const readSource = (id) => ({
  id,
  name: 'read_file',
  args: { file_path: files.source },
});

/** Commit these explicit files to the synthetic repository before creating child worktrees. */
export async function createNativeChildCommandHandoffFixture(
  workspace,
  nodePath,
) {
  const source = `const fs=require('node:fs');\nfs.appendFileSync('${files.starts}','once\\n');\nfs.writeFileSync('${files.pid}',String(process.pid));\nif(process.stdin.isTTY)process.stdin.setRawMode(true);\nlet line='';process.stdin.on('data',bytes=>{fs.appendFileSync('${files.input}',bytes);line+=bytes.toString();if(/[\\r\\n]/.test(line)){process.stdout.write('CHILD_HANDOFF_ECHO:'+line);line='';}});\nprocess.stdin.resume();\nconsole.log('CHILD_HANDOFF_READY '+process.pid);\nsetInterval(()=>{},1000);\n`;
  await writeFile(join(workspace, files.source), source, { flag: 'wx' });
  return {
    files: [files.source],
    source,
    paths: { ...files },
    nodePath,
    parentPrompt: childCommandParentPrompt,
    taskPrompt: childCommandTaskPrompt,
    taskId: childCommandTaskId,
    toolCallId: childCommandToolCallId,
    routes: [
      {
        id: 'native-child-command-parent',
        match: { role: 'parent', firstUser: childCommandParentPrompt },
        replies: [
          answer('native-child-delegate', '', [
            {
              id: 'native-child-parent-enqueue',
              name: 'native_tasks_enqueue',
              args: {
                operationId: 'native-child-command-enqueue',
                tasks: [
                  {
                    id: childCommandTaskId,
                    prompt: childCommandTaskPrompt,
                    access: 'write',
                    acceptanceCriteria: [acceptance],
                  },
                ],
              },
            },
          ]),
          answer(
            'native-child-parent-finished',
            'The owned child is scheduled. Its original command remains addressable from its agent card.',
          ),
        ],
      },
      {
        id: 'native-child-command-worker',
        match: {
          role: 'worker',
          taskPrompt: childCommandTaskPrompt,
          access: 'write',
        },
        replies: [
          answer('native-child-command-call', '', [
            readSource('native-child-worker-read'),
            {
              id: childCommandToolCallId,
              name: 'execute',
              args: {
                command:
                  (process.platform === 'win32' ? '' : 'exec ') +
                  journeyNodeCommand(nodePath, files.source).trimEnd(),
                timeout: 600,
                background: false,
              },
            },
          ]),
          answer(
            'native-child-command-finished',
            'The original child command stopped; inspect the actual persisted command receipt and stdin bytes.',
          ),
        ],
      },
      {
        id: 'native-child-command-reviewer',
        match: {
          role: 'reviewer',
          taskPrompt: childCommandTaskPrompt,
          access: 'write',
        },
        replies: [
          answer('native-child-review-read', '', [
            readSource('native-child-reviewer-read'),
          ]),
          answer(
            'native-child-review-result',
            JSON.stringify({
              checks: [
                {
                  criterion: acceptance,
                  status: 'needs_review',
                  evidence:
                    'Source inspection alone cannot confirm native keyboard input and the parent draft. The human native journey must inspect those effects.',
                  sources: [{ path: files.source, line: 1 }],
                },
              ],
            }),
          ),
        ],
      },
    ],
  };
}
const save = (output, name, value) =>
  writeFile(join(output, name), JSON.stringify(value, null, 2));
// Windows soon gives a finished process's id to a new process, so a live id
// is the old child only while that process still runs the fixture's script.
const gone = async (pid) => !(await commandLineOf(pid))?.includes(files.source);
const optionalRead = (workspace, file) =>
  readFile(join(workspace, file), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
const composer = (page) =>
  page.getByRole('textbox', { name: 'message', exact: true });
const sessionView = (page, id) =>
  page.evaluate(
    (id) =>
      JSON.parse(
        localStorage.getItem('circle.workbench.live.views.v1') ?? '{}',
      ).views?.find((entry) => entry[0] === id)?.[1] ?? {},
    id,
  );
async function call(
  page,
  sessionId,
  service,
  method,
  params = {},
  requireSuccess = true,
) {
  const reply = await page.evaluate(
    ({ sessionId, service, method, params }) =>
      window.circleDesktop.runtimeCommand({
        id: crypto.randomUUID(),
        name: 'workspace-service',
        sessionId,
        payload: { service, method, params },
      }),
    { sessionId, service, method, params },
  );
  if (requireSuccess) assert.equal(reply.ok, true, JSON.stringify(reply));
  return requireSuccess ? reply.data : reply;
}
// A conversation's row in the sidebar. The sidebar folds itself for a document in the
// drawer; the person can always show it again.
async function sessionRow(page, id) {
  const row = page.locator(
    `.sidebar .session-link[href="#/session/${id}"]:visible`,
  );
  if (!(await row.count()))
    await page
      .getByRole('button', { name: 'show or hide the sidebar', exact: true })
      .click();
  return row.first();
}
async function selectParent(page, id, state, until) {
  await (await sessionRow(page, id)).click();
  await until(
    async () => (await state()).activeSessionId === id,
    'the true parent conversation is selected',
  );
  await composer(page).waitFor();
}
/**
 * A task is a conversation of its own. The sidebar folds it under the conversation that
 * started it: a click lists the tasks, a click on one opens it.
 */
async function openTask(page, parentId, taskId, state, until) {
  const snapshot = await state();
  const agent = snapshot.agents.find(
    (item) => item.id === taskId && item.sessionId === parentId,
  );
  assert(
    agent && agent.resourceSessionId === taskId,
    'the original parent maps a real child resource session',
  );
  const link = page
    .locator(`.sidebar .session-link[href="#/session/${taskId}"]`)
    .first();
  if (!(await link.isVisible())) {
    await sessionRow(page, parentId);
    const toggle = page
      .locator(
        `.sidebar .session-row:has(> .session-link[href="#/session/${parentId}"]) + .session-tasks-toggle`,
      )
      .first();
    if ((await toggle.getAttribute('aria-expanded')) !== 'true')
      await toggle.click();
  }
  await link.click();
  await until(
    async () => (await state()).activeSessionId === taskId,
    'the task conversation is open',
  );
  const conversation = page.locator('.main-stack .conversation:visible');
  await conversation.waitFor();
  return { agent, conversation };
}
/**
 * A task's reviewer is not a row of the sidebar; search reaches its conversation, named
 * `review: ` and the task's instruction.
 */
async function openReviewer(page, parentId, reviewerId, state, until) {
  const snapshot = await state();
  const agent = snapshot.agents.find(
    (item) => item.id === reviewerId && item.sessionId === parentId,
  );
  assert(agent, 'the original parent maps the real reviewer session');
  const title = snapshot.sessions.find((item) => item.id === reviewerId)?.title;
  assert(
    title?.startsWith('review: '),
    'the reviewer has its own conversation',
  );
  await page.keyboard.press('ControlOrMeta+k');
  const search = page.getByRole('textbox', {
    name: 'global search',
    exact: true,
  });
  await search.fill(title);
  await page
    .locator('.search-results button')
    .filter({ has: page.locator('strong').getByText(title, { exact: true }) })
    .click();
  await until(
    async () => (await state()).activeSessionId === reviewerId,
    'the reviewer conversation is open',
  );
  const conversation = page.locator('.main-stack .conversation:visible');
  await conversation.waitFor();
  return { agent, conversation };
}
/** One call of a conversation, unfolded: its group, then the call itself. */
async function toolCall(page, conversation, name) {
  for (const summary of await conversation
    .locator('.tool-group > .tool-summary')
    .all())
    if ((await summary.getAttribute('aria-expanded')) !== 'true')
      await summary.click();
  const card = conversation
    .locator('.tool-call')
    .filter({ has: page.locator(`.tool-head code[title="${name}"]`) });
  assert.equal(await card.count(), 1);
  const head = card.locator('.tool-head');
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  return card;
}
async function approve(page, ownerId, callId, state, until) {
  await until(
    async () =>
      (await state()).interactions.some(
        (item) =>
          item.sessionId === ownerId &&
          item.callId === callId &&
          item.kind === 'approval' &&
          item.status === 'pending',
      ),
    'the actual owner requests its original approval',
  );
  assert.equal(
    (await state()).activeSessionId,
    ownerId,
    'approvals are answered only from their real conversation',
  );
  await page.getByRole('button', { name: 'allow once', exact: true }).click();
}

/** UI performs scheduling, approval, child navigation, typing and stop; RPC observes ownership or tests a denied boundary. */
export async function runNativeChildCommandHandoffJourney({
  page,
  workspace,
  parentSessionId: returnSessionId,
  state,
  until,
  output,
  fixture,
}) {
  const receipt = {
    status: 'running',
    checks: [],
    scope:
      'real delegated write worker PTY plus a distinct readonly reviewer; no fabricated readonly worker permission',
  };
  const originalDraft = await composer(page).inputValue();
  let ownerId,
    worker,
    target,
    stopped = false;
  try {
    await page
      .locator('.sidebar')
      .getByRole('button', { name: 'new session', exact: true })
      .click();
    const home = page.locator('.home:visible');
    await home.waitFor();
    await home
      .getByRole('textbox', { name: 'message', exact: true })
      .fill(childCommandParentPrompt);
    await home
      .getByRole('button', { name: 'send message', exact: true })
      .click();
    await until(async () => {
      ownerId = (await state()).activeSessionId;
      return ownerId && ownerId !== returnSessionId;
    }, 'the delegated command has its own original parent conversation');
    await approve(page, ownerId, 'native-child-parent-enqueue', state, until);
    await until(async () => {
      worker = (await call(page, ownerId, 'tasks', 'list')).find(
        (task) => task.spec.id === childCommandTaskId,
      );
      return worker?.runtimeSessionId && worker.worktree;
    }, 'real task attempt binds its worker session and worktree');
    assert.equal(worker.spec.sessionId, ownerId);
    assert.equal(worker.spec.access, 'write');
    assert.notEqual(worker.runtimeSessionId, ownerId);
    assert.notEqual(await realpath(worker.worktree), await realpath(workspace));
    const parentDraft = 'NATIVE_CHILD_PARENT_UNSENT_DRAFT';
    await composer(page).fill(parentDraft);
    await until(
      async () => (await sessionView(page, ownerId)).draft === parentDraft,
      'parent unsent draft is durably present in the original composer',
    );
    // The task's request waits in its own conversation, which the sidebar opens.
    let opened = await openTask(
      page,
      ownerId,
      worker.runtimeSessionId,
      state,
      until,
    );
    assert.equal(
      opened.agent.readOnly,
      false,
      'the write worker does not pretend to have readonly source authority',
    );
    await approve(
      page,
      worker.runtimeSessionId,
      childCommandToolCallId,
      state,
      until,
    );
    let pid;
    await until(async () => {
      pid = Number(await optionalRead(worker.worktree, fixture.paths.pid));
      return Number.isSafeInteger(pid) && pid > 0;
    }, 'the actual child process records its own PID');
    assert.equal(
      await optionalRead(workspace, fixture.paths.pid),
      '',
      'the same command never ran in the parent workspace',
    );
    assert.equal(
      await optionalRead(worker.worktree, fixture.paths.starts),
      'once\n',
    );
    await selectParent(page, ownerId, state, until);
    assert.equal(await composer(page).inputValue(), parentDraft);
    opened = await openTask(
      page,
      ownerId,
      worker.runtimeSessionId,
      state,
      until,
    );
    target = (
      await call(page, ownerId, 'terminal', 'resolveCommand', {
        sourceSessionId: worker.runtimeSessionId,
        toolCallId: childCommandToolCallId,
      })
    ).target;
    assert(target, 'real child execute receipt resolves');
    assert.equal(target.executionSessionId, worker.runtimeSessionId);
    const card = await toolCall(page, opened.conversation, 'execute');
    await card
      .getByRole('button', { name: 'open in terminal', exact: true })
      .click();
    const terminal = page.locator('.native-terminal:visible');
    const surface = terminal.locator(`#terminal-${target.terminal.id}:visible`);
    await surface.waitFor();
    const listing = await call(page, ownerId, 'terminal', 'command', {
      target,
      action: 'list',
    });
    assert.equal(listing.available, true);
    assert.equal(listing.value.length, 1);
    // The card's process is the command's root; the program runs as it or under it.
    assert.ok(
      await runsUnder(pid, listing.value[0].managedCommand.commandPid),
      `${pid} runs under command root ${listing.value[0].managedCommand.commandPid}`,
    );
    assert.equal(listing.value[0].id, target.terminal.id);
    assert.equal(listing.capabilities.input, true);
    await surface.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(childCommandInput.slice(0, -1));
    await page.keyboard.press('Enter');
    await until(
      async () =>
        (await optionalRead(worker.worktree, fixture.paths.input)) ===
        childCommandInput,
      'the original child process receives exact native keyboard bytes',
    );
    receipt.inputEvidence = {
      childInput: await optionalRead(worker.worktree, fixture.paths.input),
      childStarts: await optionalRead(worker.worktree, fixture.paths.starts),
      originalCommandPid: pid,
      terminalCols: listing.value[0].cols,
    };
    receipt.displayEvidence = await assertRenderedTerminalMatch({
      panel: terminal,
      surface,
      text: 'CHILD_HANDOFF_ECHO:' + childCommandInput.trimEnd(),
      until,
      terminalId: target.terminal.id,
      replay: async (afterSequence) => {
        const result = await call(page, ownerId, 'terminal', 'command', {
          target,
          action: 'replay',
          params: { afterSequence, limit: 128 },
        });
        assert.equal(result.available, true);
        assert.deepEqual(result.target, target);
        return result.value;
      },
    });
    assert.equal(await optionalRead(workspace, fixture.paths.input), '');
    assert.equal((await sessionView(page, ownerId)).draft, parentDraft);
    await page.screenshot({
      path: join(output, 'child-command-handoff-live.png'),
    });
    // A command Circle runs is stopped from the end of the tab row, while it runs.
    await terminal.getByRole('button', { name: 'stop', exact: true }).click();
    await until(async () => {
      const result = await call(page, ownerId, 'terminal', 'command', {
        target,
        action: 'list',
      });
      const end = result.value?.[0];
      return (
        result.available &&
        end &&
        (await gone(pid)) &&
        end.managedCommand.completion.rootExit &&
        end.managedCommand.completion.controlledGroupEmpty &&
        end.managedCommand.completion.transportAndLogClosed
      );
    }, 'the child root, controlled group and PTY/log really close');
    stopped = true;
    await until(async () => {
      worker = (await call(page, ownerId, 'tasks', 'list')).find(
        (task) => task.spec.id === childCommandTaskId,
      );
      return (
        worker?.state === 'needs_review' &&
        worker.reviewers?.some((item) => item.sessionId)
      );
    }, 'the true independent reviewer finishes at a human review boundary');
    const reviewer = worker.reviewers[0];
    assert.notEqual(reviewer.sessionId, worker.runtimeSessionId);
    const reviewerAgent = (await state()).agents.find(
      (item) => item.id === reviewer.sessionId && item.sessionId === ownerId,
    );
    assert.equal(reviewerAgent?.task?.role, 'reviewer');
    assert.equal(reviewerAgent.readOnly, true);
    // The reviewer reads the candidate in a worktree of its own and cannot save there.
    // How its conversation shows that source is checked by runNativeReviewerSourceJourney.
    const doc = await call(page, reviewer.sessionId, 'documents', 'read', {
      path: fixture.paths.source,
    });
    assert.equal(doc.content.replace(/\r\n/g, '\n'), fixture.source);
    const denied = await call(
      page,
      reviewer.sessionId,
      'documents',
      'save',
      {
        path: fixture.paths.source,
        content: 'DENIED_REVIEWER_SAVE',
        expectedRevision: doc.revision,
      },
      false,
    );
    assert.equal(denied.ok, false);
    assert.match(denied.error, /read-only agent source/);
    // A reviewer worktree is a Git checkout, which writes CRLF on Windows.
    const text = async (root) =>
      (await readFile(join(root, fixture.paths.source), 'utf8')).replace(
        /\r\n/g,
        '\n',
      );
    assert.equal(await text(reviewer.workspace), fixture.source);
    assert.equal(await text(workspace), fixture.source);
    await selectParent(page, ownerId, state, until);
    assert.equal(await composer(page).inputValue(), parentDraft);
    assert.equal(
      await optionalRead(worker.worktree, fixture.paths.starts),
      'once\n',
    );
    Object.assign(receipt, {
      status: 'passed',
      ownerId,
      workerSessionId: worker.runtimeSessionId,
      reviewerSessionId: reviewer.sessionId,
      reviewerWorkspace: reviewer.workspace,
      childWorktree: worker.worktree,
      target,
      pid,
      parentDraft,
      paths: fixture.paths,
      stopped,
      taskId: childCommandTaskId,
      source: fixture.source,
    });
    receipt.checks.push(
      'the sidebar opens the actual task conversation the parent scheduled',
      'approval uses the real child conversation',
      'same original child PTY receives exact native bytes once',
      'parent unsent draft and same-name parent files remain unchanged',
      'the distinct real readonly reviewer cannot save its source',
    );
    return receipt;
  } catch (error) {
    Object.assign(receipt, {
      status: 'failed',
      error: String(error),
      ownerId,
      worker,
      target,
    });
    await page
      .screenshot({ path: join(output, 'child-command-handoff-failure.png') })
      .catch(() => {});
    throw error;
  } finally {
    receipt.stopped = stopped;
    if (target && !stopped)
      receipt.cleanup = await call(
        page,
        ownerId,
        'terminal',
        'command',
        { target, action: 'close' },
        false,
      ).catch((error) => ({ error: String(error) }));
    try {
      await selectParent(page, returnSessionId, state, until);
      assert.equal(await composer(page).inputValue(), originalDraft);
      receipt.originalParentDraftPreserved = true;
    } finally {
      await save(output, 'child-command-handoff-receipt.json', receipt);
    }
  }
}

/**
 * A task's reviewer reads the candidate and cannot change it. Its conversation, which search
 * reaches, shows the source it read as read-only, with nothing to save. Call after
 * runNativeChildCommandHandoffJourney passed.
 */
export async function runNativeReviewerSourceJourney({
  page,
  parentSessionId: returnSessionId,
  state,
  until,
  output,
  previous,
}) {
  assert.equal(previous.status, 'passed');
  const receipt = {
    status: 'running',
    reviewerSessionId: previous.reviewerSessionId,
  };
  const returnDraft = await composer(page).inputValue();
  try {
    const opened = await openReviewer(
      page,
      previous.ownerId,
      previous.reviewerSessionId,
      state,
      until,
    );
    assert.equal(opened.agent.task.role, 'reviewer');
    assert.equal(opened.agent.readOnly, true);
    const source = await toolCall(page, opened.conversation, 'read_file');
    await source
      .getByRole('button', { name: 'open file', exact: true })
      .click();
    const file = page.locator('.file-view:visible');
    await file
      .locator('.file-view-heading strong')
      .getByText(previous.paths.source, { exact: true })
      .waitFor();
    await page.screenshot({
      path: join(output, 'child-command-readonly-reviewer-source.png'),
    });
    receipt.shown = {
      readOnlyLabel: await file.locator('.file-source-readonly').count(),
      saveEnabled: await file
        .getByRole('button', { name: 'save', exact: true })
        .isEnabled(),
      mode: await file
        .locator('.file-view-toolbar [aria-pressed="true"]')
        .first()
        .textContent(),
    };
    await file.locator('.file-source-readonly').waitFor();
    assert.equal(
      await file.getByRole('button', { name: 'save', exact: true }).isEnabled(),
      false,
      'the reviewer source offers nothing to save',
    );
    // A reviewer worktree is a Git checkout, which writes CRLF on Windows.
    assert.equal(
      (
        await readFile(
          join(previous.reviewerWorkspace, previous.paths.source),
          'utf8',
        )
      ).replace(/\r\n/g, '\n'),
      previous.source,
    );
    receipt.status = 'passed';
    return receipt;
  } catch (error) {
    receipt.status = 'failed';
    receipt.error = String(error);
    throw error;
  } finally {
    try {
      const close = page
        .locator('.file-view')
        .getByRole('button', { name: 'close file', exact: true });
      if (await close.isVisible()) await close.click();
      await selectParent(page, returnSessionId, state, until);
      assert.equal(await composer(page).inputValue(), returnDraft);
    } finally {
      await save(output, 'reviewer-source-receipt.json', receipt);
    }
  }
}

/** Call after the driver's existing real application quit/relaunch, not a renderer reload. */
export async function runNativeChildCommandAfterRestart({
  page,
  parentSessionId: returnSessionId,
  state,
  until,
  output,
  previous,
}) {
  assert.equal(
    previous.status,
    'passed',
    'live child handoff must pass before restart history',
  );
  const receipt = {
    status: 'running',
    actualAppRestartRequired: true,
    priorTarget: previous.target,
  };
  const returnDraft = await composer(page).inputValue();
  try {
    assert(await gone(previous.pid), 'the original child process remains gone');
    await selectParent(page, previous.ownerId, state, until);
    assert.equal(await composer(page).inputValue(), previous.parentDraft);
    const opened = await openTask(
      page,
      previous.ownerId,
      previous.workerSessionId,
      state,
      until,
    );
    const resolution = await call(
      page,
      previous.ownerId,
      'terminal',
      'resolveCommand',
      {
        sourceSessionId: previous.workerSessionId,
        toolCallId: childCommandToolCallId,
      },
    );
    assert.equal(resolution.available, true);
    assert.deepEqual(resolution.target, previous.target);
    assert.deepEqual(resolution.capabilities, {
      read: true,
      input: false,
      stop: false,
      addToDraft: false,
    });
    await (
      await toolCall(page, opened.conversation, 'execute')
    )
      .getByRole('button', { name: 'open in terminal', exact: true })
      .click();
    const terminal = page.locator('.native-terminal:visible');
    const surface = terminal.locator(
      `#terminal-${previous.target.terminal.id}:visible`,
    );
    await surface.waitFor();
    receipt.displayEvidence = await assertRenderedTerminalMatch({
      panel: terminal,
      surface,
      text: 'CHILD_HANDOFF_ECHO:' + childCommandInput.trimEnd(),
      until,
      terminalId: previous.target.terminal.id,
      replay: async (afterSequence) => {
        const result = await call(
          page,
          previous.ownerId,
          'terminal',
          'command',
          {
            target: previous.target,
            action: 'replay',
            params: { afterSequence, limit: 128 },
          },
        );
        assert.equal(result.available, true);
        assert.deepEqual(result.target, previous.target);
        return result.value;
      },
    });
    // History offers neither a stop nor a restart, which would run the command again.
    assert.equal(
      await terminal.getByRole('button', { name: 'stop', exact: true }).count(),
      0,
    );
    assert.equal(
      await terminalActionEnabled(page, terminal, 'restart terminal'),
      false,
    );
    const denied = await call(
      page,
      previous.ownerId,
      'terminal',
      'command',
      {
        target: resolution.target,
        action: 'write',
        params: { data: 'MUST_NOT_RELAUNCH' },
      },
      false,
    );
    assert.equal(
      denied.ok,
      false,
      'the archived parent cannot regain live stdin capability',
    );
    assert(denied.error);
    assert.equal(
      await optionalRead(previous.childWorktree, previous.paths.starts),
      'once\n',
    );
    assert.equal(
      Number(await optionalRead(previous.childWorktree, previous.paths.pid)),
      previous.pid,
    );
    assert.equal(
      await optionalRead(previous.childWorktree, previous.paths.input),
      childCommandInput,
    );
    assert(await gone(previous.pid));
    assert(
      !(await state()).jobs.some(
        (job) =>
          job.sessionId === previous.workerSessionId &&
          ['running', 'stopping'].includes(job.state),
      ),
    );
    Object.assign(receipt, {
      status: 'passed',
      pidGone: true,
      noNewProcess: true,
      startCount: 1,
      sameTarget: true,
    });
    await page.screenshot({
      path: join(output, 'child-command-after-app-restart-readonly.png'),
    });
    return receipt;
  } catch (error) {
    receipt.status = 'failed';
    receipt.error = String(error);
    await page
      .screenshot({ path: join(output, 'child-command-restart-failure.png') })
      .catch(() => {});
    throw error;
  } finally {
    try {
      await selectParent(page, returnSessionId, state, until);
      assert.equal(await composer(page).inputValue(), returnDraft);
    } finally {
      await save(output, 'child-command-restart-receipt.json', receipt);
    }
  }
}
