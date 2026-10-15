// Run the real CLI inside a PTY against an isolated, held local gateway.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  defaultSettings,
  saveCredentials,
  saveSettings,
  trustFolder,
} from '../src/settings.js';

if (process.platform === 'win32')
  throw new Error('this PTY check requires macOS or Linux and python3');
const root = mkdtempSync(join(tmpdir(), 'circle-tui-sessions-'));
const home = join(root, 'home');
const workspace = join(root, 'workspace');
mkdirSync(home);
mkdirSync(workspace);
const repository = resolve(fileURLToPath(new URL('..', import.meta.url)));
const requests: {
  body: { messages: { role: string; content: string }[] };
  response: ServerResponse;
  finished: boolean;
}[] = [];
const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'synthetic-pty-model' }] }));
    return;
  }
  if (request.url !== '/v1/chat/completions') {
    response.writeHead(404).end();
    return;
  }
  let body = '';
  for await (const chunk of request) body += chunk;
  requests.push({ body: JSON.parse(body), response, finished: false });
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(
    'data: ' +
      JSON.stringify({
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: `stream ${requests.length}` },
            finish_reason: null,
          },
        ],
      }) +
      '\n\n',
  );
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string')
  throw new Error('no local gateway address');
const settings = trustFolder(defaultSettings(), workspace);
settings.initialized = true;
settings.update_check = false;
settings.auth.base_url = `http://127.0.0.1:${address.port}/v1`;
settings.auth.model = 'synthetic-pty-model';
saveSettings(settings, home);
saveCredentials({ api_key: 'synthetic-local-only' }, home);
const python = String.raw`
import os,sys,json,pty,select,signal,fcntl,termios,struct
command=json.loads(sys.argv[1])
pid,master=pty.fork()
if pid==0: os.execvpe(command[0],command,os.environ)
fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',35,120,0,0))
reaped=False
exit_status=0
try:
  while True:
    ready,_,_=select.select([master,sys.stdin],[],[],0.1)
    if sys.stdin in ready:
      line=sys.stdin.buffer.readline()
      if not line: break
      os.write(master,json.loads(line)['input'].encode())
    if master in ready:
      try: data=os.read(master,65536)
      except OSError: break
      if not data: break
      sys.stdout.buffer.write(data);sys.stdout.buffer.flush()
    done,status=os.waitpid(pid,os.WNOHANG)
    if done:
      reaped=True;exit_status=status;break
finally:
  if not reaped:
    try: os.kill(pid,signal.SIGTERM)
    except ProcessLookupError: pass
    _,exit_status=os.waitpid(pid,0)
  os.close(master)
sys.exit(os.waitstatus_to_exitcode(exit_status))
`;
const driver = spawn(
  'python3',
  [
    '-u',
    '-c',
    python,
    JSON.stringify([
      process.execPath,
      '--import',
      'tsx',
      'src/cli.ts',
      workspace,
    ]),
  ],
  {
    cwd: repository,
    env: {
      ...process.env,
      CIRCLE_HOME: home,
      CIRCLE_NO_MODELS_REFRESH: '1',
      CIRCLE_NO_TUI: '',
      TERM: 'xterm-256color',
      COLORFGBG: '15;0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  },
);
let transcript = '';
let exited = false;
let exitCode: number | null = null;
driver.stdout.on('data', (chunk) => {
  transcript += chunk;
});
driver.stderr.on('data', (chunk) => {
  transcript += chunk;
});
driver.on('error', (error) => {
  transcript += error.message;
});
driver.once('exit', (code) => {
  exited = true;
  exitCode = code;
});
const input = (input: string) =>
  driver.stdin.write(JSON.stringify({ input }) + '\n');
function sessions(): { id: string; title: string }[] {
  const file = join(home, 'circle.sqlite');
  if (!existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare('SELECT id,title FROM sessions WHERE parent_id IS NULL')
      .all() as { id: string; title: string }[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}
async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline || exited)
      throw new Error(
        `${label} failed (${exitCode}): ${transcript.slice(-4000)}`,
      );
    await delay(10);
  }
}
function histories(sessionId: string): { role: string; content: string }[] {
  const db = new DatabaseSync(join(home, 'circle.sqlite'), { readOnly: true });
  try {
    return db
      .prepare(
        'SELECT message FROM checkpoints WHERE session_id = ? ORDER BY created',
      )
      .all(sessionId)
      .map((row) => JSON.parse(String(row.message)));
  } finally {
    db.close();
  }
}
async function verifyTwoTerminals(): Promise<void> {
  const spawnTerminal = () => {
    const process = spawn(
      'python3',
      [
        '-u',
        '-c',
        python,
        JSON.stringify([
          globalThis.process.execPath,
          '--import',
          'tsx',
          'src/cli.ts',
          workspace,
        ]),
      ],
      {
        cwd: repository,
        env: {
          ...globalThis.process.env,
          CIRCLE_HOME: home,
          CIRCLE_NO_MODELS_REFRESH: '1',
          CIRCLE_NO_TUI: '',
          TERM: 'xterm-256color',
          COLORFGBG: '15;0',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const state = {
      process,
      output: '',
      exited: false,
      code: null as number | null,
    };
    process.stdout.on('data', (chunk) => {
      state.output += chunk;
    });
    process.stderr.on('data', (chunk) => {
      state.output += chunk;
    });
    process.on('error', (error) => {
      state.output += error.message;
    });
    process.once('exit', (code) => {
      state.exited = true;
      state.code = code;
    });
    return {
      state,
      input: (input: string) =>
        process.stdin.write(JSON.stringify({ input }) + '\n'),
    };
  };
  const prior = sessions().length;
  const first = spawnTerminal();
  const second = spawnTerminal();
  const wait = async (check: () => boolean, stage: string) => {
    const deadline = Date.now() + 15_000;
    while (!check()) {
      if (Date.now() > deadline)
        throw new Error(
          `${stage}: first ${first.state.code} ${first.state.output.slice(-2000)}; second ${second.state.code} ${second.state.output.slice(-2000)}`,
        );
      await delay(10);
    }
  };
  try {
    await wait(
      () =>
        sessions().length === prior + 2 &&
        [first, second].every((terminal) =>
          terminal.state.output.includes('synthetic-pty-model'),
        ),
      'two-terminal startup',
    );
    const beforeRequests = requests.length;
    first.input('PTY terminal one\r');
    second.input('PTY terminal two\r');
    await wait(
      () => requests.length === beforeRequests + 2,
      'two-terminal concurrent requests',
    );
    const one = sessions().find((session) =>
      session.title.includes('PTY terminal one'),
    )!;
    const two = sessions().find((session) =>
      session.title.includes('PTY terminal two'),
    )!;
    assert(one && two && one.id !== two.id);
    const requestOne = requests
      .slice(beforeRequests)
      .find((item) =>
        item.body.messages.some(
          (message) =>
            message.role === 'user' && message.content === 'PTY terminal one',
        ),
      )!;
    const requestTwo = requests
      .slice(beforeRequests)
      .find((item) =>
        item.body.messages.some(
          (message) =>
            message.role === 'user' && message.content === 'PTY terminal two',
        ),
      )!;
    assert(requestOne && requestTwo);
    assert(
      !requestOne.response.destroyed && !requestTwo.response.destroyed,
      'both independent CLI requests overlap',
    );
    first.input('\x1b');
    await wait(() => requestOne.response.destroyed, 'stop first terminal');
    assert(!requestTwo.response.destroyed);
    first.input('/exit\r');
    await wait(() => first.state.exited, 'first terminal exit');
    assert.equal(first.state.code, 0);
    assert(
      !second.state.exited && !requestTwo.response.destroyed,
      'first terminal exit leaves the second request running',
    );
    requestTwo.response.end(
      'data: ' +
        JSON.stringify({
          choices: [
            {
              index: 0,
              delta: { content: 'second terminal complete' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }) +
        '\n\ndata: [DONE]\n\n',
    );
    await wait(
      () =>
        histories(two.id).some((message) =>
          message.content.includes('second terminal complete'),
        ),
      'second terminal stored completion',
    );
    assert(
      !histories(one.id).some((message) =>
        message.content.includes('PTY terminal two'),
      ),
    );
    assert(
      !histories(two.id).some((message) =>
        message.content.includes('PTY terminal one'),
      ),
    );
    second.input('/exit\r');
    await wait(() => second.state.exited, 'second terminal exit');
    assert.equal(second.state.code, 0);
    console.log(
      JSON.stringify({
        check: 'two real CLI PTYs sharing home and workspace',
        concurrentRequests: 2,
        separateSessions: [one.id, two.id],
        firstExitCode: first.state.code,
        secondExitCode: second.state.code,
        firstCancellationAndExitLeaveSecondRunning: true,
        isolatedStoredHistories: true,
      }),
    );
  } finally {
    for (const terminal of [first, second]) terminal.state.process.stdin.end();
    await Promise.all(
      [first, second].map(async (terminal) => {
        if (!terminal.state.exited)
          await Promise.race([
            new Promise<void>((resolve) =>
              terminal.state.process.once('exit', () => resolve()),
            ),
            delay(5000),
          ]);
        if (!terminal.state.exited) terminal.state.process.kill('SIGTERM');
      }),
    );
  }
}
try {
  await until(
    () => sessions().length === 1 && transcript.includes('synthetic-pty-model'),
    'startup',
  );
  input('PTY prompt A\r');
  await until(() => requests.length === 1, 'first request');
  const a = sessions().find((session) =>
    session.title.includes('PTY prompt A'),
  )!;
  assert(a);
  input('/new\r');
  await until(
    () => sessions().length === 2 && transcript.includes('New session'),
    'new while running',
  );
  input('PTY prompt B\r');
  await until(() => requests.length === 2, 'second concurrent request');
  const b = sessions().find((session) =>
    session.title.includes('PTY prompt B'),
  )!;
  assert(b);
  assert(requests.every((item) => !item.response.destroyed));
  assert.deepEqual(
    requests.map((item) =>
      item.body.messages
        .filter((message) => message.role === 'user')
        .map((message) => message.content),
    ),
    [['PTY prompt A'], ['PTY prompt B']],
  );
  input(`/resume ${a.id}\r`);
  await until(
    () => transcript.includes(`Resumed ${a.id}`),
    'switch to running A',
  );
  input('\x1b');
  await until(() => requests[0]!.response.destroyed, 'stop A');
  assert(!requests[1]!.response.destroyed, 'stopping A leaves B in flight');
  input('/continue\r');
  await until(() => transcript.includes(`Continued ${b.id}`), 'return to B');
  const response = requests[1]!.response;
  response.write(
    'data: ' +
      JSON.stringify({
        choices: [
          {
            index: 0,
            delta: { content: ' finished B' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 3 },
      }) +
      '\n\ndata: [DONE]\n\n',
  );
  requests[1]!.finished = true;
  response.end();
  await until(() => transcript.includes('finished B'), 'B completion');
  input('\x1bs');
  await until(
    () => transcript.includes('Sessions · this folder'),
    'session picker',
  );
  input('\x04');
  await until(
    () => transcript.includes('and its messages?'),
    'delete confirmation',
  );
  input('\r');
  await until(
    () => !sessions().some((session) => session.id === b.id),
    'confirmed current deletion',
  );
  assert(sessions().some((session) => session.id === a.id));
  input('\x1b');
  await delay(100);
  input('/exit\r');
  await until(() => exited, 'graceful exit');
  assert.equal(exitCode, 0);
  console.log(
    JSON.stringify({
      check: 'real CLI PTY sessions',
      concurrentRequests: requests.length,
      stoppedSession: a.id,
      completedThenDeletedSession: b.id,
      isolatedUserHistories: true,
      exitCode,
    }),
  );
  await verifyTwoTerminals();
} finally {
  driver.stdin.end();
  if (!exited) driver.kill('SIGTERM');
  for (const item of requests) item.response.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!exited)
    await Promise.race([
      new Promise<void>((resolve) => driver.once('exit', () => resolve())),
      delay(5000),
    ]);
  rmSync(root, { recursive: true, force: true });
}
