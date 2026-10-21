import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { scratch } from '../../../tests/helpers.ts';
import { spawnPty } from '../src/workspace/native-pty.ts';

const require = createRequire(import.meta.url);
const { Terminal } =
  require('@xterm/headless') as typeof import('@xterm/headless');
const source = (path: string) => new URL(path, import.meta.url).href;

for (const theme of ['dark', 'light']) {
  test(
    `Windows TUI ${theme} shutdown restores the main screen and cooked input before a natural exit`,
    { skip: process.platform !== 'win32' && 'requires real Windows ConPTY' },
    async (t) => {
      const root = scratch(t, 'circle-tui-conpty-exit-');
      const fixture = join(root, 'session.mjs');
      const receipt = join(root, 'input.json');
      const ready = join(root, 'ready');
      const restored = join(root, 'restored');
      await writeFile(
        fixture,
        `import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {SessionApp} from ${JSON.stringify(source('../../../src/tui/session_app.ts'))};
import {defaultSettings} from ${JSON.stringify(source('../../../src/settings.ts'))};
import {loadChildrenApi} from ${JSON.stringify(source('../../../src/windows_stranded.ts'))};
const settings=defaultSettings();settings.theme=${JSON.stringify(theme)};
const app=new SessionApp(process.cwd(),process.env.CIRCLE_HOME,settings);
process.stdout.write('ORIGINAL_MAIN_SCREEN\\r\\n');
app.start();
await loadChildrenApi();
const stop=bytes=>{if(String(bytes).includes('\\x07'))app.exit(0)};
process.stdin.on('data',stop);
writeFileSync(${JSON.stringify(ready)},'ready');
await app.wait();
process.stdin.off('data',stop);
await app.close();
assert.equal(process.stdin.isRaw,false);
const input=new Promise(resolve=>process.stdin.once('data',resolve));
process.stdin.resume();
process.stdout.write('RESTORED_INPUT_READY\\r\\n');
writeFileSync(${JSON.stringify(restored)},'restored');
const line=await input;
assert.equal(String(line),'COOKED_INPUT_SENTINEL\\r\\n');
writeFileSync(${JSON.stringify(receipt)},JSON.stringify({raw:process.stdin.isRaw,line:String(line)}));
process.stdin.pause();
process.exitCode=7;
`,
      );
      const terminal = new Terminal({
        cols: 80,
        rows: 24,
        allowProposedApi: true,
      });
      const pty = spawnPty(
        process.execPath,
        ['--import', pathToFileURL(require.resolve('tsx')).href, fixture],
        {
          cwd: root,
          env: {
            ...process.env,
            NODE_OPTIONS: '',
            CIRCLE_HOME: join(root, 'home'),
            CIRCLE_WORKBENCH_DATA_DIR: join(root, 'data'),
          },
          cols: 80,
          rows: 24,
        },
      );
      let raw = '';
      let exited = false;
      const completion = new Promise<number>((resolve) => {
        pty.onExit(({ exitCode }) => {
          exited = true;
          resolve(exitCode);
        });
        pty.onData((data) => {
          raw += data;
          terminal.write(data);
        });
      });
      terminal.onData((data) => pty.write(data));
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const waiting = new AbortController();
      const waitForState = async (path: string) => {
        while (!existsSync(path)) {
          assert.equal(exited, false, `the TUI exited before ${path}: ${raw}`);
          await delay(10, undefined, { signal: waiting.signal });
        }
      };
      try {
        const exitCode = await Promise.race([
          (async () => {
            await waitForState(ready);
            pty.write('\x07');
            await waitForState(restored);
            pty.write('COOKED_INPUT_SENTINEL\r');
            return completion;
          })(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () =>
                reject(
                  Error(
                    `the owned TUI did not finish its input/exit handshake: ${JSON.stringify({ ready: existsSync(ready), restored: existsSync(restored), exited, raw })}`,
                  ),
                ),
              20000,
            );
          }),
        ]);
        assert.equal(exitCode, 7, raw);
        await new Promise<void>((resolve) => terminal.write('', resolve));
        assert.equal(terminal.buffer.active.type, 'normal');
        const screen = Array.from(
          { length: terminal.buffer.active.length },
          (_, index) =>
            terminal.buffer.active.getLine(index)?.translateToString(true),
        ).join('\n');
        assert.match(screen, /ORIGINAL_MAIN_SCREEN/);
        assert.match(screen, /RESTORED_INPUT_READY/);
        assert.deepEqual(JSON.parse(await readFile(receipt, 'utf8')), {
          raw: false,
          line: 'COOKED_INPUT_SENTINEL\r\n',
        });
      } finally {
        waiting.abort();
        clearTimeout(timeout);
        const evidence = process.env.CIRCLE_NATIVE_TEST_PROGRESS_DIR;
        if (evidence) {
          await mkdir(evidence, { recursive: true });
          await writeFile(join(evidence, `tui-exit-${theme}.raw.txt`), raw);
          t.diagnostic(JSON.stringify({ theme, evidence, root, exited }));
        }
        if (!exited) pty.kill();
        terminal.dispose();
      }
    },
  );
}
