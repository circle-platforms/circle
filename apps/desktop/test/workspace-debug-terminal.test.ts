import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceServices } from '../src/workspace/workspace-services.ts';
import type {
  TerminalSnapshot,
  TerminalReplay,
} from '../src/workspace/terminal.ts';
test(
  'Node debugging uses an owned interactive PTY and preserves literal empty argv',
  { timeout: 45000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'circle-debug-terminal-'));
    const data = await mkdtemp(
      path.join(tmpdir(), 'circle-debug-terminal-data-'),
    );
    const runtime = process.env.CIRCLE_JS_DEBUG_RUNTIME ?? process.execPath;
    const adapter =
      process.env.CIRCLE_JS_DEBUG_ADAPTER ??
      fileURLToPath(
        new URL(
          '../dist/tools/js-debug/src/dapDebugServer.js',
          import.meta.url,
        ),
      );
    await realpath(adapter);
    const service = new WorkspaceServices({
      workspaceRoot: root,
      dataDir: data,
      nodeExecutable: process.execPath,
      runtimeExecutable: runtime,
      adapterPath: adapter,
      ghPath: 'unused',
      terminalEnv: {
        HOME: root,
        ZDOTDIR: root,
        HISTFILE: path.join(root, '.history'),
        ENV: '',
        BASH_ENV: '',
      },
      emit: () => {},
    });
    try {
      const program = path.join(root, 'interactive.cjs');
      await writeFile(
        program,
        "console.log('ARGV64:'+Buffer.from(JSON.stringify(process.argv.slice(2))).toString('base64'));require('readline').createInterface({input:process.stdin}).on('line',line=>console.log('INPUT:'+line));setInterval(()=>{},1000);\n",
      );
      const argv = ['', 'space value', "literal '$()'"];
      await service.call('debug-owner', 'debug', 'launch', {
        program,
        args: argv,
      });
      const terminals = (await service.call(
        'debug-owner',
        'terminal',
        'list',
      )) as TerminalSnapshot[];
      const terminal = terminals.find((item) => item.label === 'debug');
      assert.ok(terminal?.pid);
      assert.equal(terminal.owner, 'debug-owner');
      assert.ok(
        terminal.command?.args?.includes(''),
        'adapter lost empty argv before PTY: ' +
          JSON.stringify(terminal.command),
      );
      const expected =
        'ARGV64:' + Buffer.from(JSON.stringify(argv)).toString('base64');
      async function outputContains(marker: string) {
        for (let i = 0; i < 500; i++) {
          const replay = (await service.call(
            'debug-owner',
            'terminal',
            'replay',
            { id: terminal!.id },
          )) as TerminalReplay;
          if (
            replay.events
              .map((e) => e.data ?? '')
              .join('')
              .includes(marker)
          )
            return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const replay = (await service.call(
          'debug-owner',
          'terminal',
          'replay',
          { id: terminal!.id },
        )) as TerminalReplay;
        throw Error(
          'debug terminal output missing ' +
            marker +
            ' actual=' +
            replay.events
              .map((e) => e.data ?? '')
              .join('')
              .slice(-4000) +
            ' state=' +
            JSON.stringify(
              await service.call('debug-owner', 'debug', 'snapshot'),
            ),
        );
      }
      await outputContains(expected);
      await service.call('debug-owner', 'terminal', 'write', {
        id: terminal.id,
        data: 'human input\r',
      });
      await outputContains('INPUT:human input');
      await assert.rejects(
        service.call('other-owner', 'terminal', 'write', {
          id: terminal.id,
          data: 'forbidden\r',
        }),
        /owner|owned|unknown|not found|belong/i,
      );
      await service.call('debug-owner', 'debug', 'stop');
      assert.throws(() => process.kill(terminal.pid!, 0));
      assert.equal(await service.hasActiveSession('debug-owner'), false);
    } finally {
      await service.dispose();
      await rm(root, { recursive: true, force: true });
      await rm(data, { recursive: true, force: true });
    }
  },
);
