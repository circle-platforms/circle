import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DeliveryService } from '../src/workspace/delivery.ts';
test('local gh adapter reports checks and refuses ready on failing CI', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-gh-'));
  try {
    const gh = path.join(root, 'fake-gh');
    const log = path.join(root, 'calls');
    await writeFile(
      gh,
      `#!/usr/bin/env node\nconst fs=require('fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');if(a[0]==='--version') console.log('gh version 2.83.2');else if(a[0]==='auth')process.exit(0);else if(a[0]==='pr'&&a[1]==='checks')console.log(JSON.stringify([{name:'test',bucket:'fail',state:'FAILURE'}]));else if(a[0]==='pr'&&a[1]==='view')console.log(JSON.stringify({number:1,url:'https://example.invalid/pr/1',headRefOid:'wrong'}));else process.exit(3);`,
    );
    await chmod(gh, 0o755);
    const s = new DeliveryService(root, gh);
    if (process.platform === 'win32')
      s.gh = async (args) =>
        (
          await promisify(execFile)(process.execPath, [gh, ...args], {
            cwd: root,
            encoding: 'utf8',
            env: { ...process.env, GH_PROMPT_DISABLED: '1' },
          })
        ).stdout;
    await s.git.git(['init']);
    const status = (await s.call('status')) as { authenticated: boolean };
    assert.equal(status.authenticated, true);
    assert.deepEqual(await s.call('checks'), [
      { name: 'test', bucket: 'fail', state: 'FAILURE' },
    ]);
    await assert.rejects(s.call('logs', { runId: '--help' }), /valid run/);
    await assert.rejects(
      s.call('ready', { revision: (await s.git.snapshot()).revision }),
      /head changed/,
    );
    assert.equal((await readFile(log, 'utf8')).includes('"ready"'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
