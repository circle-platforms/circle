import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  decodeOutput,
  decodesCodePage,
  detectConsoleCodePage,
  parseChcp,
  useConsoleCodePage,
} from '../src/output_encoding.js';
import { JobRegistry, outputTail } from '../src/jobs.js';
import { Sandbox } from '../src/sandbox.js';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings } from '../src/settings.js';
import type { Message, ModelResponse } from '../src/types.js';
import { emptyUsage } from '../src/types.js';
import { scratch, cleanup } from './helpers.js';

// What `ver` and `echo 中文测试` write on a Simplified Chinese Windows (code page 936).
const VER_936 = Buffer.from(
  '0d0a4d6963726f736f66742057696e646f7773205bb0e6b1be2031302e302e32363230302e393731315d0d0a',
  'hex',
);
const ECHO_936 = Buffer.from('d6d0cec4b2e2cad40d0a', 'hex');
let scriptNumber = 0;
function script(root: string, code: string): string {
  const path = join(root, `encoding-${++scriptNumber}.cjs`);
  writeFileSync(path, code);
  return `"${process.execPath}" "${path}"`;
}
// A script that writes these bytes, each part in its own write.
function writes(root: string, ...parts: Buffer[]): string {
  return script(
    root,
    `const fs=require('fs');const parts=${JSON.stringify(parts.map((part) => part.toString('hex')))};(async()=>{for(const part of parts){fs.writeSync(1,Buffer.from(part,'hex'));await new Promise(r=>setTimeout(r,60));}})();`,
  );
}
function console936(t: TestContext): void {
  useConsoleCodePage(936);
  t.after(() => useConsoleCodePage(undefined));
}
function response(
  id: string,
  content: string,
  calls: Message['tool_calls'] = [],
): ModelResponse {
  return {
    message: { id, role: 'assistant', content, tool_calls: calls },
    usage: emptyUsage(),
  };
}
const toolResult = (messages: Message[], id: string): string =>
  messages.find(
    (message) => message.role === 'tool' && message.tool_call_id === id,
  )!.content as string;

test('console output in code page 936 is read as Chinese, and UTF-8 lines in it stay UTF-8', () => {
  assert.equal(
    decodeOutput(Buffer.concat([VER_936, ECHO_936]), { codePage: 936 }),
    '\r\nMicrosoft Windows [版本 10.0.26200.9711]\r\n中文测试\r\n',
  );
  // git or node in the same command write UTF-8.
  assert.equal(
    decodeOutput(Buffer.concat([ECHO_936, Buffer.from('提交 ✓\n')]), {
      codePage: 936,
    }),
    '中文测试\r\n提交 ✓\n',
  );
  // A ConPTY, or a console switched with chcp 65001, gives UTF-8 whatever the code page.
  assert.equal(
    decodeOutput(Buffer.from('版本 é\n'), { codePage: 936 }),
    '版本 é\n',
  );
  assert.equal(
    decodeOutput(Buffer.from([0x82, 0x81, 0x0a]), { codePage: 437 }),
    'éü\n',
  );
  assert.equal(
    decodeOutput(Buffer.from([0x80, 0xd5]), { codePage: 858 }),
    'Ç€',
  );
  assert.equal(
    decodeOutput(Buffer.from([0xc0, 0xe1]), { codePage: 1251 }),
    'Аб',
  );
  // Bytes that are not text in the code page do not become anything else.
  assert.equal(
    decodeOutput(ECHO_936, { codePage: 65001 }).includes('中'),
    false,
  );
  assert.equal(decodesCodePage(936), true);
  assert.equal(decodesCodePage(65001), false);
  assert.equal(decodesCodePage(99999), false);
  assert.equal(decodeOutput(Buffer.from('中文'), { codePage: 99999 }), '中文');
});

test('a cut inside a character leaves that character out instead of writing U+FFFD', () => {
  const utf8 = Buffer.from('ab中文');
  assert.equal(
    decodeOutput(utf8.subarray(0, 4), { codePage: 65001, cutEnd: true }),
    'ab',
  );
  assert.equal(
    decodeOutput(utf8.subarray(0, 4), { codePage: 936, cutEnd: true }),
    'ab',
  );
  assert.equal(
    decodeOutput(utf8.subarray(3), { codePage: 65001, cutStart: true }),
    '文',
  );
  // A cut between the two bytes of a 936 character.
  assert.equal(
    decodeOutput(ECHO_936.subarray(0, 5), { codePage: 936, cutEnd: true }),
    '中文',
  );
  // Without a cut a broken character still shows as U+FFFD.
  assert.equal(
    decodeOutput(utf8.subarray(0, 4), { codePage: 65001 }),
    'ab\uFFFD',
  );
});

test('the console code page comes from chcp, then the registry, and is UTF-8 off Windows', () => {
  const asked: string[] = [];
  const answers =
    (chcp: Buffer | undefined, reg?: Buffer) =>
    (command: string, args: string[]) => {
      asked.push([command, ...args].join(' '));
      return command === 'reg' ? reg : chcp;
    };
  assert.equal(
    detectConsoleCodePage('linux', () => {
      throw new Error('not run');
    }),
    65001,
  );
  // 活动代码页: 936, written in 936 itself.
  const chinese = Buffer.concat([
    Buffer.from('bbeeb6afb4fac2ebd2b33a', 'hex'),
    Buffer.from(' 936\r\n'),
  ]);
  assert.equal(
    detectConsoleCodePage('win32', answers(chinese), {
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    }),
    936,
  );
  assert.deepEqual(asked, ['C:\\Windows\\system32\\cmd.exe /d /c chcp']);
  assert.equal(parseChcp('Aktive Codepage: 850.\r\n'), 850);
  assert.equal(parseChcp('Active code page: 65001'), 65001);
  assert.equal(parseChcp('no number'), undefined);
  asked.length = 0;
  assert.equal(
    detectConsoleCodePage(
      'win32',
      answers(
        undefined,
        Buffer.from(
          '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage\r\n    OEMCP    REG_SZ    437\r\n',
        ),
      ),
      {},
    ),
    437,
  );
  assert.deepEqual(asked, [
    'cmd.exe /d /c chcp',
    'reg query HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage /v OEMCP',
  ]);
  assert.equal(
    detectConsoleCodePage(
      'win32',
      () => {
        throw new Error('spawn failed');
      },
      {},
    ),
    65001,
  );
});

test('a UTF-8 character split between two writes reaches the result whole', async (t) => {
  const root = scratch(t);
  const bytes = Buffer.from('中 文\n');
  const result = await new Sandbox(root).execute(
    writes(root, bytes.subarray(0, 2), bytes.subarray(2, 6), bytes.subarray(6)),
    new AbortController().signal,
  );
  assert.equal(result.output, '中 文\n');
  assert.equal(result.exit_code, 0);
});

test('Sandbox.execute decodes code page 936 output', async (t) => {
  console936(t);
  const root = scratch(t);
  const result = await new Sandbox(root).execute(
    writes(root, VER_936.subarray(0, 25), VER_936.subarray(25), ECHO_936),
    new AbortController().signal,
  );
  assert.equal(
    result.output,
    '\r\nMicrosoft Windows [版本 10.0.26200.9711]\r\n中文测试\r\n',
  );
});

test('the 80 000-byte head of a foreground command ends on a whole character', async (t) => {
  const root = scratch(t);
  const jobs = new JobRegistry(new Sandbox(root, join(root, 'data')));
  cleanup(t, () => jobs.close().then(() => {}));
  // 中 takes bytes 79 999 to 80 001, across the cut.
  const result = await jobs.execute(
    writes(root, Buffer.from('x'.repeat(79_999) + '中文')),
    { sessionId: 'one' },
    new AbortController().signal,
  );
  assert.equal(result.exit_code, 0);
  assert.ok(
    result.output.startsWith('x'.repeat(79_999) + '\nOutput continues in '),
  );
  assert.equal(result.output.includes('\uFFFD'), false);
});

test('in code page 936 the model reads command output, job notices, tails and job logs as Chinese', async (t) => {
  console936(t);
  const root = scratch(t);
  const foreground = writes(
    root,
    VER_936,
    ECHO_936.subarray(0, 3),
    ECHO_936.subarray(3),
  );
  const background = writes(
    root,
    ECHO_936,
    Buffer.from('x'.repeat(40_000) + '\r\n'),
    ECHO_936,
  );
  let runtime!: AgentRuntime;
  const model = new ScriptedModel([
    response('start', '', [
      { id: 'fg', name: 'execute', args: { command: foreground } },
      {
        id: 'bg',
        name: 'execute',
        args: { command: background, background: true },
      },
    ]),
    async () => {
      const job = runtime.jobs.list(runtime.session.id)[0]!;
      await runtime.jobs.wait([job.id], 5, new AbortController().signal);
      return response('read', '', [
        {
          id: 'log',
          name: 'read_file',
          args: { file_path: job.virtualPath, limit: 1 },
        },
      ]);
    },
    response('end', 'done'),
  ]);
  runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('run them');
  assert.equal(
    toolResult(model.requests[1]!.messages, 'fg'),
    '\r\nMicrosoft Windows [版本 10.0.26200.9711]\r\n中文测试\r\n\nExit code: 0',
  );
  const last = model.requests[2]!.messages;
  assert.equal(toolResult(last, 'log'), '1: 中文测试');
  const notice = last.find((message) => message.internal === 'job_notice');
  // The tail starts inside the long line, which it leaves out.
  assert.match(notice!.content as string, /Last output:\n中文测试\n/);
  const job = runtime.jobs.list(runtime.session.id)[0]!;
  assert.equal(outputTail(job.outputPath), '中文测试');
});
