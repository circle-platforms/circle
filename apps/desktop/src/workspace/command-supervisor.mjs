import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

if (process.platform === 'win32') {
  await windowsSupervisor();
} else {
  // This supervisor owns one POSIX PTY process group. It deliberately does not
  // claim ownership of a daemon which creates a different session/process group.
  // The Windows adapter stays closed until a real JobObject supervisor is supplied.
  const token = process.env.CIRCLE_COMMAND_CONTROL_TOKEN;
  delete process.env.CIRCLE_COMMAND_CONTROL_TOKEN;
  const socket = connect(process.argv[2]);
  socket.setEncoding('utf8');
  let child;
  let shellExit;
  let stopped = false;
  let unknown = false;
  let unmanaged = false;
  let finished = false;
  let scan;
  let buffer = '';
  let starting = false;
  let groupScan;
  let exitSent = false;
  let exitObservation;
  let acknowledgeRoot;
  const rootAcknowledged = new Promise((resolve) => {
    acknowledgeRoot = resolve;
  });
  let acknowledgeGroup;
  const groupAcknowledged = new Promise((resolve) => {
    acknowledgeGroup = resolve;
  });

  async function confirmReceived(acknowledgement) {
    let timer;
    try {
      await Promise.race([
        acknowledgement,
        new Promise((resolve) => {
          timer = setTimeout(resolve, 2500);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function send(value) {
    if (!socket.destroyed) socket.write(JSON.stringify(value) + '\n');
  }
  function fail(reason) {
    if (unknown) return;
    unknown = true;
    send({ kind: 'failure', reason });
  }

  async function inventory() {
    const probe = spawn('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat='], {
      // Keep the inventory child out of the group it is measuring.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    probe.stdout.setEncoding('utf8');
    probe.stdout.on('data', (part) => {
      output += part;
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        probe.kill();
        reject(Error('process inventory timed out'));
      }, 2000);
      probe.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      probe.once('close', (code) => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(Error('process inventory failed'));
      });
    });
    return output.split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
      if (!match || Number(match[1]) === probe.pid || match[4].startsWith('Z'))
        return [];
      return [
        {
          pid: Number(match[1]),
          parent: Number(match[2]),
          group: Number(match[3]),
        },
      ];
    });
  }

  function group() {
    return (groupScan ??= readGroup().finally(() => {
      groupScan = undefined;
    }));
  }
  async function groupAfterShellExit() {
    // An inventory started before the exit can still contain that exited shell.
    // Its cached rows cannot prove that a real descendant was left running.
    if (groupScan) await groupScan;
    return group();
  }
  async function readGroup() {
    const rows = await inventory();
    const own = rows.find((row) => row.pid === process.pid);
    if (!own || own.group !== process.pid)
      throw Error('supervisor lost its private PTY group');
    const descendants = new Set([process.pid]);
    for (let changed = true; changed;) {
      changed = false;
      for (const row of rows)
        if (descendants.has(row.parent) && !descendants.has(row.pid)) {
          descendants.add(row.pid);
          changed = true;
        }
    }
    if (
      rows.some((row) => descendants.has(row.pid) && row.group !== process.pid)
    )
      observeUnmanaged();
    return rows.filter(
      (row) => row.group === process.pid && row.pid !== process.pid,
    );
  }

  function observeUnmanaged() {
    if (unmanaged) return;
    unmanaged = true;
    send({
      kind: 'coverage',
      state: 'unmanaged',
      reason: 'outside-controlled-group',
    });
  }

  async function finish() {
    if (finished || unknown || !shellExit) return;
    finished = true;
    if (starting) {
      announceExit('empty');
      // A slow host gets a bounded opportunity to persist the actual root fact.
      // Missing delivery remains unknown at the host; it cannot synthesize exit.
      await confirmReceived(rootAcknowledged);
    } else send({ kind: 'command-not-started' });
    send({ kind: 'group-empty' });
    await confirmReceived(groupAcknowledged);
    process.exitCode = stopped ? 0 : shellExit.exitCode;
    socket.end();
  }

  function announceExit(controlledGroupAtExit) {
    if (exitSent || !shellExit) return;
    exitSent = true;
    send({ kind: 'root-exit', ...shellExit, controlledGroupAtExit });
  }

  async function observe() {
    if (finished || unknown) return;
    const members = await group();
    if (shellExit && !members.length) await finish();
  }

  function scheduleScan() {
    if (scan || finished || unknown) return scan;
    scan = observe()
      .catch(() => fail('controlled process-group observation failed'))
      .finally(() => {
        scan = undefined;
      });
    return scan;
  }

  async function stop() {
    if (stopped || finished) return;
    stopped = true;
    if (unknown) return;
    if (!starting) shellExit = { exitCode: 130 };
    // The still-live supervisor owns this exact group. SIGTERM includes the
    // supervisor, whose handler keeps it alive until its children have ended.
    process.kill(-process.pid, 'SIGTERM');
    const end = Date.now() + 700;
    while (Date.now() < end && !unknown) {
      await scheduleScan();
      if (finished) return;
      await delay(20);
    }
    if (unknown || finished) return;
    // Keep the supervisor alive to receive the actual command's wait status.
    // Only its still-live direct ChildProcess handle receives this signal.
    if (starting) {
      if (!shellExit) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* A racing natural exit still needs its actual wait event. */
        }
      }
      let timer;
      try {
        await Promise.race([
          exitObservation,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(Error('actual command exit was not observed')),
              2500,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (unknown || finished) return;
      await confirmReceived(rootAcknowledged);
    }
    // Group identity cannot be recycled while this supervisor remains in it.
    // Sending the final kill from inside that group avoids targeting an old PID.
    send({ kind: 'group-kill-armed' });
    socket.write('', () => {
      process.kill(-process.pid, 'SIGKILL');
    });
  }

  process.on('SIGINT', () => {}); // The same TTY also delivers it to the real command.
  process.on('SIGTERM', () => {
    if (!stopped) void stop().catch(() => fail('controlled stop failed'));
  });
  process.on('SIGHUP', () => {
    if (!stopped) void stop().catch(() => fail('controlled stop failed'));
  });

  socket.on('connect', () => send({ kind: 'hello', token }));
  socket.on('data', (part) => {
    buffer += part;
    if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) {
      fail('control message is too large');
      return;
    }
    for (let newline; (newline = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        fail('invalid control message');
        continue;
      }
      if (message.kind === 'stop') {
        void stop().catch(() => fail('controlled stop failed'));
        continue;
      }
      if (message.kind === 'root-exit-ack' && exitSent) {
        acknowledgeRoot();
        continue;
      }
      if (message.kind === 'group-empty-ack' && finished) {
        acknowledgeGroup();
        continue;
      }
      if (
        message.kind !== 'start' ||
        starting ||
        typeof message.command !== 'string'
      ) {
        fail('invalid command start');
        continue;
      }
      starting = true;
      const command = message.command;
      message = undefined;
      child = spawn(command, {
        shell: '/bin/sh',
        stdio: 'inherit',
        env: process.env,
      });
      let observedExit, exitFailed;
      exitObservation = new Promise((resolve, reject) => {
        observedExit = resolve;
        exitFailed = reject;
      });
      void exitObservation.catch(() => {});
      child.once('error', () => fail('approved command could not be started'));
      child.once('spawn', () =>
        send({ kind: 'started', pid: child.pid, group: process.pid }),
      );
      child.once('exit', (code, signal) => {
        shellExit = {
          exitCode: code ?? 130,
          ...(signal ? { signal: constants.signals[signal] } : {}),
        };
        void groupAfterShellExit()
          .then((members) => {
            announceExit(members.length ? 'active' : 'empty');
            observedExit();
            if (!members.length) return finish();
          })
          .catch((error) => {
            exitFailed(error);
            fail('command exit process-group state could not be established');
          });
      });
    }
  });
  socket.on('error', () => {
    if (!finished) fail('private command control failed');
  });
  socket.on('close', () => {
    if (!finished && !unknown)
      void stop().catch(() => fail('controlled stop failed'));
  });

  const timer = setInterval(() => {
    void scheduleScan();
  }, 50);
  timer.unref();
}

async function windowsSupervisor() {
  const token = process.env.CIRCLE_COMMAND_CONTROL_TOKEN;
  delete process.env.CIRCLE_COMMAND_CONTROL_TOKEN;
  const socket = connect(process.argv[2]);
  socket.setEncoding('utf8');
  let buffer = '',
    child,
    started = false,
    exited = false,
    acknowledged = false;
  // Without a command grant this fixed supervisor remains quiescent and exits
  // itself on lost authentication. No unverified PID needs signalling.
  const startupWatchdog = setTimeout(() => {
    if (!started) {
      socket.destroy();
      process.exitCode = 1;
    }
  }, 5000);
  socket.on('connect', () =>
    socket.write(
      JSON.stringify({ kind: 'hello', token, pid: process.pid }) + '\n',
    ),
  );
  socket.on('data', (part) => {
    buffer += part;
    if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) {
      socket.destroy();
      return;
    }
    for (let index; (index = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        socket.destroy();
        return;
      }
      if (
        message.kind === 'start' &&
        !started &&
        typeof message.command === 'string'
      ) {
        started = true;
        clearTimeout(startupWatchdog);
        const env = { ...message.env };
        delete env.CIRCLE_COMMAND_CONTROL_TOKEN;
        child = spawn(message.command, {
          shell: process.env.ComSpec || 'cmd.exe',
          stdio: 'inherit',
          env,
        });
        child.once('spawn', () =>
          socket.write(
            JSON.stringify({ kind: 'started', pid: child.pid }) + '\n',
          ),
        );
        child.once('error', () =>
          socket.write(JSON.stringify({ kind: 'failure' }) + '\n'),
        );
        child.once('exit', (code) => {
          exited = true;
          if (code === null) {
            socket.write(JSON.stringify({ kind: 'failure' }) + '\n');
            return;
          }
          socket.write(
            JSON.stringify({ kind: 'root-exit', exitCode: code }) + '\n',
          );
        });
      } else if (message.kind === 'abort-before-start' && !started) {
        socket.end();
      } else if (message.kind === 'stop' && started && !exited) {
        try {
          child.kill('SIGKILL');
        } catch {
          socket.write(JSON.stringify({ kind: 'failure' }) + '\n');
        }
      } else if (message.kind === 'root-exit-ack' && exited)
        acknowledged = true;
      else if (message.kind === 'finish' && exited && acknowledged) {
        socket.end();
      } else {
        socket.write(JSON.stringify({ kind: 'failure' }) + '\n');
      }
    }
  });
  socket.on('error', () => {});
  // On control loss the host-owned kill-on-close Job remains cleanup authority.
  socket.on('close', () => {
    clearTimeout(startupWatchdog);
    process.exitCode = exited && acknowledged ? 0 : 1;
  });
}
