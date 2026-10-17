import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { IPty } from 'node-pty';
import { scratch } from '../../../tests/helpers.ts';
import {
  assertSupportedWindowsPtyVersion,
  installWindowsPtyExitCleanup,
  hasExitedWindowsPtyProcess,
} from '../src/workspace/pty-exit-cleanup.mjs';
const exec = promisify(execFile),
  require = createRequire(import.meta.url);
const helper = fileURLToPath(
  new URL('../src/workspace/pty-exit-cleanup.mjs', import.meta.url),
);
const vt = fileURLToPath(new URL('./helpers/terminal-vt.mjs', import.meta.url));
const native = fileURLToPath(
  new URL('../src/workspace/native-pty.ts', import.meta.url),
);
const terminalSource = new URL('../src/workspace/terminal.ts', import.meta.url)
  .href;
// Scratch fixture files have no node_modules beside them. Resolve the source
// loader here and pass its absolute URL only to children importing TS sources.
const sourceLoader = pathToFileURL(require.resolve('tsx')).href;
const sourceFixtureArgs = (fixture: string) => [
  '--import',
  sourceLoader,
  fixture,
];
const packageRoot = dirname(require.resolve('node-pty/package.json'));
const { EventEmitter2 } = require(join(packageRoot, 'lib', 'eventEmitter2.js'));
const { WindowsPtyAgent } = require(
  join(packageRoot, 'lib', 'windowsPtyAgent.js'),
);

test('a scratch TerminalManager source fixture resolves compiled suffix imports only with its explicit loader', async (t) => {
  const root = scratch(t, 'circle-pty-source-'),
    evidence = process.env.CIRCLE_NATIVE_TEST_PROGRESS_DIR ?? root;
  await mkdir(evidence, { recursive: true });
  const fixture = join(root, 'source.mjs'),
    marker = join(root, 'loaded.json'),
    negative = join(evidence, `terminal-source-negative-${randomUUID()}.log`);
  await writeFile(
    fixture,
    `import assert from 'node:assert/strict';import fs from 'node:fs';import {TerminalManager} from ${JSON.stringify(terminalSource)};
const manager=new TerminalManager({workspaceRoot:${JSON.stringify(root)},logRoot:${JSON.stringify(join(root, 'logs'))}},()=>{});
try{const terminals=await manager.list('source-fixture-owner');assert.deepEqual(terminals,[]);fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({name:TerminalManager.name,terminals}));}finally{await manager.dispose()}
console.log('SOURCE_FIXTURE_COMPLETE');`,
  );
  const run = (args: string[]) =>
    exec(process.execPath, args, {
      cwd: root,
      timeout: 5000,
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        CIRCLE_HOME: join(root, 'home'),
        CIRCLE_WORKBENCH_DATA_DIR: join(root, 'data'),
      },
    });
  let negativeStderr = '';
  await assert.rejects(run([fixture]), (error: Error & { stderr?: string }) => {
    const stderr = error.stderr ?? '';
    negativeStderr = stderr;
    assert.match(stderr, /ERR_MODULE_NOT_FOUND/);
    assert.match(stderr, /command_process\.js/);
    return true;
  });
  await writeFile(negative, negativeStderr);
  const result = await run(sourceFixtureArgs(fixture));
  assert.match(result.stdout, /SOURCE_FIXTURE_COMPLETE/);
  assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), {
    name: 'TerminalManager',
    terminals: [],
  });
  t.diagnostic(
    JSON.stringify({
      kind: 'actual source-loader child negative and positive control',
      negative,
      sourceLoader,
      platform: process.platform,
    }),
  );
});

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
          throw Error('do not reopen a post-exit flush window');
        },
        _worker: Object.assign(new EventEmitter(), {
          terminate() {
            workers++;
            return Promise.resolve(0);
          },
        }),
      },
      _inSocket: Object.assign(new EventEmitter(), {
        destroy() {
          inputs++;
        },
      }),
      _outSocket: Object.assign(new EventEmitter(), { destroy() {} }),
      _useConpty: true,
      _useConptyDll: false,
      _cleanUpProcess() {},
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

test('native ConPTY exit detection distinguishes the output-flush interval without consulting a numeric PID', () => {
  const agent = {
    _useConpty: true,
    _exitCode: undefined as number | undefined,
  };
  const terminal = {
    _agent: agent,
    kill() {
      throw Error('must not inspect or kill a PID');
    },
  } as unknown as IPty;
  assert.equal(
    hasExitedWindowsPtyProcess(terminal, {
      version: '1.1.0',
      platform: 'win32',
    }),
    false,
  );
  agent._exitCode = 0;
  assert.equal(
    hasExitedWindowsPtyProcess(terminal, {
      version: '1.1.0',
      platform: 'win32',
    }),
    true,
  );
  assert.equal(
    hasExitedWindowsPtyProcess(terminal, {
      version: '1.1.0',
      platform: 'darwin',
    }),
    false,
  );
  assert.throws(
    () =>
      hasExitedWindowsPtyProcess(terminal, {
        version: 'future',
        platform: 'win32',
      }),
    /unsupported Windows PTY lifecycle/,
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
 const connection=new ConoutConnection(PIPE,false),exit=new EventEmitter2(),input=new net.Socket(),output=new net.Socket();
 const {WindowsPtyAgent}=load(PACKAGE_ROOT+'/lib/windowsPtyAgent.js');
 const terminal={_agent:{_conoutSocketWorker:connection,_inSocket:input,_outSocket:output,_useConpty:true,_useConptyDll:false,_cleanUpProcess:WindowsPtyAgent.prototype._cleanUpProcess},onExit:exit.event,kill(){throw Error('numeric PID kill is forbidden')}};
 if(CLEANUP)installWindowsPtyExitCleanup(terminal,{version:'1.1.0',platform:'win32'});
 output.setEncoding('utf8');let received='';
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
      `import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {spawnPty} from ${JSON.stringify(pathToFileURL(native).href)};import {renderTerminalOutput} from ${JSON.stringify(pathToFileURL(vt).href)};\n` +
        String.raw`
const progress=(step,detail={})=>{fs.appendFileSync(PROGRESS,JSON.stringify({at:Date.now(),step,resources:process.getActiveResourcesInfo(),...detail})+'\n');console.log(step)};
const sha=text=>createHash('sha256').update(text).digest('hex');
let count=0,verified=0,workers=0;
function start(){
 const index=++count,rawFile=PROGRESS+'.session-'+index+'.raw.log',normalizedFile=PROGRESS+'.session-'+index+'.normalized.json';
 fs.writeFileSync(rawFile,'');progress('spawn-'+index,{rawFile});
 const terminal=spawnPty(process.execPath,['-e',PROGRAM],{cwd:ROOT,env:process.env,cols:80,rows:24});
 const worker=terminal._agent._conoutSocketWorker._worker;
 worker.once('exit',code=>{workers++;progress('owned-worker-exit-'+index,{code})});
 let output='',sent=false;
 terminal.onData(data=>{output+=data;fs.appendFileSync(rawFile,data);if(!sent&&output.includes('CONPTY_READY')){sent=true;terminal.write('actual-input\r')}});
 terminal.onExit(event=>{
  progress('natural-exit-'+index,{exitCode:event.exitCode,rawBytes:Buffer.byteLength(output),rawSha256:sha(output),rawFile});
  void (async()=>{
   assert.equal(event.exitCode,7,'actual ConPTY program exit code');
   const rendered=await renderTerminalOutput(output,{cols:80,rows:24,scrollback:10000});
   // The fixture emits one unbroken payload. Join physical screen rows only
   // after actual cursor/erase/scroll semantics have resolved repainting.
   const continuous=rendered.lines.map(line=>line.text).join('');
   const begin=continuous.indexOf('CONPTY_TAIL_'),end=continuous.indexOf('_END',begin+12);
   const payload=begin>=0&&end>=0?continuous.slice(begin+12,end):'';
   const report={rawFile,exitCode:event.exitCode,rawBytes:Buffer.byteLength(output),rawSha256:sha(output),prefixFound:begin>=0,suffixFound:end>=0,payloadBytes:Buffer.byteLength(payload),payloadSha256:sha(payload),expectedBytes:65536,expectedSha256:sha('x'.repeat(65536)),rendered};
   fs.writeFileSync(normalizedFile,JSON.stringify(report));
   assert.ok(begin>=0&&end>begin,'full payload framing must survive VT parsing');
   assert.equal(payload.length,65536,'exact payload character count after VT semantics');
   assert.equal(report.payloadBytes,65536,'exact 64KB payload byte count');
   assert.equal(report.payloadSha256,report.expectedSha256,'every payload byte must match, not just the end marker');
   assert.equal(payload,'x'.repeat(65536));
   assert.ok(continuous.includes('CONPTY_INPUT:actual-input'),'actual stdin remains visible after VT parsing');
   verified++;progress('tail-verified-'+index,{normalizedFile,payloadBytes:report.payloadBytes,payloadSha256:report.payloadSha256});
   if(index<3)start();else progress('all-conpty-exits-observed',{verified});
  })().catch(error=>{progress('tail-verification-failed-'+index,{error:String(error),normalizedFile,rawFile});console.error(error);process.exitCode=1});
 });
}
start();process.once('beforeExit',()=>{progress('node-beforeExit-no-conpty-worker',{spawned:count,verified,workers});if(verified!==3||workers!==3)process.exitCode=1});
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
    const events = (await readFile(progress, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(
      events.filter((event) => /^natural-exit-\d+$/.test(event.step)).length,
      3,
    );
    assert.equal(
      events.filter((event) => /^owned-worker-exit-\d+$/.test(event.step))
        .length,
      3,
    );
    assert.equal(
      events.filter((event) => /^tail-verified-\d+$/.test(event.step)).length,
      3,
    );
    const final = events.find(
      (event) => event.step === 'node-beforeExit-no-conpty-worker',
    );
    assert.equal(final.verified, 3);
    assert.equal(final.workers, 3);
    for (const event of events.filter((event) =>
      /^tail-verified-\d+$/.test(event.step),
    )) {
      const report = JSON.parse(await readFile(event.normalizedFile, 'utf8'));
      const raw = await readFile(report.rawFile, 'utf8');
      assert.equal(
        createHash('sha256').update(raw).digest('hex'),
        report.rawSha256,
      );
      assert.equal(report.payloadBytes, 65536);
      assert.equal(report.payloadSha256, report.expectedSha256);
    }
    t.diagnostic(
      JSON.stringify({
        kind: 'actual Windows ConPTY three natural exits and full final output',
        progress,
      }),
    );
  },
);

test(
  'Windows terminal close waits for the native-exit output-flush window and preserves the complete final log',
  {
    skip: process.platform !== 'win32' ? 'requires real Windows ConPTY' : false,
  },
  async (t) => {
    const root = scratch(t, 'circle-conpty-flush-close-'),
      evidence = process.env.CIRCLE_NATIVE_TEST_PROGRESS_DIR ?? root;
    await mkdir(evidence, { recursive: true });
    const progress = join(evidence, `conpty-flush-close-${randomUUID()}.jsonl`),
      fixture = join(root, 'flush-close.mjs');
    const program =
      "setTimeout(()=>{process.stdout.write('CONPTY_TAIL_'+ 'x'.repeat(32768)+'_END\\n');process.exitCode=0},25);";
    await writeFile(
      fixture,
      `import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';import {TerminalManager} from ${JSON.stringify(terminalSource)};import {hasNativePtyProcessExited} from ${JSON.stringify(pathToFileURL(native).href)};import {renderTerminalOutput} from ${JSON.stringify(pathToFileURL(vt).href)};\n` +
        String.raw`
const progress=(step,detail={})=>{fs.appendFileSync(PROGRESS,JSON.stringify({step,at:Date.now(),resources:process.getActiveResourcesInfo(),...detail})+'\n');console.log(step)};
const workspace=path.join(ROOT,'workspace');fs.mkdirSync(workspace);
const load=createRequire(PACKAGE_ROOT+'/package.json'),ptyModule=load('node-pty'),originalSpawn=ptyModule.spawn;
let captured;ptyModule.spawn=(...args)=>(captured=originalSpawn(...args));
const manager=new TerminalManager({workspaceRoot:workspace,logRoot:path.join(ROOT,'logs')},()=>{});
let closed=false;
try{
 const terminal=await manager.create({owner:'flush-owner',sessionId:'flush-session',command:{file:process.execPath,args:['-e',PROGRAM]}});
 ptyModule.spawn=originalSpawn;
 const deadline=Date.now()+5000;
 while(!hasNativePtyProcessExited(captured)){assert(Date.now()<deadline,'real native process exit was not observed');await new Promise(done=>setTimeout(done,2))}
 const before=(await manager.list('flush-owner')).find(item=>item.id===terminal.id);
 assert.equal(before.status,'running','test must observe native exit before delayed public output close');
 progress('native-exit-known-before-close',{pid:terminal.pid,status:before.status});
 const result=await manager.close('flush-owner',terminal.id);
 assert.equal(result.status,'exited');assert.equal(result.exitCode,0);
 const raw=fs.readFileSync(terminal.logPath,'utf8'),rendered=await renderTerminalOutput(raw);
 const continuous=rendered.lines.map(line=>line.text).join(''),start=continuous.indexOf('CONPTY_TAIL_'),end=continuous.indexOf('_END',start+12),payload=continuous.slice(start+12,end);
 assert(start>=0&&end>start,'full tail framing after confirmed public onExit');assert.equal(payload,'x'.repeat(32768));
 const rawFile=PROGRESS+'.raw.log',normalizedFile=PROGRESS+'.normalized.json';fs.writeFileSync(rawFile,raw);fs.writeFileSync(normalizedFile,JSON.stringify(rendered));
 progress('close-confirmed-with-complete-tail',{exitCode:result.exitCode,rawFile,normalizedFile,payloadBytes:Buffer.byteLength(payload),payloadSha256:createHash('sha256').update(payload).digest('hex')});closed=true;
}finally{ptyModule.spawn=originalSpawn;await manager.dispose()}
process.once('beforeExit',()=>{progress('node-beforeExit-after-close',{closed});if(!closed)process.exitCode=1});
`
          .replaceAll('PROGRESS', JSON.stringify(progress))
          .replaceAll('PACKAGE_ROOT', JSON.stringify(packageRoot))
          .replaceAll('PROGRAM', JSON.stringify(program))
          .replaceAll('ROOT', JSON.stringify(root)),
    );
    const result = await exec(process.execPath, sourceFixtureArgs(fixture), {
      cwd: root,
      timeout: 12000,
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        CIRCLE_HOME: join(root, 'home'),
        CIRCLE_WORKBENCH_DATA_DIR: join(root, 'data'),
      },
    });
    assert.match(result.stdout, /native-exit-known-before-close/);
    assert.match(result.stdout, /close-confirmed-with-complete-tail/);
    assert.match(result.stdout, /node-beforeExit-after-close/);
    t.diagnostic(
      JSON.stringify({
        kind: 'actual Windows native-exit to public-onExit flush window closes without a stale PID kill',
        progress,
      }),
    );
  },
);
