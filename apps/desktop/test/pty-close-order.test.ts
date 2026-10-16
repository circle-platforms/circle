import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { scratch } from '../../../tests/helpers.ts';
const exec = promisify(execFile),
  require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve('node-pty/package.json'));
const helper = pathToFileURL(
  fileURLToPath(
    new URL('../src/workspace/pty-exit-cleanup.mjs', import.meta.url),
  ),
).href;

test('the actual Conout worker closes before the drained receiver, with an old-order negative control and exact raw tail', async (t) => {
  const root = scratch(t, 'pc-');
  const evidence = process.env.CIRCLE_NATIVE_TEST_PROGRESS_DIR ?? root;
  await mkdir(evidence, { recursive: true });
  const tail = 'ACTUAL_CLOSE_TAIL_' + 'x'.repeat(65536) + '_END';
  for (const fixed of [false, true]) {
    const stem = `conout-order-${process.platform}-${fixed ? 'fixed' : 'control'}-${randomUUID()}`;
    const progress = join(evidence, stem + '.jsonl'),
      raw = join(evidence, stem + '.raw.log');
    const pipe =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\circle-order-${randomUUID()}`
        : join(root, fixed ? 'f.sock' : 'c.sock');
    const fixture = join(root, fixed ? 'fixed.mjs' : 'control.mjs');
    await writeFile(
      fixture,
      `
import assert from 'node:assert/strict';import fs from 'node:fs';import net from 'node:net';import {createRequire} from 'node:module';import {installWindowsPtyExitCleanup} from ${JSON.stringify(helper)};
const load=createRequire(import.meta.url),{ConoutConnection}=load(${JSON.stringify(packageRoot)}+'/lib/windowsConoutConnection.js'),{WindowsPtyAgent}=load(${JSON.stringify(packageRoot)}+'/lib/windowsPtyAgent.js'),{EventEmitter2}=load(${JSON.stringify(packageRoot)}+'/lib/eventEmitter2.js');
const record=(step,extra={})=>fs.appendFileSync(${JSON.stringify(progress)},JSON.stringify({step,...extra,resources:process.getActiveResourcesInfo()})+'\\n');
const tail='ACTUAL_CLOSE_TAIL_'+'x'.repeat(65536)+'_END';let workerExited=false, received='';
const source=net.createServer(socket=>{socket.write(tail);socket.on('close',()=>source.close());socket.on('error',error=>{record('source-error',{code:error.code});throw error})});
source.listen(${JSON.stringify(pipe)},()=>{
 const connection=new ConoutConnection(${JSON.stringify(pipe)},false),input=new net.Socket(),output=new net.Socket(),exit=new EventEmitter2();output.setEncoding('utf8');
 const agent={_useConpty:true,_useConptyDll:false,_exitCode:0,_conoutSocketWorker:connection,_inSocket:input,_outSocket:output,_cleanUpProcess(){record('receiver-close-request',{workerExited});WindowsPtyAgent.prototype._cleanUpProcess.call(this)}};
 const terminal={_agent:agent,onExit:exit.event};
 connection._worker.once('exit',code=>{workerExited=true;record('owned-worker-exit',{code})});
 if(${fixed})installWindowsPtyExitCleanup(terminal,{version:'1.1.0',platform:'win32',onError:error=>{record('transport-error',{code:error.code,message:error.message});throw error}});
 output.on('data',chunk=>{received+=chunk;fs.appendFileSync(${JSON.stringify(raw)},chunk);if(received.length===tail.length){assert.equal(received,tail);record('raw-tail-complete',{bytes:Buffer.byteLength(received)});agent._cleanUpProcess()}});
 output.on('close',()=>{record('receiver-close');exit.fire({exitCode:0});if(!${fixed}){connection.dispose();input.destroy()}});
 output.on('error',error=>{record('receiver-error',{code:error.code});throw error});
 connection.onReady(()=>connection.connectSocket(output));
});
process.once('beforeExit',()=>{assert.equal(received,tail);assert.equal(workerExited,true);record('natural-beforeExit')});
`,
    );
    await exec(process.execPath, [fixture], { cwd: root, timeout: 7000 });
    const records = (await readFile(progress, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const close = records.find(
      (record) => record.step === 'receiver-close-request',
    );
    assert.ok(close);
    assert.equal(
      close.workerExited,
      fixed,
      'the old receiving-close operation has a live writer; the fixed operation must not',
    );
    assert.ok(records.some((record) => record.step === 'natural-beforeExit'));
    assert.ok(
      !records.some(
        (record) =>
          record.step === 'transport-error' || record.step === 'receiver-error',
      ),
    );
    const actual = await readFile(raw);
    assert.deepEqual(actual, Buffer.from(tail));
    assert.equal(
      createHash('sha256').update(actual).digest('hex'),
      createHash('sha256').update(tail).digest('hex'),
    );
    t.diagnostic(
      JSON.stringify({
        fixed,
        progress,
        raw,
        rawBytes: actual.length,
        sha256: createHash('sha256').update(actual).digest('hex'),
      }),
    );
  }
});
