import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openNativeTerminalInspector } from './native-terminal-journey.mjs';
import { journeyNodeCommand } from './native-journey-platform.mjs';
const selectedText = 'CIRCLE_NATIVE_CONTEXT_中文';
const terminalFile = 'native-continuity-terminal.cjs';
const otherFile = 'native-continuity-manual.txt';
const originalOther = 'native continuity manual baseline\n';
const changedOther = 'native continuity manual saved independently\n';

/** Scratch workspace only. Add these explicit files to the fixture baseline if prepared before Git checks. */
export async function createNativeContinuityFixture(workspace) {
  await writeFile(
    join(workspace, terminalFile),
    `console.log(${JSON.stringify(selectedText)});console.log('CONTINUITY_NODE_PID',process.pid);setInterval(()=>{},1000);\n`,
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

/** UI mutations only; state/query observe actual runtime effects. No clipboard or model calls. */
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
}) {
  const receipt = { checks: [] };
  let terminal;
  try {
    const before = currentSession(await state(), sessionId);
    const originalDraft = before.draft;
    const originalAttachments = before.attachments.map((a) => a.id);
    const originalMessages = before.messages.map((m) => m.id);
    const panel = await openNativeTerminalInspector(page);
    const prior = new Set((await query('terminal', 'list')).map((t) => t.id));
    await panel
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
    const nodePid = Number(
      actualOutput.match(/CONTINUITY_NODE_PID\s+(\d+)/)?.[1],
    );
    assert(Number.isSafeInteger(nodePid) && nodePid > 0);
    process.kill(nodePid, 0);
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
          (attachment = currentSession(
            await state(),
            sessionId,
          ).attachments.find(
            (a) =>
              !originalAttachments.includes(a.id) &&
              a.name.endsWith(' · selection'),
          )),
        ),
      'selection becomes an original composer attachment',
    );
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
    assert.equal(afterAdd.draft, originalDraft);
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
      await original.locator('summary').click();
    assert.equal(
      await original.locator('pre').textContent(),
      attachment.content,
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
    await openNativeTerminalInspector(page);
    await tab.waitFor();
    process.kill(nodePid, 0);
    await page
      .locator('.attachment-strip')
      .getByRole('button', { name: `remove ${attachment.name}`, exact: true })
      .click();
    await until(
      async () =>
        !currentSession(await state(), sessionId).attachments.some(
          (a) => a.id === attachment.id,
        ),
      'existing attachment remove takes effect',
    );
    assert.equal(currentSession(await state(), sessionId).draft, originalDraft);
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
          .getByRole('button', { name: 'close terminal', exact: true })
          .click();
        await until(
          async () =>
            !(await query('terminal', 'list')).some(
              (t) => t.id === terminal.id && t.status === 'running',
            ),
          'helper-owned terminal stops after explicit close',
        );
        receipt.cleanup = 'owned terminal explicitly closed';
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
    const childContent = await readFile(
      join(childWorktree, sourcePath),
      'utf8',
    );
    assert.equal(childContent, 'isolated task output\n');
    // Deliberately create the same relative path only after isolated tasks have finished.
    // wx refuses an existing file; this helper cannot overwrite prior fixture or user data.
    await writeFile(join(workspace, sourcePath), parentContent, { flag: 'wx' });
    const previousDraft = parent.draft;
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
    assert.equal(currentSession(await state(), sessionId).draft, previousDraft);
    await record.getByRole('button', { name: 'main', exact: true }).click();
    await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
    await page.keyboard.press('ControlOrMeta+p');
    const search = page.getByRole('textbox', {
      name: 'search workspace files',
      exact: true,
    });
    await search.fill(fixture.otherFile);
    await page
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
        (await file.locator('.view-lines').innerText()).includes(
          fixture.changedOther.trim(),
        ),
      'manual edit reaches actual Monaco buffer',
    );
    await page.keyboard.press('ControlOrMeta+s');
    await until(
      async () =>
        (await readFile(join(workspace, fixture.otherFile), 'utf8')) ===
        fixture.changedOther,
      'another parent file actually saves',
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
