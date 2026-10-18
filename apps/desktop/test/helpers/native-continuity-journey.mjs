import assert from 'node:assert/strict';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { openNativeTerminalInspector } from './native-terminal-journey.mjs';
import { journeyNodeCommand } from './native-journey-platform.mjs';
import { saveWithShortcut } from './native-editor-save.mjs';
const selectedText = 'CIRCLE_NATIVE_CONTEXT_中文';
const terminalFile = 'native-continuity-terminal.cjs';
const otherFile = 'native-continuity-manual.txt';
const originalOther = 'native continuity manual baseline\n';
const changedOther = 'native continuity manual saved independently\n';

/** Scratch workspace only. Add these explicit files to the fixture baseline if prepared before Git checks. */
export async function createNativeContinuityFixture(workspace) {
  await writeFile(
    join(workspace, terminalFile),
    `console.log(${JSON.stringify(selectedText)});console.log('CONTINUITY_NODE_PID '+process.pid);setInterval(()=>{},1000);\n`,
    { flag: 'wx' },
  );
  await writeFile(join(workspace, otherFile), originalOther, { flag: 'wx' });
  return {
    files: [terminalFile, otherFile],
    terminalFile,
    otherFile,
    originalOther,
    changedOther,
    selectedText,
  };
}
const saveReceipt = (output, name, receipt) =>
  writeFile(join(output, name + '.json'), JSON.stringify(receipt, null, 2));
const currentSession = (snapshot, sessionId) => {
  assert.equal(
    snapshot.activeSessionId,
    sessionId,
    'the original parent session remains active',
  );
  const session = snapshot.sessions.find((s) => s.id === sessionId);
  assert(session, 'actual parent session exists');
  return session;
};

// Drafts and attachments belong to LiveRuntime's renderer-local view. The worker
// runtimeState snapshot deliberately does not contain this overlay.
const persistedSessionView = (page, sessionId) =>
  page.evaluate((id) => {
    const text = localStorage.getItem('circle.workbench.live.views.v1');
    if (text === null) return null;
    const stored = JSON.parse(text);
    if (!Array.isArray(stored.views))
      throw Error('native journey renderer view store is invalid');
    return (
      stored.views.find(
        (entry) => Array.isArray(entry) && entry[0] === id,
      )?.[1] ?? null
    );
  }, sessionId);
const composer = (page) =>
  page.getByRole('textbox', { name: 'message', exact: true });

/** UI mutations only; state/query observe actual runtime effects. The parent preserves the clipboard; no model calls. */
export async function runNativeTerminalContextJourney({
  page,
  workspace,
  sessionId,
  fixture,
  nodePath,
  query,
  state,
  until,
  output,
  clipboard,
}) {
  const receipt = { checks: [] };
  let terminal;
  let nodePid;
  const exited = (pid) => {
    if (pid === undefined) return true;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if (error.code === 'ESRCH') return true;
      throw error;
    }
  };
  try {
    const before = currentSession(await state(), sessionId);
    const originalDraft = await composer(page).inputValue();
    const originalView = await persistedSessionView(page, sessionId);
    if (originalView)
      assert.equal(
        originalView.draft ?? '',
        originalDraft,
        'the initial persisted draft matches the actual composer',
      );
    const originalAttachments = (
      originalView?.attachments ?? before.attachments
    ).map((a) => a.id);
    const originalMessages = before.messages.map((m) => m.id);
    const panel = await openNativeTerminalInspector(page);
    const prior = new Set((await query('terminal', 'list')).map((t) => t.id));
    await panel
      .locator('.native-terminal-toolbar')
      .getByRole('button', { name: 'new terminal', exact: true })
      .click();
    await until(
      async () =>
        Boolean(
          (terminal = (await query('terminal', 'list')).find(
            (t) => !prior.has(t.id),
          )),
        ),
      'new actual continuity PTY exists',
    );
    const tab = panel.locator(
      `[role="tab"][aria-controls="terminal-${terminal.id}"]`,
    );
    await tab.click();
    const input = panel.locator(
      `#terminal-${terminal.id} .xterm-helper-textarea`,
    );
    await input.focus();
    await page.keyboard.type(
      journeyNodeCommand(nodePath, join(workspace, fixture.terminalFile)).slice(
        0,
        -1,
      ),
    );
    await page.keyboard.press('Enter');
    let replay;
    await until(async () => {
      replay = await query('terminal', 'replay', {
        id: terminal.id,
        afterSequence: 0,
        limit: 512,
      });
      return /CONTINUITY_NODE_PID\s+\d+/.test(
        replay.events.map((event) => event.data ?? '').join(''),
      );
    }, 'real continuity Node process prints its identity');
    const actualOutput = replay.events
      .map((event) => event.data ?? '')
      .join('');
    nodePid = Number(actualOutput.match(/CONTINUITY_NODE_PID\s+(\d+)/)?.[1]);
    assert(Number.isSafeInteger(nodePid) && nodePid > 0);
    process.kill(nodePid, 0);
    // Find opens on demand from the terminal bar.
    await panel
      .getByRole('button', { name: 'find in terminal', exact: true })
      .click();
    const find = panel.getByRole('textbox', {
      name: 'find in terminal',
      exact: true,
    });
    await find.fill(fixture.selectedText);
    await find.press('Enter');
    const add = panel.getByRole('button', {
      name: 'add selection to chat',
      exact: true,
    });
    await until(
      () => add.isEnabled(),
      'actual xterm selection enables add to chat',
    );
    await add.click();
    let attachment;
    await until(
      async () =>
        Boolean(
          (attachment = (
            await persistedSessionView(page, sessionId)
          )?.attachments?.find(
            (a) =>
              !originalAttachments.includes(a.id) &&
              a.name.endsWith(' · selection'),
          )),
        ),
      'selection becomes an original composer attachment',
    );
    await page
      .locator('.attachment-strip')
      .getByRole('button', { name: attachment.name, exact: true })
      .waitFor();
    assert.equal(attachment.kind, 'file');
    const parts = attachment.content.split(
      '\n\n--- terminal capture source ---\n',
    );
    assert.equal(parts.length, 2);
    assert.equal(
      parts[0],
      fixture.selectedText,
      'only the actual selected Chinese text enters the attachment',
    );
    const source = JSON.parse(parts[1]);
    assert.equal(source.sessionId, sessionId);
    assert.equal(source.terminalId, terminal.id);
    assert.equal(source.terminalEpoch, terminal.epoch);
    assert.equal(source.cwd, terminal.cwd);
    assert.equal(source.origin, 'user-selected capture');
    assert.equal(
      source.capturedBufferRange.coordinates,
      'zero-based, end exclusive',
    );
    const afterAdd = currentSession(await state(), sessionId);
    assert.equal(await composer(page).inputValue(), originalDraft);
    assert.equal(
      (await persistedSessionView(page, sessionId))?.draft ?? '',
      originalDraft,
    );
    assert.deepEqual(
      afterAdd.messages.map((m) => m.id),
      originalMessages,
      'adding context never sends the conversation',
    );
    await page
      .locator('.attachment-strip')
      .getByRole('button', { name: attachment.name, exact: true })
      .click();
    const original = page
      .locator('.inspector .context-source')
      .filter({ has: page.locator('summary', { hasText: attachment.name }) });
    if (!(await original.evaluate((node) => node.open)))
      await original.locator(':scope > summary').click();
    assert.equal(
      await original.locator('.terminal-selection-text').textContent(),
      fixture.selectedText,
      'the default preview shows the selected text first',
    );
    assert(
      (await original.locator('.panel-note').first().innerText()).includes(
        terminal.label,
      ),
    );
    assert(
      (await original.locator('.panel-note').first().innerText()).includes(
        terminal.cwd,
      ),
    );
    const originalDetails = original.locator('.terminal-selection-original');
    assert.equal(
      await originalDetails.evaluate((node) => node.open),
      false,
      'source JSON is folded by default',
    );
    assert.equal(
      (await original.innerText()).includes('circle.terminal-selection'),
      false,
      'default preview does not expose JSON metadata',
    );
    await originalDetails
      .locator(':scope > summary')
      .filter({ hasText: 'original attachment and source details' })
      .click();
    assert.equal(
      await originalDetails.locator('pre').textContent(),
      attachment.content,
      'the complete original attachment is available after explicit expansion',
    );
    await page.screenshot({
      path: join(output, 'native-terminal-selection-original-context.png'),
    });
    await openNativeTerminalInspector(page);
    await page
      .getByRole('button', { name: 'close inspector', exact: true })
      .click();
    process.kill(nodePid, 0);
    const hidden = (await query('terminal', 'list')).find(
      (t) => t.id === terminal.id,
    );
    assert.equal(hidden.pid, terminal.pid);
    assert.equal(hidden.status, 'running');
    const reopenedPanel = await openNativeTerminalInspector(page);
    await tab.waitFor();
    await until(
      async () => (await tab.getAttribute('aria-selected')) === 'true',
      'reopening selects the same terminal',
    );
    const reopened = (await query('terminal', 'list')).find(
      (t) => t.id === terminal.id,
    );
    assert.equal(reopened.pid, terminal.pid);
    assert.equal(reopened.epoch, terminal.epoch);
    assert.equal(reopened.status, 'running');
    // AUTO accessibility may intentionally omit the auxiliary DOM tree.
    // Search the actual parsed VT buffer and copy its real selection instead.
    // Find opens on demand from the terminal bar.
    await reopenedPanel
      .getByRole('button', { name: 'find in terminal', exact: true })
      .click();
    const reopenedFind = reopenedPanel.getByRole('textbox', {
      name: 'find in terminal',
      exact: true,
    });
    await reopenedFind.fill('CIRCLE_CONTEXT_REOPEN_NO_MATCH');
    await reopenedFind.press('Enter');
    await reopenedPanel.getByText('no matches', { exact: true }).waitFor();
    await reopenedFind.fill(fixture.selectedText);
    await reopenedFind.press('Enter');
    await until(
      async () =>
        (await reopenedPanel
          .locator(`#terminal-${terminal.id} .xterm-selection div`)
          .count()) > 0 &&
        !(await reopenedPanel
          .getByText('no matches', { exact: true })
          .isVisible()),
      'reopened same terminal selects its original Chinese output',
    );
    await reopenedFind.press('Escape');
    await page.keyboard.press(
      process.platform === 'darwin' ? 'Meta+c' : 'Control+Shift+c',
    );
    await until(
      async () => (await clipboard.readText()).trim() === fixture.selectedText,
      'reopened terminal copies its original selected Chinese output exactly',
    );
    const reopenedReplay = await query('terminal', 'replay', {
      id: terminal.id,
      afterSequence: 0,
      limit: 512,
    });
    assert(
      reopenedReplay.events
        .map((event) => event.data ?? '')
        .join('')
        .includes(fixture.selectedText),
      'actual retained terminal log still contains its original output',
    );
    process.kill(nodePid, 0);
    await page
      .locator('.attachment-strip')
      .getByRole('button', { name: `remove ${attachment.name}`, exact: true })
      .click();
    await until(async () => {
      const view = await persistedSessionView(page, sessionId);
      return (
        Array.isArray(view?.attachments) &&
        !view.attachments.some((a) => a.id === attachment.id)
      );
    }, 'existing attachment remove takes effect');
    await page
      .locator('.attachment-strip')
      .getByRole('button', { name: attachment.name, exact: true })
      .waitFor({ state: 'detached' });
    assert.equal(await composer(page).inputValue(), originalDraft);
    assert.equal(
      (await persistedSessionView(page, sessionId))?.draft ?? '',
      originalDraft,
    );
    const afterRemove = currentSession(await state(), sessionId);
    assert.deepEqual(
      afterRemove.messages.map((m) => m.id),
      originalMessages,
    );
    assert.deepEqual(
      (await persistedSessionView(page, sessionId)).attachments.map(
        (a) => a.id,
      ),
      originalAttachments,
      'removing this capture preserves all prior local attachments',
    );
    receipt.localViewOracle = {
      source: 'actual composer and persisted circle.workbench.live.views.v1',
      sessionId,
      draftPreserved: true,
      attachmentAddedAndRemoved: true,
    };
    receipt.checks.push(
      'actual PTY selection to original composer chip and exact original context preview',
      'hide/reopen preserves actual shell and child process',
      'remove preserves original unsent draft and message identities',
    );
    receipt.status = 'passed';
    receipt.terminal = {
      id: terminal.id,
      pid: terminal.pid,
      nodePid,
      epoch: terminal.epoch,
    };
    receipt.attachment = attachment;
    return receipt;
  } catch (error) {
    receipt.status = 'failed';
    receipt.error = String(error);
    await page
      .screenshot({ path: join(output, 'native-terminal-context-failure.png') })
      .catch(() => {});
    throw error;
  } finally {
    let cleanupError;
    // The helper owns this terminal; closing its UI explicitly stops it after the preservation assertion.
    if (terminal) {
      try {
        const panel = await openNativeTerminalInspector(page);
        await panel
          .locator(`[role="tab"][aria-controls="terminal-${terminal.id}"]`)
          .click();
        await panel
          .getByRole('button', { name: 'stop terminal', exact: true })
          .click();
        await until(
          async () =>
            (await query('terminal', 'list')).some(
              (t) =>
                t.id === terminal.id &&
                ['exited', 'failed', 'interrupted'].includes(t.status),
            ) &&
            exited(terminal.pid) &&
            exited(nodePid),
          'helper-owned terminal reaches final state and actual shell and Node PIDs exit after explicit stop',
        );
        receipt.cleanup = {
          status: 'actual owned processes exited',
          shellPid: terminal.pid,
          nodePid,
        };
      } catch (error) {
        cleanupError = error;
        receipt.cleanup = { failed: String(error) };
      }
    }
    if (cleanupError && receipt.status === 'passed') {
      receipt.status = 'failed';
      receipt.error = 'owned terminal cleanup failed: ' + String(cleanupError);
    }
    await saveReceipt(output, 'native-terminal-context-receipt', receipt);
    if (
      cleanupError &&
      receipt.error?.startsWith('owned terminal cleanup failed:')
    )
      throw cleanupError;
  }
}

/** Invoke only after the existing task phase has checked parent agent-result.txt is absent. */
export async function runNativeChildSourceJourney({
  page,
  workspace,
  sessionId,
  agentId,
  childWorktree,
  fixture,
  state,
  until,
  output,
  entry = 'activity',
}) {
  const receipt = { checks: [], entry };
  const sourcePath = 'agent-result.txt';
  const parentContent = 'parent same-name source must remain unchanged\n';
  try {
    const before = await state();
    const parent = currentSession(before, sessionId);
    const agent = before.agents.find(
      (a) => a.id === agentId && a.sessionId === sessionId,
    );
    assert(
      agent,
      'a real projected child with the requested owning parent exists',
    );
    assert.equal(agent.resourceSessionId, agent.id);
    assert(
      agent.workspaceId && agent.workspaceId !== parent.workspaceId,
      'the writable child owns an isolated workspace',
    );
    const projectedWorkspace = before.workspaces.find(
      (item) => item.id === agent.workspaceId,
    );
    assert(
      projectedWorkspace?.path,
      'the actual child workspace path is projected',
    );
    assert.equal(
      await realpath(projectedWorkspace.path),
      await realpath(childWorktree),
      'the expected worktree is the child resource owner path',
    );
    assert.notEqual(
      await realpath(childWorktree),
      await realpath(workspace),
      'child and parent directories are actually isolated',
    );
    const childContent = await readFile(
      join(childWorktree, sourcePath),
      'utf8',
    );
    assert.equal(childContent, 'isolated task output\n');
    // Deliberately create the same relative path only after isolated tasks have finished.
    // wx refuses an existing file; this helper cannot overwrite prior fixture or user data.
    await writeFile(join(workspace, sourcePath), parentContent, { flag: 'wx' });
    const previousDraft = await composer(page).inputValue();
    const previousView = await persistedSessionView(page, sessionId);
    if (previousView)
      assert.equal(
        previousView.draft ?? '',
        previousDraft,
        'the parent persisted draft matches the actual composer',
      );
    if (entry === 'tool') {
      const sourceTool = parent.messages.find(
        (m) =>
          m.tool &&
          [
            ...(m.tool.agentIds ?? []),
            ...(m.tool.agentId ? [m.tool.agentId] : []),
          ].includes(agent.id),
      );
      assert(
        sourceTool,
        'tool entry requires a genuine projected tool-child mapping',
      );
      const links = page
        .locator('.tool-agent-links button')
        .filter({ has: page.getByText(agent.name, { exact: true }) });
      assert.equal(
        await links.count(),
        1,
        'the trusted child navigation entry is unambiguous',
      );
      await links.click();
    } else {
      const toggle = page.getByRole('button', {
        name: 'activity panel',
        exact: true,
      });
      if ((await toggle.getAttribute('aria-pressed')) !== 'true')
        await toggle.click();
      await page.locator('#inspector-activity-tab-original').click();
      const row = page
        .locator('#inspector-activity-original .activity-row')
        .filter({ has: page.getByText(agent.name, { exact: true }) });
      assert.equal(
        await row.count(),
        1,
        'the actual child activity entry is unambiguous',
      );
      await row.click();
    }
    const record = page.locator('.agent-record:visible');
    await record.getByText(agent.id, { exact: true }).waitFor();
    const source = record
      .locator('.tool-call')
      .filter({ has: page.locator('.tool-target', { hasText: sourcePath }) });
    assert.equal(
      await source.count(),
      1,
      'one actual child tool refers to the fixture source',
    );
    await source
      .getByRole('button', { name: 'open file', exact: true })
      .click();
    await page
      .locator('.file-view:visible .view-lines')
      .filter({ hasText: childContent.trim() })
      .waitFor();
    assert.equal(
      await readFile(join(workspace, sourcePath), 'utf8'),
      parentContent,
    );
    await page.screenshot({
      path: join(output, 'native-child-owned-source.png'),
    });
    await page.getByRole('button', { name: 'close file', exact: true }).click();
    await record.getByText(agent.id, { exact: true }).waitFor();
    currentSession(await state(), sessionId);
    assert.equal(
      (await persistedSessionView(page, sessionId))?.draft ?? '',
      previousDraft,
    );
    await record.getByRole('button', { name: 'main', exact: true }).click();
    await composer(page).waitFor();
    assert.equal(await composer(page).inputValue(), previousDraft);
    await page.keyboard.press('ControlOrMeta+p');
    const quickOpen = page.getByRole('dialog', {
      name: 'quick open',
      exact: true,
    });
    await quickOpen.waitFor();
    const search = quickOpen.getByPlaceholder('search workspace files', {
      exact: true,
    });
    await search.fill(fixture.otherFile);
    await quickOpen
      .getByRole('button', {
        name: new RegExp(fixture.otherFile.replaceAll('.', '\\.')),
      })
      .click();
    const file = page.locator('.file-view:visible');
    await file.getByRole('button', { name: 'edit', exact: true }).click();
    await file.locator('.view-lines').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText(fixture.changedOther);
    await until(
      async () =>
        (await file.locator('.view-lines').textContent())
          .replaceAll('\u00a0', ' ')
          .includes(fixture.changedOther.trim()),
      'manual edit reaches actual Monaco buffer',
    );
    await saveWithShortcut(
      page,
      'ControlOrMeta',
      async () =>
        (await readFile(join(workspace, fixture.otherFile), 'utf8')) ===
        fixture.changedOther,
      'another parent file actually saves',
      file,
    );
    assert.equal(
      await readFile(join(workspace, sourcePath), 'utf8'),
      parentContent,
    );
    assert.equal(
      await readFile(join(childWorktree, sourcePath), 'utf8'),
      childContent,
    );
    await page.getByRole('button', { name: 'close file', exact: true }).click();
    await composer(page).waitFor();
    assert.equal(await composer(page).inputValue(), previousDraft);
    assert.equal(
      (await persistedSessionView(page, sessionId))?.draft ?? '',
      previousDraft,
    );
    receipt.checks.push(
      'actual projected child opens from original navigation',
      'child tool source opens actual child worktree file',
      'closing file returns to the same child record',
      'parent same-name file stays unchanged while another file saves',
    );
    receipt.status = 'passed';
    receipt.agent = {
      id: agent.id,
      sessionId: agent.sessionId,
      resourceSessionId: agent.resourceSessionId,
      workspaceId: agent.workspaceId,
    };
    return receipt;
  } catch (error) {
    receipt.status = 'failed';
    receipt.error = String(error);
    await page
      .screenshot({ path: join(output, 'native-child-source-failure.png') })
      .catch(() => {});
    throw error;
  } finally {
    await saveReceipt(output, 'native-child-source-receipt', receipt);
  }
}
