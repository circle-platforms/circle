// Manual Windows-only fixture, synthetic processes and isolated copies only.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = process.env.CIRCLE_NATIVE_CONTROL_OUTPUT;
if (!output || process.platform !== 'win32')
  throw new Error('isolated Windows output required');
mkdirSync(output, { recursive: true });
const hash = (bytes: string | Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const save = (name: string, value: unknown) =>
  writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
  });
const base = mkdtempSync(join(tmpdir(), 'cnc-'));
const home = join(base, 'home');
mkdirSync(home);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  CIRCLE_HOME: home,
  HOME: home,
  USERPROFILE: home,
  TMPDIR: base,
  TMP: base,
  TEMP: base,
};
delete env.NODE_OPTIONS;
delete env.NODE_TEST_CONTEXT;
delete env.NODE_PATH;
let child: ReturnType<typeof spawn> | undefined;
let closed: Promise<void> | undefined;
let observedExit:
  | { code: number | null; signal: NodeJS.Signals | null; atUtcMs: number }
  | undefined;
let primary: unknown;
const waitClose = async (ms: number) => {
  if (observedExit) return true;
  if (!closed) return !child;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      closed.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
try {
  const version = join(base, 'versions', '0.5.0');
  const program = join(version, 'circle', 'circle.exe');
  mkdirSync(join(version, 'circle'), { recursive: true });
  cpSync(process.execPath, program);
  child = spawn(
    program,
    [
      '-e',
      "process.stdout.write('R'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));",
    ],
    { env, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  closed = new Promise<void>((resolve) =>
    child!.once('close', (code, signal) => {
      observedExit = { code, signal, atUtcMs: Date.now() };
      resolve();
    }),
  );
  await once(child, 'spawn');
  const [ready] = await once(child.stdout!, 'data', {
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(ready.toString(), 'R');
  const ownedPid = child.pid;
  assert.ok(ownedPid);
  save('owned-ready.json', {
    pid: ownedPid,
    ready: 'R',
    programSha256: hash(readFileSync(program)),
  });
  const koffiPackage = join(root, 'node_modules', 'koffi', 'package.json');
  const koffiVersion = JSON.parse(readFileSync(koffiPackage, 'utf8')).version;
  assert.equal(koffiVersion, '3.3.3');
  const nativeAddon = join(
    root,
    'node_modules',
    '@koromix',
    `koffi-win32-${process.arch}`,
    `win32_${process.arch}`,
    'koffi.node',
  );
  const source = join(root, 'src', 'legacy_install.ts');
  const compiled = join(root, 'dist', 'legacy_install.js');
  const workerSource = join(root, 'src', 'windows_process_native.ts');
  const workerCompiled = join(root, 'dist', 'windows_process_native.js');
  assert.ok(
    existsSync(workerSource) && existsSync(workerCompiled),
    'reviewed native source and compiled worker required',
  );
  assert.ok(existsSync(compiled), 'build once before running this fixture');
  const isolated = join(base, 'missing-dependency');
  mkdirSync(isolated);
  cpSync(join(root, 'dist'), join(isolated, 'dist'), { recursive: true });
  writeFileSync(join(isolated, 'package.json'), '{"type":"module"}\n');
  assert.equal(existsSync(join(isolated, 'node_modules')), false);
  for (let ancestor = isolated; ; ancestor = dirname(ancestor)) {
    assert.equal(
      existsSync(join(ancestor, 'node_modules', 'koffi')),
      false,
      'negative consumer must not resolve a shared Koffi package',
    );
    if (dirname(ancestor) === ancestor) break;
  }
  const protectedFiles = [
    'settings.json',
    'credentials.json',
    'sessions.sqlite',
  ].map((name) => {
    const path = join(home, name);
    writeFileSync(path, 'synthetic unchanged ' + name);
    return { path, sha256: hash(readFileSync(path)) };
  });
  const forbiddenVersion = join(base, 'versions', '1.0.0');
  const oldSource = join(
    root,
    'scripts',
    'fixtures',
    'windows-query-before-native',
    'legacy_install.ts',
  );
  const cases = [
    {
      name: 'old-powershell-unavailable',
      module: oldSource,
      source: true,
      old: true,
      expectedFailure: true,
    },
    {
      name: 'native-source',
      module: source,
      source: true,
      old: false,
      expectedFailure: false,
    },
    {
      name: 'native-compiled',
      module: compiled,
      source: false,
      old: false,
      expectedFailure: false,
    },
    {
      name: 'native-missing-dependency',
      module: join(isolated, 'dist', 'legacy_install.js'),
      source: false,
      old: false,
      expectedFailure: true,
    },
  ];
  const copy = {
    kind: 'installer',
    prefix: base,
    versions: [version],
    links: [],
    leftovers: [],
  };
  const where = { platform: 'win32', home, path: '' };
  save('frozen-plan.json', {
    node: process.version,
    platform: process.platform,
    ownedPid,
    cases: cases.map((c) => ({
      name: c.name,
      source: c.source,
      expectedFailure: c.expectedFailure,
    })),
    oldSourceCommit: 'd724fc4f630b27d2ee3ff9c80000afde13f33c6d',
    koffiVersion,
    nativeAddonArch: process.arch,
    sourceHashes: {
      package: hash(readFileSync(join(root, 'package.json'))),
      lock: hash(readFileSync(join(root, 'package-lock.json'))),
      koffiPackage: hash(readFileSync(koffiPackage)),
      nativeAddon: hash(readFileSync(nativeAddon)),
      legacy: hash(readFileSync(source)),
      nativeWorker: hash(readFileSync(workerSource)),
      compiledWorker: hash(readFileSync(workerCompiled)),
      oldLegacy: hash(readFileSync(oldSource)),
      oldQuery: hash(
        readFileSync(join(oldSource, '..', 'windows_process_query.ts')),
      ),
    },
    queryTimeoutMs: 30_000,
    readyTimeoutMs: 15_000,
    consumerTimeoutMs: 60_000,
    attemptsPerCase: 1,
    retries: 0,
    control:
      'Only old requested PowerShell executable is mapped to an owned missing path by the controlled runner; real SystemRoot, OS files and new native requests are unchanged',
    isolation:
      'Copied compiled dist with no Koffi package, outside the repository, NODE_PATH/NODE_OPTIONS cleared',
    limits: [
      'not historical115 unique-cause reproduction',
      'fixed order and different loader contexts are not performance comparison',
    ],
  });
  const consumers: {
    name: string;
    status: number | null;
    signal: NodeJS.Signals | null;
  }[] = [];
  for (const c of cases) {
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    const folder = join(output, c.name);
    mkdirSync(folder);
    const consumer = join(base, c.name + '.mjs');
    const control = {
      output: folder,
      old: c.old,
      module: pathToFileURL(c.module).href,
      copy,
      where,
      ownedPid,
      program,
      protectedFiles,
      forbiddenVersion,
      missingPowerShell: join(
        base,
        'missing-system',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
    };
    // Same consumer invokes the production parent once, records its actual native result
    // before runningCopies parses it, and retains an actual thrown primary on failure.
    const body =
      `import assert from 'node:assert/strict'; import {spawnSync} from 'node:child_process'; import {createHash} from 'node:crypto'; import {readFileSync,writeFileSync,realpathSync,existsSync} from 'node:fs'; import {join,basename} from 'node:path';\n` +
      `import {runningCopies} from ${JSON.stringify(control.module)}; const c=${JSON.stringify(control)};\n` +
      `const hash=v=>createHash('sha256').update(v).digest('hex'); const save=(n,v)=>writeFileSync(join(c.output,n),JSON.stringify(v,null,2)+'\\n',{flag:'wx'}); let calls=0; let native; let thrown; let pids; const before=hash(readFileSync(c.program));\n` +
      `const run=(command,args,timeout)=>{calls++;assert.equal(calls,1);assert.equal(timeout,30000);const requested=basename(command).toLowerCase();if(c.old)assert.equal(requested,'powershell.exe');else assert.equal(command,process.execPath,'new worker must use the current Node, no PowerShell fallback');const executed=c.old?c.missingPowerShell:command;const startedUtcMs=Date.now();const start=performance.now();native=spawnSync(executed,args,{encoding:'utf8',timeout});const closedUtcMs=Date.now();const elapsedMs=performance.now()-start;const stdout=native.stdout??'';const stderr=native.stderr??'';writeFileSync(join(c.output,'query.stdout.raw'),stdout,{flag:'wx'});writeFileSync(join(c.output,'query.stderr.raw'),stderr,{flag:'wx'});save('query.native-close.json',{requestedCommand:command,executedCommand:executed,args,timeout,startedUtcMs,closedUtcMs,elapsedMs,status:native.status,signal:native.signal,error:native.error?{name:native.error.name,message:native.error.message,code:native.error.code,stack:native.error.stack}:null,stdoutSha256:hash(stdout),stderrSha256:hash(stderr)});return native;};\n` +
      `try{pids=runningCopies([c.copy],c.where,run);}catch(error){thrown=error;console.error(error);process.exitCode=1;}save('consumer-outcome.json',{calls,pids:pids??null,primary:thrown?{name:thrown.name,message:thrown.message,stack:thrown.stack,cause:thrown.cause?.details??null}:null,programUnchanged:hash(readFileSync(c.program))===before,protectedFilesUnchanged:c.protectedFiles.every(f=>hash(readFileSync(f.path))===f.sha256),forbiddenVersionAbsent:!existsSync(c.forbiddenVersion),canonicalProgram:realpathSync.native(c.program)});\n`;
    writeFileSync(consumer, body);
    const args = c.source ? ['--import', 'tsx', consumer] : [consumer];
    const start = Date.now();
    const result = spawnSync(process.execPath, args, {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    });
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    writeFileSync(join(folder, 'consumer.stdout.raw'), stdout, { flag: 'wx' });
    writeFileSync(join(folder, 'consumer.stderr.raw'), stderr, { flag: 'wx' });
    const receipt = {
      name: c.name,
      status: result.status,
      signal: result.signal,
      error: result.error
        ? {
            name: result.error.name,
            message: result.error.message,
            code: (result.error as NodeJS.ErrnoException).code,
            stack: result.error.stack,
          }
        : null,
      startedUtcMs: start,
      closedUtcMs: Date.now(),
      stdoutSha256: hash(stdout),
      stderrSha256: hash(stderr),
    };
    writeFileSync(
      join(folder, 'consumer.native-close.json'),
      JSON.stringify(receipt, null, 2) + '\n',
      { flag: 'wx' },
    );
    consumers.push(receipt);
  }
  // No query or consumer result has been parsed before all native receipts exist.
  const parsed = cases.map((c, index) => {
    const folder = join(output, c.name);
    const native = JSON.parse(
      readFileSync(join(folder, 'query.native-close.json'), 'utf8'),
    );
    const outcome = JSON.parse(
      readFileSync(join(folder, 'consumer-outcome.json'), 'utf8'),
    );
    assert.equal(consumers[index]!.signal, null);
    assert.equal(outcome.calls, 1);
    assert.equal(outcome.programUnchanged, true);
    assert.equal(outcome.protectedFilesUnchanged, true);
    assert.equal(outcome.forbiddenVersionAbsent, true);
    const stdout = readFileSync(join(folder, 'query.stdout.raw'), 'utf8');
    const stderr = readFileSync(join(folder, 'query.stderr.raw'), 'utf8');
    assert.equal(hash(stdout), native.stdoutSha256);
    assert.equal(hash(stderr), native.stderrSha256);
    const entries = stdout.split(/\r?\n/).flatMap((line) => {
      const m = /^(\d+) ([A-Za-z0-9+/=]+)$/.exec(line);
      return m
        ? [
            {
              pid: Number(m[1]),
              path: Buffer.from(m[2]!, 'base64').toString('utf8'),
            },
          ]
        : [];
    });
    if (c.expectedFailure) {
      assert.equal(consumers[index]!.status, 1);
      assert.equal(outcome.pids, null);
      assert.ok(outcome.primary?.message.startsWith(program + ' is in use'));
      if (c.old) {
        assert.equal(native.error?.code, 'ENOENT');
        assert.equal(native.status, null);
      } else {
        assert.equal(native.error, null);
        assert.equal(native.status, 1);
        assert.equal(
          stderr
            .split(/\r?\n/)
            .filter(
              (line) =>
                line ===
                'Windows native process query unavailable (stage dependency; code unknown)',
            ).length,
          1,
          'the negative consumer must fail at dependency loading, not another worker stage',
        );
      }
      assert.equal(entries.filter((e) => e.pid === ownedPid).length, 0);
    } else {
      assert.equal(consumers[index]!.status, 0);
      assert.equal(native.status, 0);
      assert.equal(native.error, null);
      assert.equal(native.signal, null);
      assert.equal(outcome.primary, null);
      assert.deepEqual(outcome.pids, [ownedPid]);
      const match = entries.filter((e) => e.pid === ownedPid);
      assert.equal(match.length, 1);
      assert.equal(
        realpathSync.native(match[0]!.path).toLowerCase(),
        realpathSync.native(program).toLowerCase(),
      );
    }
    return {
      name: c.name,
      expectedFailure: c.expectedFailure,
      consumerStatus: consumers[index]!.status,
      queryStatus: native.status,
      queryError: native.error?.code ?? null,
      ownedPidMatch: !c.expectedFailure,
      programUnchanged: true,
    };
  });
  save('acceptance.json', {
    parsed,
    attemptsPerCase: 1,
    retries: 0,
    queryTimeoutMs: 30000,
    historical115Cause: 'unknown',
  });
} catch (error) {
  primary = error;
  console.error(error);
  save('primary-error.json', {
    name: error instanceof Error ? error.name : 'unknown',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exitCode = 1;
} finally {
  const errors: string[] = [];
  let killAttempted = false;
  let killAccepted: boolean | null = null;
  if (child && !observedExit) {
    try {
      child.stdin?.end();
    } catch (e) {
      errors.push(String(e));
    }
    if (!(await waitClose(15000))) {
      errors.push('Owned graceful close not observed within15s');
      if (child.exitCode === null && child.signalCode === null) {
        killAttempted = true;
        try {
          killAccepted = child.kill();
        } catch (e) {
          errors.push(String(e));
        }
      }
      if (!(await waitClose(15000)))
        errors.push('Owned close not observed after bounded termination wait');
    }
  }
  if (observedExit && (observedExit.code !== 0 || observedExit.signal !== null))
    errors.push('Owned child did not exit normally with code0 and no signal');
  let scratchRemoved = false;
  if (!child || observedExit) {
    try {
      rmSync(base, { recursive: true, force: true });
      scratchRemoved = true;
    } catch (e) {
      errors.push(String(e));
    }
  } else errors.push('Scratch retained: owned close unobserved');
  save('cleanup.json', {
    primaryPresent: primary !== undefined,
    errors,
    killAttempted,
    killAccepted,
    ownedCloseObserved: observedExit !== undefined,
    ownedExit: observedExit ?? null,
    scratchRemoved,
    scratchRetained: !scratchRemoved,
  });
  if (errors.length) process.exitCode = 1;
}
