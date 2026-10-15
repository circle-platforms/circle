import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { IPty } from 'node-pty';
import { scratch } from '../../../tests/helpers.ts';
import {
  assertSupportedWindowsPtyVersion,
  installWindowsPtyExitCleanup,
} from '../src/workspace/pty-exit-cleanup.mjs';
const exec = promisify(execFile),
  require = createRequire(import.meta.url);
const helper = fileURLToPath(
  new URL('../src/workspace/pty-exit-cleanup.mjs', import.meta.url),
);
const native = fileURLToPath(
  new URL('../src/workspace/native-pty.ts', import.meta.url),
);
const packageRoot = dirname(require.resolve('node-pty/package.json'));
const { EventEmitter2 } = require(join(packageRoot, 'lib', 'eventEmitter2.js'));

test('Windows compatibility guard releases only the exited instance worker and input socket, never a PID', () => {
  assert.throws(
    () => assertSupportedWindowsPtyVersion('1.2.0', 'win32'),
    /unsupported Windows PTY lifecycle adapter/,
  );
  assert.doesNotThrow(() =>
    assertSupportedWindowsPtyVersion('future', 'linux'),
  );
  assert.throws(
    () =>
      installWindowsPtyExitCleanup({} as IPty, {
        version: '1.1.0',
        platform: 'win32',
      }),
    /unsupported.*ownership shape/,
  );
  const exit = new EventEmitter2();
  let workers = 0,
    inputs = 0,
    observed = 0;
  const pty = {
    _agent: {
      _conoutSocketWorker: {
        dispose() {
          workers++;
        },
      },
      _inSocket: {
        destroy() {
          inputs++;
        },
      },
    },
    onExit: exit.event,
    kill() {
      throw Error('must never kill a numeric PID after natural exit');
    },
  } as unknown as IPty;
  installWindowsPtyExitCleanup(pty, { version: '1.1.0', platform: 'win32' });
  installWindowsPtyExitCleanup(pty, { version: '1.1.0', platform: 'win32' });
  exit.event(() => observed++);
  assert.equal(workers, 0);
  assert.equal(inputs, 0);
  exit.fire({ exitCode: 0 });
  exit.fire({ exitCode: 0 });
  assert.equal(workers, 1);
  assert.equal(inputs, 1);
  assert.equal(
    observed,
    2,
    'cleanup listener must preserve subsequent runtime exit observers',
  );
});

test('actual node-pty ConoutConnection worker keeps the child alive without cleanup and exits naturally after owned cleanup', async (t) => {
  const root = scratch(t, 'cp-');
  const evidence = process.env.CIRCLE_NATIVE_TEST_PROGRESS_DIR ?? root;
  await mkdir(evidence, { recursive: true });
  const run = async (cleanup: boolean) => {
    const progress = join(
      evidence,
      `conout-${process.platform}-${cleanup ? 'cleanup' : 'control'}-${randomUUID()}.jsonl`,
    );
    const pipe =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\circle-conout-${randomUUID()}`
        : join(root, cleanup ? 'clean.sock' : 'control.sock');
    const fixture = join(root, cleanup ? 'clean.mjs' : 'control.mjs');
    const code =
      `import assert from 'node:assert/strict';import fs from 'node:fs';import net from 'node:net';import {createRequire} from 'node:module';import {installWindowsPtyExitCleanup} from ${JSON.stringify(pathToFileURL(helper).href)};\n` +
      String.raw`
const load=createRequire(import.meta.url),{ConoutConnection}=load(PACKAGE_ROOT+'/lib/windowsConoutConnection.js'),{EventEmitter2}=load(PACKAGE_ROOT+'/lib/eventEmitter2.js');
const progress=(step)=>{const record={step,at:Date.now(),resources:process.getActiveResourcesInfo()};fs.appendFileSync(PROGRESS,JSON.stringify(record)+'\n');console.log(JSON.stringify(record))};
const tail='ACTUAL_CONOUT_TAIL_'+String('z').repeat(16384)+'_END';
const source=net.createServer(socket=>socket.end(tail));
source.listen(PIPE,()=>{
 progress('source-listening');
 const connection=new ConoutConnection(PIPE,false),exit=new EventEmitter2(),input=new net.Socket();
 const terminal={_agent:{_conoutSocketWorker:connection,_inSocket:input},onExit:exit.event,kill(){throw Error('numeric PID kill is forbidden')}};
 if(CLEANUP)installWindowsPtyExitCleanup(terminal,{version:'1.1.0',platform:'win32'});
 const output=new net.Socket();output.setEncoding('utf8');let received='';
 output.on('data',chunk=>received+=chunk);
 output.on('close',()=>{assert.equal(received,tail);source.close();progress('output-closed-full-tail');exit.fire({exitCode:0});progress('natural-exit-emitted')});
 connection.onReady(()=>{progress('worker-listening');connection.connectSocket(output)});
});
process.once('beforeExit',()=>progress('node-beforeExit-no-live-worker'));
`;
    await writeFile(
      fixture,
      code
        .replaceAll('PACKAGE_ROOT', JSON.stringify(packageRoot))
        .replaceAll('PROGRESS', JSON.stringify(progress))
        .replaceAll('PIPE', JSON.stringify(pipe))
        .replaceAll('CLEANUP', String(cleanup)),
    );
    const started = Date.now();
    try {
      const result = await exec(process.execPath, [fixture], {
        cwd: root,
        timeout: cleanup ? 7000 : 2500,
        killSignal: 'SIGKILL',
        env: {
          ...process.env,
          CIRCLE_HOME: join(root, 'home'),
          CIRCLE_WORKBENCH_DATA_DIR: join(root, 'data'),
        },
      });
      assert.equal(
        cleanup,
        true,
        'uncleaned actual worker must still be listening',
      );
      assert.match(result.stdout, /node-beforeExit-no-live-worker/);
    } catch (error) {
      if (cleanup) throw error;
      assert.equal(
        (error as { killed?: boolean }).killed,
        true,
        `negative control must time out because the actual worker remains referenced: ${String(error)} ${(error as { stderr?: string }).stderr ?? ''}`,
      );
      assert.match(
        (error as { stdout?: string }).stdout ?? '',
        /natural-exit-emitted/,
      );
      assert.doesNotMatch(
        (error as { stdout?: string }).stdout ?? '',
        /node-beforeExit-no-live-worker/,
      );
    }
    const events = (await readFile(progress, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.step === 'output-closed-full-tail'));
    assert.equal(
      events.some((event) => event.step === 'node-beforeExit-no-live-worker'),
      cleanup,
    );
    t.diagnostic(
      JSON.stringify({
        kind: 'actual node-pty ConoutConnection and worker/socket subprocess',
        cleanup,
        platform: process.platform,
        ms: Date.now() - started,
        progress,
      }),
    );
  };
  await run(false);
  await run(true);
});

test(
  'Windows real ConPTY naturally exits repeated owned sessions without keeping the parent Node process alive',
  {
    skip: process.platform !== 'win32' ? 'requires real Windows ConPTY' : false,
  },
  async (t) => {
    const root = scratch(t, 'circle-real-conpty-exit-');
    const evidence = process.env.CIRCLE_NATIVE_TEST_PROGRESS_DIR ?? root;
    await mkdir(evidence, { recursive: true });
    const progress = join(
        evidence,
        `real-conpty-natural-exit-${randomUUID()}.jsonl`,
      ),
      fixture = join(root, 'real.mjs');
    const program =
      "console.log('CONPTY_READY');process.stdin.once('data',data=>{console.log('CONPTY_INPUT:'+data.toString().trim());process.stdout.write('CONPTY_TAIL_'+ 'x'.repeat(65536)+'_END\\n');process.stdin.pause();process.exitCode=7});";
    await writeFile(
      fixture,
      `import assert from 'node:assert/strict';import fs from 'node:fs';import {spawnPty} from ${JSON.stringify(pathToFileURL(native).href)};\n` +
        String.raw`
const progress=step=>{fs.appendFileSync(PROGRESS,JSON.stringify({at:Date.now(),step,resources:process.getActiveResourcesInfo()})+'\n');console.log(step)};
let count=0;
function start(){const index=++count;progress('spawn-'+index);const terminal=spawnPty(process.execPath,['-e',PROGRAM],{cwd:ROOT,env:process.env,cols:80,rows:24});let output='',sent=false;terminal.onData(data=>{output+=data;if(!sent&&output.includes('CONPTY_READY')){sent=true;terminal.write('actual-input\r')}});terminal.onExit(event=>{assert.equal(event.exitCode,7,output.slice(-1000));assert.match(output,/CONPTY_INPUT:actual-input/);assert.match(output,/CONPTY_TAIL_[x\r\n]+_END/);progress('natural-exit-'+index);if(index<3)start();else progress('all-conpty-exits-observed')})}
start();process.once('beforeExit',()=>progress('node-beforeExit-no-conpty-worker'));
`
          .replaceAll('PROGRESS', JSON.stringify(progress))
          .replaceAll('PROGRAM', JSON.stringify(program))
          .replaceAll('ROOT', JSON.stringify(root)),
    );
    const result = await exec(process.execPath, [fixture], {
      cwd: root,
      timeout: 15000,
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        CIRCLE_HOME: join(root, 'home'),
        CIRCLE_WORKBENCH_DATA_DIR: join(root, 'data'),
      },
    });
    assert.match(result.stdout, /all-conpty-exits-observed/);
    assert.match(result.stdout, /node-beforeExit-no-conpty-worker/);
    t.diagnostic(
      JSON.stringify({
        kind: 'actual Windows ConPTY three natural exits and full final output',
        progress,
      }),
    );
  },
);
