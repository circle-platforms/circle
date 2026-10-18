import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  realpath,
  symlink,
} from 'node:fs/promises';
import { LspClient } from '../../../src/lsp_tool';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  LspLanguageService,
  WorkspaceLanguageService,
} from '../src/workspace/lsp-language';
import { patience } from './helpers/patience.mjs';

const lspFixture = fileURLToPath(
  new URL('../../../tests/fixtures/lsp-server.ts', import.meta.url),
);

test('optional LSP overlays reuse transport, preserve disk, convert positions and reject stale replies', async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), 'circle-lsp-overlay-')),
  );
  const log = path.join(root, 'protocol.json');
  const previous = process.env.LSP_TEST_LOG;
  process.env.LSP_TEST_LOG = log;
  const file = path.join(root, 'main.py');
  await writeFile(file, 'disk');
  const service = new LspLanguageService(root, {
    servers: {
      '.py': {
        command: process.execPath,
        args: [lspFixture],
      },
    },
    authorizePath: async (relative) => {
      if (relative.includes('secret')) throw Error('credential path denied');
      return path.join(root, relative);
    },
  });
  try {
    assert.deepEqual(
      await service.call('sync', {
        path: 'main.py',
        content: 'unsaved λ',
        version: 5,
      }),
      { version: 5 },
    );
    if (previous === undefined) delete process.env.LSP_TEST_LOG;
    else process.env.LSP_TEST_LOG = previous;
    await service.call('change', {
      path: 'main.py',
      content: 'new overlay',
      version: 6,
    });
    await assert.rejects(
      service.call('change', { path: 'main.py', content: 'older', version: 5 }),
      /stale/,
    );
    assert.equal(await readFile(file, 'utf8'), 'disk');
    assert.deepEqual(await service.call('completion', { path: 'main.py' }), [
      {
        label: 'unsaved',
        insertText: 'unsaved',
        kind: '6',
        sortText: undefined,
      },
    ]);
    const edits = (await service.call('rename', {
      path: 'main.py',
      newName: 'next',
    })) as any[];
    assert.equal(edits[0].path, 'main.py');
    assert.equal(edits[0].range.startLineNumber, 1);
    assert.equal(edits[0].text, 'next');
    const diagnostics = (await service.call('diagnostics', {
      path: 'main.py',
    })) as any[];
    assert.equal(diagnostics[0].severity, 8);
    assert.equal(diagnostics[0].message, 'overlay diagnostic');
    const pending = service.call('references', {
      path: 'main.py',
      line: 2,
      column: 3,
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    await service.call('change', {
      path: 'main.py',
      content: 'latest',
      version: 7,
    });
    await assert.rejects(pending, /stale language response/);
    await assert.rejects(
      service.call('sync', { path: '../outside.py' }),
      /relative/,
    );
    await assert.rejects(
      service.call('sync', { path: 'secret.py' }),
      /credential/,
    );
    await assert.rejects(
      service.call('sync', { path: 'main.ts' }),
      /bundled TypeScript/,
    );
    await service.call('close', { path: 'main.py' });
    // Request/reply is a protocol barrier proving the server consumed didClose.
    await service.call('sync', {
      path: 'main.py',
      content: 'reopened',
      version: 1,
    });
    await service.call('completion', { path: 'main.py' });
    await service.dispose();
    await assert.rejects(service.call('project', {}), /closed/);
    const records = JSON.parse(await readFile(log, 'utf8')) as any[];
    assert.equal(
      records.filter((row) => row.method === 'initialize').length,
      1,
    );
    assert.equal(
      records.find((row) => row.method === 'textDocument/didOpen').params
        .textDocument.text,
      'unsaved λ',
    );
    assert.equal(
      records.find((row) => row.method === 'textDocument/didChange').params
        .contentChanges[0].text,
      'new overlay',
    );
    const request = records.find(
      (row) => row.method === 'textDocument/references',
    );
    assert.deepEqual(request.params.position, { line: 1, character: 2 });
    assert.equal(
      records.filter((row) => row.method === 'textDocument/didClose').length,
      1,
    );
  } finally {
    if (previous === undefined) delete process.env.LSP_TEST_LOG;
    else process.env.LSP_TEST_LOG = previous;
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('LSP lifecycle fails honestly for missing servers and rejects symlink escapes', async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), 'circle-lsp-lifecycle-')),
  );
  const outside = await realpath(
    await mkdtemp(path.join(tmpdir(), 'circle-lsp-outside-')),
  );
  await writeFile(path.join(root, 'main.py'), 'disk');
  await writeFile(path.join(outside, 'outside.py'), 'outside');
  await symlink(
    outside,
    path.join(root, 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const service = new LspLanguageService(root, {
    servers: {
      '.py': { command: 'circle-definitely-missing-language-server', args: [] },
    },
    authorizePath: async (relative) => path.join(root, relative),
  });
  try {
    await assert.rejects(
      service.call('sync', { path: 'linked/outside.py' }),
      /outside workspace/,
    );
    await assert.rejects(
      service.call('sync', { path: 'main.py' }),
      /ENOENT|closed/,
    );
    const failed = (await service.call('status', { path: 'main.py' })) as any;
    assert.equal(failed.state, 'failed');
    assert.equal(failed.reason, 'ENOENT');
    await Promise.all([service.dispose(), service.dispose()]);
    await assert.rejects(service.call('sync', { path: 'main.py' }), /closed/);
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('composite preserves bundled TS and markdown behavior and splits mixed unsaved overlays', async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), 'circle-lsp-composite-')),
  );
  await writeFile(path.join(root, 'main.py'), 'disk');
  await writeFile(path.join(root, 'main.ts'), 'const value: number = 1;');
  await writeFile(path.join(root, 'README.md'), '# notes');
  const checked: string[] = [];
  const service = new WorkspaceLanguageService(root, {
    servers: {
      '.py': {
        command: process.execPath,
        args: [lspFixture],
      },
    },
    authorizePath: async (relative) => {
      checked.push(relative);
      if (
        relative.includes('secret') ||
        relative.includes('..') ||
        path.isAbsolute(relative)
      )
        throw Error('path denied');
      return path.join(root, relative);
    },
  });
  try {
    await service.call('sync', {
      path: 'main.ts',
      documents: [
        { path: 'main.py', content: 'unsaved python', version: 3 },
        { path: 'main.ts', content: 'const value: number = "bad";' },
      ],
    });
    const diagnostics = (await service.call('diagnostics', {
      path: 'main.ts',
    })) as any[];
    assert.ok(
      diagnostics.some((row) => row.message.includes('not assignable')),
    );
    const completion = (await service.call('completion', {
      path: 'main.py',
    })) as any[];
    assert.equal(completion[0].label, 'unsaved');
    assert.deepEqual(
      await service.call('diagnostics', { path: 'README.md' }),
      [],
    );
    await assert.rejects(
      service.call('sync', {
        path: 'main.ts',
        documents: [{ path: 'secret.py', content: 'secret' }],
      }),
      /denied/,
    );
    assert.ok(checked.includes('main.ts') && checked.includes('main.py'));
    service.invalidate(['main.ts']);
    await service.call('refresh', {});
    assert.equal(
      await readFile(path.join(root, 'main.ts'), 'utf8'),
      'const value: number = 1;',
    );
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('held rename rejects changed target buffers for unversioned changes and null versions through request bridge', async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), 'circle-lsp-rename-')),
  );
  await writeFile(path.join(root, 'main.py'), 'source');
  await writeFile(path.join(root, 'other.py'), 'target');
  const oldLog = process.env.LSP_TEST_LOG;
  const log = path.join(root, 'held-protocol.json');
  process.env.LSP_TEST_LOG = log;
  const service = new WorkspaceLanguageService(root, {
    servers: {
      '.py': {
        command: process.execPath,
        args: [lspFixture],
      },
    },
    authorizePath: async (relative) => path.join(root, relative),
  });
  try {
    await service.call('sync', {
      path: 'main.py',
      content: 'source',
      version: 1,
    });
    await service.call('sync', {
      path: 'other.py',
      content: 'target',
      version: 1,
    });
    if (oldLog === undefined) delete process.env.LSP_TEST_LOG;
    else process.env.LSP_TEST_LOG = oldLog;
    for (const [index, newName] of ['held-changes', 'held-null'].entries()) {
      const pending = service.call('request', {
        method: 'rename',
        path: 'main.py',
        newName,
      });
      // Observed from the start: a rejection that arrives before the assertion below
      // must fail that assertion, not the process as an unhandled rejection.
      const outcome = pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      // The real server holds this reply until didChange; await recorded receipt, not a timing guess.
      const deadline = Date.now() + patience(1000);
      while (true) {
        const records = JSON.parse(await readFile(log, 'utf8')) as any[];
        if (
          records.filter((row) => row.method === 'textDocument/rename').length >
          index
        )
          break;
        assert.ok(Date.now() < deadline, 'server receives held rename');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await service.call('change', {
        path: 'other.py',
        content: `target ${index}`,
        version: index + 2,
      });
      assert.match(String(await outcome), /stale language rename target/);
    }
    const result = (await service.call('request', {
      method: 'rename',
      path: 'main.py',
      newName: 'held-stable',
    })) as any[];
    assert.equal(result[0].path, 'other.py');
    assert.equal(result[0].text, 'renamed');
    const completions = (await service.call('request', {
      method: 'completion',
      path: 'main.py',
    })) as any[];
    assert.equal(completions[0].label, 'unsaved');
    assert.equal(await readFile(path.join(root, 'other.py'), 'utf8'), 'target');
    await service.call('close', { path: 'other.py' });
    await assert.rejects(
      service.call('request', {
        method: 'rename',
        path: 'main.py',
        newName: 'held-stable',
      }),
      /open all affected files/,
    );
  } finally {
    if (oldLog === undefined) delete process.env.LSP_TEST_LOG;
    else process.env.LSP_TEST_LOG = oldLog;
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('language process status observes real PID, bounded stderr, stop and restart with unsaved overlay', async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), 'circle-lsp-process-')),
  );
  const log = path.join(root, 'process.json');
  const oldLog = process.env.LSP_TEST_LOG;
  process.env.LSP_TEST_LOG = log;
  await writeFile(path.join(root, 'main.py'), 'disk');
  await writeFile(path.join(root, 'main.ts'), 'const value = 1;');
  const service = new WorkspaceLanguageService(root, {
    servers: {
      '.py': {
        command: process.execPath,
        args: [lspFixture, '--process-observation'],
      },
    },
    authorizePath: async (relative) => path.join(root, relative),
  });
  try {
    const idle = (await service.call('request', {
      method: 'status',
      path: 'main.py',
    })) as any;
    assert.equal(idle.state, 'idle');
    assert.equal(idle.pid, undefined);
    await service.call('sync', {
      path: 'main.py',
      content: 'unsaved overlay',
      version: 9,
    });
    const before = (await service.call('request', {
      method: 'status',
      path: 'main.py',
    })) as any;
    assert.equal(before.state, 'running');
    assert.ok(before.pid > 0);
    assert.ok(before.stderrTail.length <= 8192);
    assert.ok(!before.stderrTail.includes('fixture-secret'));
    const stopped = (await service.call('request', {
      method: 'stop',
      path: 'main.py',
    })) as any;
    assert.equal(stopped.state, 'exited');
    assert.equal(stopped.reason, 'stopped');
    assert.throws(() => process.kill(before.pid, 0));
    const after = (await service.call('request', {
      method: 'restart',
      path: 'main.py',
    })) as any;
    assert.equal(after.state, 'running');
    assert.notEqual(after.pid, before.pid);
    await service.call('completion', { path: 'main.py' });
    const records = JSON.parse(await readFile(log, 'utf8')) as any[];
    const opened = records.find((row) => row.method === 'textDocument/didOpen');
    assert.equal(opened.params.textDocument.text, 'unsaved overlay');
    assert.equal(opened.params.textDocument.version, 9);
    assert.equal(await readFile(path.join(root, 'main.py'), 'utf8'), 'disk');
    const builtin = (await service.call('request', {
      method: 'status',
      path: 'main.ts',
    })) as any;
    assert.equal(builtin.kind, 'in-process');
    assert.equal(builtin.pid, undefined);
    assert.equal(builtin.canStop, false);
    assert.equal(
      (
        (await service.call('request', {
          method: 'restart',
          path: 'main.ts',
        })) as any
      ).restart,
      'refresh',
    );
    await assert.rejects(
      service.call('request', { method: 'stop', path: 'main.ts' }),
      /cannot be stopped separately/,
    );
  } finally {
    if (oldLog === undefined) delete process.env.LSP_TEST_LOG;
    else process.env.LSP_TEST_LOG = oldLog;
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
  const child = new LspClient(
    {
      command: process.execPath,
      args: [
        '-e',
        'process.stderr.write("fatal diagnostic\\n"); process.exit(7)',
      ],
    },
    tmpdir(),
  );
  await assert.rejects(child.initialize(new AbortController().signal));
  await child.close();
  assert.equal(child.processSnapshot().exitCode, 7);
  assert.equal(child.processSnapshot().reason, 'non-zero exit');
});
