import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  parseModelRequestFrames,
  readModelRequests,
} from './helpers/model-requests.mjs';

const bytes = (text) => Buffer.from(text);
const digest = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('a valid JSON value without LF remains unpublished until the worker commits it', () => {
  assert.deepEqual(parseModelRequestFrames(bytes('')), []);
  assert.deepEqual(parseModelRequestFrames(bytes('{"sequence":1}')), []);
  assert.throws(
    () =>
      parseModelRequestFrames(bytes('{"sequence":1}'), {
        requireComplete: true,
      }),
    /incomplete final frame/,
  );
  assert.deepEqual(parseModelRequestFrames(bytes('{"sequence":1}\n')), [
    { sequence: 1 },
  ]);
});

test('escaped newlines and CRLF preserve the actual JSON record values', () => {
  const records = [
    { content: 'line one\n中文🚀\nline three' },
    { sequence: 2 },
  ];
  const log = bytes(
    records.map((record) => JSON.stringify(record)).join('\r\n') + '\r\n',
  );
  assert.deepEqual(
    parseModelRequestFrames(log, { requireComplete: true }),
    records,
  );
});

test('malformed complete frames fail immediately even when another frame is incomplete', () => {
  const log = bytes('{"sequence":1}\n{"broken":}\n{"unfinished":');
  for (const requireComplete of [false, true])
    assert.throws(
      () => parseModelRequestFrames(log, { requireComplete }),
      SyntaxError,
    );
  assert.throws(() => parseModelRequestFrames(bytes('\n')), SyntaxError);
  assert.throws(
    () => parseModelRequestFrames(bytes('\ufeff{}\n')),
    SyntaxError,
  );
});

test('UTF-8 is decoded strictly only within complete LF-terminated frames', () => {
  const prefix = bytes('{"sequence":1}\n');
  const log = Buffer.concat([
    prefix,
    bytes('{"content":"'),
    Buffer.from([0xe4]),
  ]);
  assert.deepEqual(parseModelRequestFrames(log), [{ sequence: 1 }]);
  assert.throws(
    () => parseModelRequestFrames(log, { requireComplete: true }),
    /incomplete final frame/,
  );
  assert.throws(
    () => parseModelRequestFrames(Buffer.concat([log, bytes('"}\n')])),
    TypeError,
  );
});

test('reading model requests preserves I/O failures and never changes raw tail bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-model-request-io-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'requests.jsonl');
  await assert.rejects(readModelRequests(path), { code: 'ENOENT' });
  const log = bytes('{"sequence":1}\n{"private":"raw-tail-must-stay-visible');
  await writeFile(path, log, { mode: 0o600 });
  assert.deepEqual(await readModelRequests(path), [{ sequence: 1 }]);
  assert.equal((await readFile(path)).equals(log), true);
  assert.equal(
    (await readFile(path)).includes(bytes('raw-tail-must-stay-visible')),
    true,
  );
  await assert.rejects(
    readModelRequests(path, { requireComplete: true }),
    /incomplete final frame/,
  );
});

test(
  'a separate controlled writer publishes a large frame only after its LF append',
  { timeout: 5000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'circle-model-request-append-'));
    const path = join(root, 'requests.jsonl');
    const first = { sequence: 1 };
    const second = { sequence: 2, content: 'escaped\n中文🚀'.repeat(9000) };
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
const { writeFileSync, appendFileSync } = require('node:fs');
let path, frame, cut;
process.on('message', request => {
  if (request.stage === 'partial') {
    path = request.path;
    frame = Buffer.from(JSON.stringify(request.second));
    cut = frame.indexOf(Buffer.from('中'), 60000) + 1;
    writeFileSync(path, JSON.stringify(request.first) + '\\n', { mode: 0o600 });
    appendFileSync(path, frame.subarray(0, cut));
    process.send({ stage: 'partial', bytes: cut });
  } else if (request.stage === 'json-complete') {
    appendFileSync(path, frame.subarray(cut));
    process.send({ stage: 'json-complete' });
  } else {
    appendFileSync(path, '\\n');
    process.send({ stage: 'committed' }, () => process.exit(0));
  }
});
`,
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, 'exit');
        child.kill('SIGKILL');
        await stopped;
      }
      await rm(root, { recursive: true, force: true });
    });
    const stage = (request) =>
      new Promise((resolve, reject) => {
        const stop = () => {
          child.off('message', received);
          child.off('error', failed);
          child.off('close', closed);
        };
        const received = (message) => {
          stop();
          resolve(message);
        };
        const failed = (error) => {
          stop();
          reject(error);
        };
        const closed = () =>
          failed(Error('controlled writer closed before its frame boundary'));
        child.once('message', received);
        child.once('error', failed);
        child.once('close', closed);
        child.send(request, (error) => {
          if (error) failed(error);
        });
      });
    const partial = await stage({ stage: 'partial', path, first, second });
    assert(partial.bytes > 50631);
    assert.deepEqual(await readModelRequests(path), [first]);
    await assert.rejects(
      readModelRequests(path, { requireComplete: true }),
      /incomplete final frame/,
    );
    await stage({ stage: 'json-complete' });
    assert.deepEqual(
      await readModelRequests(path),
      [first],
      'valid JSON alone is not a published frame',
    );
    const stopped = once(child, 'exit');
    await stage({ stage: 'committed' });
    await stopped;
    const records = await readModelRequests(path, { requireComplete: true });
    assert.equal(records.length, 2);
    assert.deepEqual(records[0], first);
    assert.equal(digest(records[1]), digest(second));
    assert.equal(child.exitCode, 0);
  },
);
