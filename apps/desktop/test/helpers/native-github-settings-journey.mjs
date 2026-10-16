import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const unavailable =
  'GitHub connection is unavailable; enable the bundled GitHub extension in Circle desktop.';
const extension = (snapshot) =>
  snapshot.extensions.find(
    (item) => item.name === 'github' && item.scope === 'bundled',
  );
const otherExtensions = (snapshot) =>
  snapshot.extensions
    .filter((item) => item.name !== 'github')
    .map((item) => ({
      id: item.id,
      enabled: item.enabled,
      tools: [...item.tools].sort(),
      commands: [...item.commands].sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
const view = (page, sessionId) =>
  page.evaluate((id) => {
    const stored = JSON.parse(
      localStorage.getItem('circle.workbench.live.views.v1') ?? '{"views":[]}',
    );
    const item = stored.views.find(([key]) => key === id)?.[1];
    return {
      draft: item?.draft ?? '',
      attachments: item?.attachments ?? [],
      pastes: item?.pastes ?? {},
    };
  }, sessionId);
const requestCount = async (path) =>
  (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).length;

/** Original settings UI only. Never clicks authorization or invokes a GitHub tool/command. */
export async function runNativeGitHubSettingsJourney({
  page,
  sessionId,
  state,
  until,
  output,
  settingsFile,
  requestsPath,
}) {
  const receipt = { checks: [] };
  const openSettings = async () => {
    await page
      .locator('.sidebar')
      .getByRole('button', { name: 'settings', exact: true })
      .click();
    await page.locator('#github-connection').waitFor();
    return page.locator('#github-connection');
  };
  const openExtensions = async (card) => {
    const direct = card.getByRole('link', { name: 'extensions', exact: true });
    if (await direct.isVisible()) await direct.click();
    else {
      await page
        .locator('.sidebar')
        .getByRole('link', { name: 'customize', exact: true })
        .click();
      await page
        .locator('.customize-tabs')
        .getByRole('link', { name: 'extensions', exact: true })
        .click();
    }
    await page
      .getByRole('heading', { name: 'extensions', exact: true })
      .waitFor();
    const runtimeTab = page.getByRole('button', {
      name: 'runtime extensions',
      exact: true,
    });
    if (await runtimeTab.isVisible()) await runtimeTab.click();
    const row = page.locator('.extension-card').filter({
      has: page.getByRole('heading', { name: 'github', exact: true }),
    });
    assert.equal(
      await row.count(),
      1,
      'the bundled GitHub extension has one original settings row',
    );
    return row.getByRole('checkbox', { name: 'enable github', exact: true });
  };
  const verifyDisabled = (snapshot) => {
    const item = extension(snapshot);
    assert(item && item.enabled === false);
    assert.equal(item.view, undefined);
    assert.equal(item.tools.includes('github_connection'), false);
    assert.equal(
      snapshot.tools.some((tool) => tool.name === 'github_connection'),
      false,
    );
    assert.equal(
      snapshot.commands.some(
        (command) => command.name === 'github' && command.scope === 'extension',
      ),
      false,
    );
  };
  let initial;
  try {
    initial = await state();
    assert.equal(initial.activeSessionId, sessionId);
    verifyDisabled(initial);
    const parent = initial.sessions.find((item) => item.id === sessionId);
    assert(parent);
    const draft = await page
      .getByRole('textbox', { name: 'message', exact: true })
      .inputValue();
    const local = await view(page, sessionId);
    const messages = parent.messages.map((message) => message.id);
    const calls = await requestCount(requestsPath);
    const others = otherExtensions(initial);
    let card = await openSettings();
    await card.getByText(unavailable, { exact: true }).waitFor();
    await page.screenshot({
      path: join(output, 'github-settings-default-unavailable.png'),
    });
    const toggle = await openExtensions(card);
    assert.equal(await toggle.isChecked(), false);
    await toggle.click();
    await until(async () => {
      const item = extension(await state());
      return item?.enabled === true && item.view?.provider === 'github';
    }, 'original extension UI enables the actual native GitHub provider');
    await until(
      () => toggle.isChecked(),
      'the original GitHub switch reflects the confirmed enabled state',
    );
    const enabled = await state();
    const github = extension(enabled);
    assert.equal(github.view.client, 'GitHub CLI');
    assert.equal(github.view.state, 'disconnected');
    assert.deepEqual(github.view.repositories, []);
    assert.equal(github.view.account, undefined);
    assert.equal(github.view.authorization, undefined);
    assert(github.tools.includes('github_connection'));
    assert(github.commands.includes('github'));
    const statusTool = enabled.tools.find(
      (tool) => tool.name === 'github_connection',
    );
    assert(statusTool);
    assert.equal(
      statusTool.kind,
      'read',
      'the disconnected status tool is actually read-only',
    );
    assert(
      enabled.commands.some(
        (command) => command.name === 'github' && command.scope === 'extension',
      ),
    );
    assert.equal(
      enabled.tools.some(
        (tool) =>
          tool.name.startsWith('github_') && tool.name !== 'github_connection',
      ),
      false,
      'repository action tools are not granted while disconnected',
    );
    assert.deepEqual(otherExtensions(enabled), others);
    assert.equal(
      JSON.parse(await readFile(settingsFile, 'utf8')).extensions.github
        .enabled,
      true,
    );
    card = await openSettings();
    await card
      .getByText('authorization application: GitHub CLI', { exact: true })
      .waitFor();
    await card.getByText('GitHub login required', { exact: true }).waitFor();
    const repositories = card.getByPlaceholder('owner/repository', {
      exact: true,
    });
    assert.equal(await repositories.inputValue(), '');
    const storage = card.locator('select');
    assert.equal(await storage.count(), 1);
    assert.deepEqual(
      await storage.locator('option').evaluateAll((options) =>
        options.map((option) => ({
          value: option.value,
          text: option.textContent,
        })),
      ),
      [
        { value: 'encrypted', text: 'secure storage' },
        { value: 'session', text: 'this session only' },
      ],
    );
    await storage.selectOption('session');
    assert.equal(await storage.inputValue(), 'session');
    const authorize = card.getByRole('button', {
      name: 'start GitHub authorization',
      exact: true,
    });
    assert.equal(
      await authorize.isEnabled(),
      true,
      'an empty optional allowlist does not block the original authorization control',
    );
    await storage.selectOption('encrypted');
    assert.equal(await authorize.isEnabled(), true);
    assert.equal(
      extension(await state()).view.state,
      'disconnected',
      'changing unsent storage choices does not authorize',
    );
    assert.equal(extension(await state()).view.authorization, undefined);
    await page.screenshot({
      path: join(output, 'github-settings-enabled-disconnected.png'),
    });
    receipt.enabled = {
      extension: github,
      tools: enabled.tools
        .filter((tool) => tool.name.startsWith('github_'))
        .map((tool) => tool.name),
      commands: github.commands,
    };
    const disable = await openExtensions(card);
    await until(
      () => disable.isChecked(),
      'the original GitHub switch is enabled before the explicit disable click',
    );
    await disable.click();
    await until(
      async () => extension(await state())?.enabled === false,
      'original extension UI disables GitHub',
    );
    await until(
      async () => !(await disable.isChecked()),
      'the original GitHub switch reflects the confirmed disabled state',
    );
    const disabled = await state();
    verifyDisabled(disabled);
    assert.deepEqual(otherExtensions(disabled), others);
    assert.equal(
      JSON.parse(await readFile(settingsFile, 'utf8')).extensions.github
        .enabled,
      false,
    );
    card = await openSettings();
    await card.getByText(unavailable, { exact: true }).waitFor();
    assert.equal(
      await card
        .getByRole('button', {
          name: 'start GitHub authorization',
          exact: true,
        })
        .count(),
      0,
    );
    await page.screenshot({
      path: join(output, 'github-settings-disabled-unavailable.png'),
    });
    await page
      .locator(`.sidebar .session-link[href="#/session/${sessionId}"]`)
      .click();
    await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole('textbox', { name: 'message', exact: true })
        .inputValue(),
      draft,
    );
    assert.deepEqual(await view(page, sessionId), local);
    const final = await state();
    assert.equal(final.activeSessionId, sessionId);
    assert.deepEqual(
      final.sessions
        .find((item) => item.id === sessionId)
        .messages.map((message) => message.id),
      messages,
    );
    assert.equal(
      await requestCount(requestsPath),
      calls,
      'settings toggles never trigger another model request',
    );
    receipt.status = 'passed';
    receipt.checks.push(
      'original bundled extension starts disabled',
      'actual native GitHub provider and status tool register while disconnected',
      'original storage and empty optional repository controls remain usable without authorization',
      'disabling removes actual tools and returns original card to unavailable',
      'other extensions, original draft and model-request count remain unchanged',
    );
    receipt.authorization =
      'not clicked; no grant, GitHub API or credential access requested';
    return receipt;
  } catch (error) {
    receipt.status = 'failed';
    receipt.error = String(error);
    receipt.actual = await state()
      .then((snapshot) => ({
        github: extension(snapshot),
        githubTools: snapshot.tools
          .filter((tool) => tool.name.startsWith('github_'))
          .map((tool) => tool.name),
      }))
      .catch((error) => ({ error: String(error) }));
    receipt.preference = await readFile(settingsFile, 'utf8')
      .then((text) => JSON.parse(text).extensions?.github ?? null)
      .catch((error) => ({ error: String(error) }));
    receipt.ui = await page
      .evaluate(() => ({
        route: location.hash,
        errors: [
          ...document.querySelectorAll('[role=alert],.inline-error,.notice'),
        ].map((node) => node.textContent),
      }))
      .catch((error) => ({ error: String(error) }));
    const failedToggle = page.getByRole('checkbox', {
      name: 'enable github',
      exact: true,
    });
    receipt.uiSwitch = (await failedToggle.count())
      ? { checked: await failedToggle.isChecked() }
      : { present: false };
    await page
      .screenshot({ path: join(output, 'github-settings-native-failure.png') })
      .catch(() => {});
    throw error;
  } finally {
    // Restore only a helper-enabled extension. Never authorize or disconnect an account.
    try {
      if (
        initial &&
        extension(initial)?.enabled === false &&
        extension(await state())?.enabled === true
      ) {
        try {
          const card = await openSettings();
          const toggle = await openExtensions(card);
          await until(
            () => toggle.isChecked(),
            'the enabled GitHub switch is visible before cleanup',
          );
          await toggle.click();
          await until(
            async () => extension(await state())?.enabled === false,
            'restore the initial disabled extension state',
          );
          await until(
            async () => !(await toggle.isChecked()),
            'cleanup is reflected by the original GitHub switch',
          );
          receipt.cleanup = 'GitHub extension restored to disabled';
        } catch (error) {
          receipt.cleanup = { error: String(error) };
        }
      }
    } catch (error) {
      receipt.cleanup = { error: String(error) };
    }
    await writeFile(
      join(output, 'github-settings-native-receipt.json'),
      JSON.stringify(receipt, null, 2),
    );
  }
}
