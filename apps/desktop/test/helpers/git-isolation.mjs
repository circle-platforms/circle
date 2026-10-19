import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let emptyConfig;

/**
 * The environment for a fixture's own Git commands: the machine's system and
 * global configuration are left out, so a credential helper installed there
 * (Git Credential Manager on Windows, osxkeychain on macOS) and a prompt
 * program are never consulted. `overrides` come last and win.
 */
export function isolatedGitEnv(overrides = {}, base = process.env) {
  if (!emptyConfig) {
    const folder = mkdtempSync(join(tmpdir(), 'circle-test-gitconfig-'));
    emptyConfig = join(folder, 'empty.gitconfig');
    writeFileSync(emptyConfig, '');
    process.once('exit', () =>
      rmSync(folder, { recursive: true, force: true }),
    );
  }
  const env = { ...base };
  for (const name of Object.keys(env))
    if (
      /^(GIT_ASKPASS|SSH_ASKPASS|GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+)$/i.test(
        name,
      )
    )
      delete env[name];
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    ...overrides,
  };
}
