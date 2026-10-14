import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
interface TestContext {
  after(fn: () => void | Promise<void>): void;
}
interface Resources {
  roots: string[];
  cleanup: (() => void | Promise<void>)[];
}
const resources = new WeakMap<TestContext, Resources>();
function owned(t: TestContext): Resources {
  let state = resources.get(t);
  if (!state) {
    state = { roots: [], cleanup: [] };
    resources.set(t, state);
    t.after(async () => {
      const errors: unknown[] = [];
      for (const cleanup of state!.cleanup.reverse()) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      for (const root of state!.roots.reverse()) {
        try {
          // Let process close callbacks run while Windows releases a killed child's folder.
          await rm(root, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 100,
          });
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length)
        throw new AggregateError(errors, 'test resource cleanup failed');
    });
  }
  return state;
}
export function scratch(t: TestContext, prefix = 'circle-test-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  owned(t).roots.push(root);
  return root;
}
export function cleanup(
  t: TestContext,
  action: () => void | Promise<void>,
): void {
  owned(t).cleanup.push(action);
}

/** A real descendant waits for permission to write, independent of scheduling delay. */
export async function cancellationFixture(t: TestContext, root: string) {
  const token = crypto.randomUUID();
  let connection: Socket | undefined;
  let ready!: (identity: { pid: number; parentPid: number }) => void;
  const started = new Promise<{ pid: number; parentPid: number }>((resolve) => {
    ready = resolve;
  });
  let finish!: (outcome: 'closed' | 'wrote') => void;
  const finished = new Promise<'closed' | 'wrote'>((resolve) => {
    finish = resolve;
  });
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => {
      sockets.delete(socket);
      if (socket === connection) finish('closed');
    });
    let input = '';
    socket.on('data', (chunk) => {
      input += chunk.toString();
      for (let end; (end = input.indexOf('\n')) >= 0;) {
        const line = input.slice(0, end);
        input = input.slice(end + 1);
        const message = JSON.parse(line);
        if (message.token !== token) {
          socket.destroy();
          return;
        }
        if (message.kind === 'ready') {
          connection = socket;
          ready({ pid: message.pid, parentPid: message.parentPid });
        } else if (socket === connection && message.kind === 'wrote')
          finish('wrote');
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address !== 'object')
    throw Error('no fixture address');
  let closed: Promise<void> | undefined;
  const close = () =>
    (closed ??= new Promise<void>((done) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => done());
    }));
  cleanup(t, close);
  writeFileSync(
    join(root, 'grandchild.cjs'),
    `const fs=require('node:fs'),net=require('node:net');
const token=${JSON.stringify(token)};
const socket=net.connect(${address.port},'127.0.0.1',()=>{
  fs.writeFileSync('started','yes');
  socket.write(JSON.stringify({token,kind:'ready',pid:process.pid,parentPid:process.ppid})+'\\n');
});
let input='';
socket.on('data',chunk=>{
  input+=chunk.toString();
  if(!input.includes('\\n'))return;
  if(input.trim()!==token)process.exit(1);
  fs.writeFileSync('late','bad');
  socket.end(JSON.stringify({token,kind:'wrote'})+'\\n');
});
socket.on('error',()=>process.exit(1));
socket.on('close',()=>process.exit(0));`,
  );
  writeFileSync(
    join(root, 'parent.cjs'),
    "const child=require('node:child_process').spawn(process.execPath,['grandchild.cjs'],{stdio:'ignore'});child.on('error',()=>process.exit(1));child.on('exit',code=>process.exit(code??1));",
  );
  async function bounded<T>(promise: Promise<T>, stage: string): Promise<T> {
    let timer!: NodeJS.Timeout;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(Error(`cancellation fixture ${stage} timed out`)),
            10000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    command: `"${process.execPath}" "${join(root, 'parent.cjs')}"`,
    ready: () => bounded(started, 'readiness'),
    exited: <T>(running: Promise<T>) => bounded(running, 'process exit'),
    async release() {
      if (!connection) throw Error('fixture is not ready');
      if (!connection.destroyed) connection.write(token + '\n');
      return bounded(finished, 'write or exit');
    },
    close,
  };
}
