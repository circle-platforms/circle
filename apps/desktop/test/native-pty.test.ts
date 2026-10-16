import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { scratch } from '../../../tests/helpers.ts';

const exec = promisify(execFile);
const entry = fileURLToPath(
  new URL('../src/workspace/native-pty.ts', import.meta.url),
);

test('bundled native PTY stays lazy without native resources and resolves real dist/node_modules for ESM and CJS', async (t) => {
  const root = scratch(t, 'circle-lazy-pty-');
  const empty = join(root, 'without-native');
  const dist = join(root, 'dist');
  await mkdir(empty);
  await mkdir(dist);
  const packagePath = createRequire(import.meta.url).resolve(
    'node-pty/package.json',
  );
  await cp(dirname(packagePath), join(dist, 'node_modules', 'node-pty'), {
    recursive: true,
  });
  for (const format of ['esm', 'cjs'] as const) {
    const filename = format === 'esm' ? 'native-pty.mjs' : 'native-pty.cjs';
    const bundle = join(empty, filename);
    const result = await build({
      entryPoints: [entry],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      target: 'node24',
      format,
      metafile: true,
      logLevel: 'silent',
    });
    assert.equal(
      Object.keys(result.metafile!.inputs).some((path) =>
        /node_modules[\\/]node-pty[\\/]/.test(path),
      ),
      false,
    );
    const load = (path: string) =>
      format === 'esm'
        ? `await import(${JSON.stringify(pathToFileURL(path).href)})`
        : `createRequire(import.meta.url)(${JSON.stringify(path)})`;
    const env = {
      ...process.env,
      NODE_PATH: '',
      CIRCLE_HOME: root,
      CIRCLE_WORKBENCH_DATA_DIR: root,
    };
    const withoutNative = await exec(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import assert from 'node:assert/strict';import {createRequire} from 'node:module';const module=${load(bundle)}; assert.equal(typeof module.spawnPty,'function'); console.log('LAZY_IMPORT_OK');`,
      ],
      { cwd: root, env },
    );
    assert.match(withoutNative.stdout, /LAZY_IMPORT_OK/);
    const packaged = join(dist, filename);
    await cp(bundle, packaged);
    const program =
      "console.log('PTY_READY:'+process.stdin.isTTY); process.stdin.once('data',bytes=>{console.log('PTY_READ:'+bytes.toString().trim());process.exit(0)});";
    const script = `
      import assert from 'node:assert/strict';import {createRequire} from 'node:module';
      const module=${load(packaged)};
      const pty=module.spawnPty(process.execPath,['-e',${JSON.stringify(program)}],{cwd:${JSON.stringify(root)},env:process.env,cols:80,rows:24});
      const {installWindowsPtyExitCleanup}=await import(${JSON.stringify(new URL('../src/workspace/pty-exit-cleanup.mjs', import.meta.url).href)});
      installWindowsPtyExitCleanup(pty,{version:createRequire(${JSON.stringify(pathToFileURL(join(dist, 'probe.cjs')).href)})('node-pty/package.json').version});
      let output='',sent=false;
      const timer=setTimeout(()=>{pty.kill();process.exitCode=1},5000);
      pty.onData(bytes=>{output+=bytes;if(!sent && output.includes('PTY_READY:true')){sent=true;pty.write('from bundled terminal\\r')}});
      await new Promise((resolve,reject)=>pty.onExit(({exitCode})=>{clearTimeout(timer);try{assert.equal(exitCode,0,output);assert.match(output,/PTY_READY:true/);assert.match(output,/PTY_READ:from bundled terminal/);resolve()}catch(error){reject(error)}}));
      console.log('REAL_PTY_OK');
    `;
    const actual = await exec(
      process.execPath,
      ['--input-type=module', '-e', script],
      { cwd: root, env, timeout: 10000 },
    );
    assert.match(actual.stdout, /REAL_PTY_OK/);
  }
});
