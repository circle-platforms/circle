import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runComponentSuites } from './component-suites.mjs';

test('component gate runs real child processes serially and retains the first failure without running later suites', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-component-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const effects = join(root, 'effects.log');
  const files = ['first', 'failed', 'never'].map((name) =>
    join(root, name + '.mjs'),
  );
  const append = `import {appendFileSync} from 'node:fs'; const write=(line)=>appendFileSync(${JSON.stringify(effects)},line+'\\n');`;
  await writeFile(
    files[0]!,
    append + "write('start');setTimeout(()=>write('end'),30);",
  );
  await writeFile(
    files[1]!,
    append +
      "write('failed');console.error('synthetic diagnostic');process.exitCode=3;",
  );
  await writeFile(files[2]!, append + "write('must not execute');");
  const outputRoot = join(root, 'evidence');
  await assert.rejects(
    runComponentSuites({ suites: files, outputRoot, nodeArguments: [] }),
    /component UI failed/,
  );
  assert.equal(await readFile(effects, 'utf8'), 'start\nend\nfailed\n');
  const [attempt] = await readdir(outputRoot);
  const receipt = JSON.parse(
    await readFile(join(outputRoot, attempt!, 'receipt.json'), 'utf8'),
  );
  assert.deepEqual(
    receipt.suites.map((suite: { state: string }) => suite.state),
    ['passed', 'failed'],
  );
  assert.equal(receipt.suites[1].code, 3);
  assert.match(
    await readFile(join(receipt.suites[1].directory, 'output.log'), 'utf8'),
    /synthetic diagnostic/,
  );
});
