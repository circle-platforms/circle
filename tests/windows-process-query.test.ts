import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import { runningFrom } from '../src/install_processes.js';
import {
  readWindowsQueryMarkers,
  windowsProcessQuery,
  WindowsProcessQueryObservation,
} from '../src/windows_process_query.js';

// A version folder of an installation, with one program in it that the test says is held.
function heldCopy(t: TestContext) {
  const base = mkdtempSync(join(tmpdir(), 'wq-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const version = join(base, 'version');
  mkdirSync(version);
  const program = join(version, 'circle.exe');
  writeFileSync(program, 'synthetic held image');
  return { base, folders: [version], program };
}

test('a held Windows copy is identified through one owned Node worker when PowerShell is unavailable', (t) => {
  const { folders, program } = heldCopy(t);
  let calls = 0;
  const pids = runningFrom(
    folders,
    'win32',
    (command, _args, timeout) => {
      calls++;
      assert.equal(command, process.execPath, 'PowerShell is unavailable');
      assert.equal(timeout, 30_000);
      return {
        status: 0,
        stdout: `41 ${Buffer.from(program).toString('base64')}\r\n`,
        stderr: '',
      };
    },
    () => 'EBUSY',
  );
  assert.deepEqual(pids, [41]);
  assert.equal(calls, 1);
});

test('an unreadable Windows copy fails closed when its all-process query fails without held images', (t) => {
  const { base, folders, program } = heldCopy(t);
  folders[0] = join(base, 'unavailable-version');
  let calls = 0;
  assert.throws(
    () =>
      runningFrom(
        folders,
        'win32',
        (_command, _args, timeout) => {
          calls++;
          assert.equal(timeout, 30_000);
          return {
            status: 1,
            stdout: '',
            stderr: 'Windows native process query unavailable',
          };
        },
        () => undefined,
      ),
    /could not be inspected.*could not be listed/,
  );
  assert.equal(calls, 1);
  assert.equal(readFileSync(program, 'utf8'), 'synthetic held image');
});

test('an unterminated PID record cannot turn an outside image path prefix into ownership', (t) => {
  const { folders } = heldCopy(t);
  let folder = folders[0]!;
  folder += 'x'.repeat((3 - (Buffer.byteLength(folder) % 3)) % 3);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'circle.exe'), 'synthetic held image');
  folders[0] = folder;
  const full = Buffer.from(folder + '-other/circle.exe').toString('base64');
  const partial = full.slice(0, (Buffer.byteLength(folder) / 3) * 4);
  assert.equal(Buffer.from(partial, 'base64').toString('utf8'), folder);
  assert.throws(
    () =>
      runningFrom(
        folders,
        'win32',
        () => ({
          status: null,
          stdout: `41 ${partial}`,
          stderr: '',
          error: Object.assign(new Error('native timeout'), {
            code: 'ETIMEDOUT',
          }),
        }),
        () => 'EBUSY',
        () => {},
      ),
    /could not be listed \(no answer in 30 s\)/,
  );
});

for (const kind of ['base64', 'utf8'] as const) {
  test(`a complete PID record with invalid ${kind} cannot establish image ownership`, (t) => {
    const { folders, program } = heldCopy(t);
    const encoded =
      kind === 'base64'
        ? Buffer.from(program).toString('base64') + '!'
        : Buffer.concat([Buffer.from(program), Buffer.from([0xff])]).toString(
            'base64',
          );
    assert.throws(
      () =>
        runningFrom(
          folders,
          'win32',
          () => ({
            status: 0,
            stdout: `41 ${encoded}\n`,
            stderr: '',
          }),
          () => 'EBUSY',
          () => {},
        ),
      /unknown.*invalid.*1/,
    );
  });
}

test('an unread copy with malformed successful output is unknown rather than an empty process list', (t) => {
  const { base, folders } = heldCopy(t);
  folders[0] = join(base, 'unavailable-version');
  assert.throws(
    () =>
      runningFrom(
        folders,
        'win32',
        () => ({
          status: 0,
          stdout: '41 truncated',
          stderr: '',
        }),
        () => undefined,
        () => {},
      ),
    /could not be inspected.*unknown.*incomplete.*1/,
  );
});

test('complete valid LF and CRLF PID records retain exact image ownership', (t) => {
  const { folders, program } = heldCopy(t);
  for (const newline of ['\n', '\r\n'])
    assert.deepEqual(
      runningFrom(
        folders,
        'win32',
        () => ({
          status: 0,
          stdout: `41 ${Buffer.from(program).toString('base64')}${newline}`,
          stderr: '',
        }),
        () => 'EBUSY',
      ),
      [41],
    );
});

test('a timed out Windows query keeps its original error message and attaches the last captured stage', (t) => {
  const { folders, program } = heldCopy(t);
  const nativeError = Object.assign(new Error('native timeout'), {
    code: 'ETIMEDOUT',
  });
  let calls = 0;
  assert.throws(
    () =>
      runningFrom(
        folders,
        'win32',
        (_command, args, timeout) => {
          calls++;
          assert.equal(timeout, 30_000);
          const nonce = args.at(-1)!;
          return {
            status: null,
            stdout: '',
            stderr: `CIRCLE_QUERY_${nonce} LOOKUP\r\n`,
            error: nativeError,
          };
        },
        () => 'EBUSY',
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        `${program} is in use, and the running programs could not be listed (no answer in 30 s)`,
      );
      assert.ok(
        error.cause instanceof Error,
        'the timeout carries a visible diagnostic cause',
      );
      assert.match(error.cause.message, /last captured stage: LOOKUP/);
      return true;
    },
  );
  assert.equal(calls, 1);
  assert.equal(nativeError.message, 'native timeout');
});

const nonce = '1234567890abcdef1234567890abcdef';
const marker = (stage: string, own = nonce) =>
  `CIRCLE_QUERY_${own} ${stage}\r\n`;

for (const [description, names] of [
  ['no names', []],
  ['one empty name', ['']],
  ['one image name', ['circle']],
  ['Unicode names', ['用户 image 🧪']],
  ['spaces and quotes', ['a name \' " `$();']],
  ['multiple names and empty entries', ['', 'circle', 'second image', '']],
] satisfies [string, string[]][]) {
  test(`image name payload preserves ${description} without JSON cmdlets`, () => {
    for (const all of [false, true]) {
      const { args } = windowsProcessQuery(names, all, nonce);
      assert.match(args[0]!, /windows_process_native\.[jt]s$/);
      assert.deepEqual(
        JSON.parse(Buffer.from(args[1]!, 'base64').toString('utf8')),
        names,
      );
      assert.equal(args[2], all ? 'all' : 'names');
      assert.equal(args[3], nonce);
    }
  });
}

test('image names containing NUL cannot change the payload item boundaries', () => {
  for (const all of [false, true]) {
    for (const names of [['\0'], ['a\0b'], ['circle', 'bad\0']]) {
      assert.throws(() => windowsProcessQuery(names, all, nonce), /NUL/);
    }
  }
});

test('a query with no complete marker reports unknown rather than a startup cause', () => {
  const markers = readWindowsQueryMarkers('original\r\ntail', nonce);
  assert.equal(markers.cleaned, 'original\r\ntail');
  assert.equal(markers.lastCapturedStage, 'unknown');
  assert.deepEqual(markers.counts, {
    DECODE: 0,
    LOOKUP: 0,
    MODULE: 0,
    DISPOSE: 0,
    COMPLETE: 0,
  });
  const observation = new WindowsProcessQueryObservation(markers, 30_010.4, {
    status: null,
  });
  assert.match(observation.message, /last captured stage: unknown/);
  assert.equal(observation.details.errorCode, 'unknown');
  assert.equal(observation.details.elapsedMs, 30_010);
});

test('captured boundaries and capped stages are reported without claiming a stalled operation', () => {
  const markers = readWindowsQueryMarkers(
    marker('DECODE') +
      marker('LOOKUP') +
      marker('MODULE').repeat(32) +
      marker('DISPOSE').repeat(32),
    nonce,
  );
  assert.equal(markers.lastCapturedStage, 'DISPOSE');
  assert.deepEqual(markers.possiblyCappedStages, ['MODULE', 'DISPOSE']);
  assert.equal(markers.counts.COMPLETE, 0);
  assert.equal(markers.cleaned, '');
  const observation = new WindowsProcessQueryObservation(markers, 30_000, {
    status: null,
  });
  assert.match(observation.message, /possibly capped stages: MODULE,DISPOSE/);
  assert.match(observation.message, /not the stalled operation/);
  const complete = readWindowsQueryMarkers(
    marker('DECODE') + marker('COMPLETE'),
    nonce,
  );
  assert.equal(complete.lastCapturedStage, 'COMPLETE');
  const failedAfterComplete = new WindowsProcessQueryObservation(complete, 9, {
    status: 7,
  });
  assert.equal(failedAfterComplete.details.status, 7);
  assert.match(failedAfterComplete.message, /last captured stage: COMPLETE/);
});

test('only own complete valid lines are stripped and all other stderr characters survive', () => {
  const untouched =
    marker('LOOKUP', 'f'.repeat(32)) +
    `CIRCLE_QUERY_${nonce} MODULE \r\n` +
    `CIRCLE_QUERY_${nonce} MODULE\r\r\n` +
    `CIRCLE_QUERY_${nonce} OTHER\n` +
    `CIRCLE_QUERY_${nonce} DISPOSE`;
  const markers = readWindowsQueryMarkers(
    'before\r\n' + marker('LOOKUP') + untouched,
    nonce,
  );
  assert.equal(markers.cleaned, 'before\r\n' + untouched);
  assert.deepEqual(markers.counts, {
    DECODE: 0,
    LOOKUP: 1,
    MODULE: 0,
    DISPOSE: 0,
    COMPLETE: 0,
  });
  assert.equal(markers.lastCapturedStage, 'LOOKUP');
});

test('both query modes use one explicit Node worker with lossless names and a bounded observation nonce', () => {
  for (const all of [false, true]) {
    const names = ['circle', '用户 image'];
    const { args, nonce: own } = windowsProcessQuery(names, all, nonce);
    assert.equal(args.length, 4);
    assert.match(args[0]!, /windows_process_native\.[jt]s$/);
    assert.deepEqual(
      JSON.parse(Buffer.from(args[1]!, 'base64').toString('utf8')),
      names,
    );
    assert.equal(args[2], all ? 'all' : 'names');
    assert.equal(own, nonce);
    assert.equal(args[3], nonce);
  }
});

test('nonzero exits preserve non-marker stderr in the primary message and leave the native result unchanged', (t) => {
  const { folders, program } = heldCopy(t);
  let native: {
    status: number;
    stdout: string;
    stderr: string;
    error: undefined;
  };
  assert.throws(
    () =>
      runningFrom(
        folders,
        'win32',
        (_command, args, timeout) => {
          assert.equal(timeout, 30_000);
          const own = args.at(-1)!;
          native = {
            status: 7,
            stdout: '',
            stderr: marker('MODULE', own) + 'Access denied\r\n',
            error: undefined,
          };
          return native;
        },
        () => 'EBUSY',
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        `${program} is in use, and the running programs could not be listed (Access denied)`,
      );
      assert.ok(error.cause instanceof WindowsProcessQueryObservation);
      assert.equal(error.cause.details.status, 7);
      assert.equal(error.cause.details.lastCapturedStage, 'MODULE');
      return true;
    },
  );
  assert.equal(native!.status, 7);
  assert.match(
    native!.stderr,
    /^CIRCLE_QUERY_[a-f0-9]{32} MODULE\r\nAccess denied\r\n$/,
  );
});

test('known PIDs still block installation even when the native query times out after producing them', (t) => {
  const { folders, program } = heldCopy(t);
  const nativeError = Object.assign(new Error('original native error'), {
    code: 'ETIMEDOUT',
  });
  const stdout = `41 ${Buffer.from(program).toString('base64')}\r\n`;
  let calls = 0;
  let reports = 0;
  const native = {
    status: null,
    stdout,
    stderr: 'original stderr',
    error: nativeError,
  };
  assert.deepEqual(
    runningFrom(
      folders,
      'win32',
      (_command, _args, timeout) => {
        calls++;
        assert.equal(timeout, 30_000);
        return native;
      },
      () => 'EBUSY',
      () => {
        reports++;
      },
    ),
    [41],
  );
  assert.equal(calls, 1);
  assert.equal(reports, 0, 'an identified PID must remain silent');
  assert.deepEqual(native, {
    status: null,
    stdout,
    stderr: 'original stderr',
    error: nativeError,
  });
  assert.equal(native.error, nativeError);
});

test('the query helper started from the copy itself is never a running copy', (t) => {
  const { folders, program } = heldCopy(t);
  // circle uninstall runs from the installation it removes: its own node is a held program of
  // the copy, and the helper started from that node lists itself among the processes.
  const helper = process.pid + 1;
  const other = process.pid + 2;
  const record = (pid: number) =>
    `${pid} ${Buffer.from(program).toString('base64')}\r\n`;
  const query = (stdout: string) => () => ({
    status: 0,
    pid: helper,
    stdout,
    stderr: '',
  });
  assert.deepEqual(
    runningFrom(
      folders,
      'win32',
      query(record(process.pid) + record(helper)),
      () => 'EBUSY',
      () => {},
    ),
    [],
  );
  assert.deepEqual(
    runningFrom(
      folders,
      'win32',
      query(record(process.pid) + record(helper) + record(other)),
      () => 'EBUSY',
      () => {},
    ),
    [other],
  );
  // Listed alone, the helper does not explain who holds the program: still unknown.
  assert.throws(
    () =>
      runningFrom(
        folders,
        'win32',
        query(record(helper)),
        () => 'EBUSY',
        () => {},
      ),
    /is in use by another program/,
  );
});

// An installed version as the Windows check sees it, on any system: its runtime and a file
// beside it, under a folder name outside any console code page.
function installedVersion(t: TestContext) {
  const { base } = heldCopy(t);
  const version = join(base, '用户 prefix', 'versions', '1.0.0');
  const node = join(version, 'runtime', 'node.exe');
  mkdirSync(join(version, 'runtime'), { recursive: true });
  mkdirSync(join(version, 'app'), { recursive: true });
  writeFileSync(node, 'synthetic runtime');
  writeFileSync(join(version, 'app', 'cli.js'), '');
  return { base, version, node };
}
// What the process list prints: an id and the program's path in Base64.
const processList = (entries: [number, string][]) => ({
  status: 0,
  stdout: entries
    .map(([pid, path]) => `${pid} ${Buffer.from(path).toString('base64')}\r\n`)
    .join(''),
  stderr: '',
  error: undefined,
});

test('on Windows a held program is looked up by name, and the list names the processes running a program of the installation', (t) => {
  const { base, version, node } = installedVersion(t);
  const probed: string[] = [];
  const asked: { command: string; args: string[]; timeout?: number }[] = [];
  const running = runningFrom(
    [version],
    'win32',
    (command, args, timeout) => {
      asked.push({ command, args, timeout });
      return processList([
        [7, join(base, 'elsewhere', 'node.exe')],
        [41, node],
      ]);
    },
    (path) => {
      probed.push(path);
      return path === node ? 'EBUSY' : undefined;
    },
  );
  assert.deepEqual(running, [41]);
  assert.deepEqual(probed, [node]);
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.command, process.execPath);
  assert.match(asked[0]!.args[0]!, /windows_process_native\.[jt]s$/);
  assert.equal(asked[0]!.args[2], 'names');
  assert.deepEqual(
    JSON.parse(Buffer.from(asked[0]!.args[1]!, 'base64').toString('utf8')),
    ['node'],
  );
  assert.equal(asked[0]!.timeout, 30_000);
});

test('on Windows a program in use that no process can be named for stops the removal, and says why', (t) => {
  const { base, version, node } = installedVersion(t);
  const busy = (path: string) => (path === node ? 'EBUSY' : undefined);
  const others = () => processList([[7, join(base, 'elsewhere', 'node.exe')]]);
  const says = (text: string) => (error: unknown) => {
    assert.equal((error as Error).message, text);
    return true;
  };
  const quiet = () => {};
  assert.throws(
    () =>
      runningFrom(
        [version],
        'win32',
        () => ({
          status: null,
          stdout: '',
          stderr: '',
          error: Object.assign(Error('spawnSync node ETIMEDOUT'), {
            code: 'ETIMEDOUT',
          }),
        }),
        busy,
        quiet,
      ),
    says(
      `${node} is in use, and the running programs could not be listed (no answer in 30 s)`,
    ),
  );
  assert.throws(
    () =>
      runningFrom(
        [version],
        'win32',
        () => ({
          status: 1,
          stdout: '',
          stderr: 'Access denied\r\n',
          error: undefined,
        }),
        busy,
        quiet,
      ),
    says(
      `${node} is in use, and the running programs could not be listed (Access denied)`,
    ),
  );
  assert.throws(
    () => runningFrom([version], 'win32', others, busy, quiet),
    says(`${node} is in use by another program`),
  );
  // A program that cannot be opened for another reason, a read-only file, is not in use.
  assert.deepEqual(
    runningFrom(
      [version],
      'win32',
      others,
      (path) => (path === node ? 'EPERM' : undefined),
      quiet,
    ),
    [],
  );
});

test('Windows process lookup matches the same held program through a directory alias', (t) => {
  const { base, version, node } = installedVersion(t);
  const alias = join(base, 'version alias');
  symlinkSync(
    version,
    alias,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const running = runningFrom(
    [version],
    'win32',
    () => processList([[41, join(alias, 'runtime', 'node.exe')]]),
    (path) => (path === node ? 'EBUSY' : undefined),
  );
  assert.deepEqual(running, [41]);
});

test('an unheld program does not start a query', (t) => {
  const { folders } = heldCopy(t);
  let reports = 0;
  assert.deepEqual(
    runningFrom(
      folders,
      'win32',
      () => assert.fail('unexpected query'),
      () => undefined,
      () => {
        reports++;
      },
    ),
    [],
  );
  assert.equal(reports, 0, 'an unheld program must remain silent');
});

test('the safe observation excludes raw streams and unexpected native codes', () => {
  const observation = new WindowsProcessQueryObservation(
    readWindowsQueryMarkers('private stream\r\n' + marker('LOOKUP'), nonce),
    3.8,
    {
      status: null,
      error: Object.assign(new Error('private error'), {
        code: 'private\nvalue',
      }),
    },
  );
  assert.equal(observation.details.errorCode, 'unknown');
  assert.doesNotMatch(observation.message, /private/);
});

test('a failing diagnostic sink cannot replace the original query failure', (t) => {
  const { folders, program } = heldCopy(t);
  const reports: string[] = [];
  const nativeError = Object.assign(new Error('original native error'), {
    code: 'EACCES',
  });
  assert.throws(
    () =>
      runningFrom(
        folders,
        'win32',
        () => ({
          status: null,
          stdout: '',
          stderr: 'original native stderr',
          error: nativeError,
        }),
        () => 'EBUSY',
        (summary) => {
          reports.push(summary);
          throw new Error('diagnostic sink failure');
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        `${program} is in use, and the running programs could not be listed (original native error)`,
      );
      assert.ok(error.cause instanceof WindowsProcessQueryObservation);
      assert.equal(error.cause.details.errorCode, 'EACCES');
      assert.equal(
        error.stack!.includes('    at Windows process query observation'),
        false,
      );
      return true;
    },
  );
  assert.equal(reports.length, 1);
  assert.match(reports[0]!, /last captured stage: unknown/);
  assert.equal(nativeError.message, 'original native error');
});

test('the actual TAP reporter shows a direct caller failure observation while retaining its primary error', (t) => {
  const { base, folders, program } = heldCopy(t);
  const primary = `${program} is in use, and the running programs could not be listed (no answer in 30 s)`;
  const windowsPrimary =
    'C:\\synthetic\\versions\\1.7.0\\circle.exe is in use, and the running programs could not be listed (no answer in 30 s)';
  const fixture = join(base, 'failure.test.mjs');
  const source = pathToFileURL(
    join(import.meta.dirname, '..', 'src', 'install_processes.ts'),
  ).href;
  writeFileSync(
    fixture,
    `import { test } from 'node:test'; import { runningFrom } from ${JSON.stringify(source)};\n` +
      `test('direct timeout', () => runningFrom(${JSON.stringify(folders)}, 'win32', (_command, args) => {\n` +
      `const nonce = args.at(-1);\n` +
      `return { status: null, stdout: '', stderr: 'CIRCLE_QUERY_' + nonce + ' LOOKUP\\r\\n', error: Object.assign(new Error('native timeout'), { code: 'ETIMEDOUT' }) };\n` +
      `}, () => 'EBUSY'));\n` +
      `test('synthetic Windows primary', () => { throw new Error(${JSON.stringify(windowsPrimary)}); });\n`,
  );
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CIRCLE_HOME: base,
  };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--test', '--test-reporter=tap', fixture],
    { encoding: 'utf8', env: environment, timeout: 10_000 },
  );
  const actual = result.stderr + result.stdout;
  assert.equal(result.status, 1, actual);
  assert.match(result.stdout, /^# tests 2\r?$/m, actual);
  assert.match(result.stdout, /^# fail 2\r?$/m, actual);
  const errorFields = result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('  error: '));
  const errorField = (message: string) =>
    `  error: ${inspect(message, { colors: false, breakLength: Infinity })}`;
  assert.deepEqual(
    errorFields,
    [primary, windowsPrimary].map(errorField),
    actual,
  );
  for (const message of [primary, windowsPrimary]) {
    assert.equal(
      errorFields.includes(errorField(message.slice(1))),
      false,
      actual,
    );
    assert.equal(
      errorFields.includes(errorField(message.replace('30 s', '31 s'))),
      false,
      actual,
    );
  }
  assert.match(result.stdout, /last captured stage: LOOKUP/, actual);
  assert.match(
    result.stdout,
    /captured counts: DECODE=0,LOOKUP=1,MODULE=0,DISPOSE=0,COMPLETE=0/,
    actual,
  );
});
