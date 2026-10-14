// An independent process observes only a test it identified before restart. Its
// own timers keep working when the test blocks its event loop or stdout pipe.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const native = fileURLToPath(
  new URL('./update-processes.ps1', import.meta.url),
);
const self = fileURLToPath(import.meta.url);
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
};
const json = (path, value) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
export function writeProgress(folder, kind, text) {
  appendFileSync(
    join(folder, 'progress.log'),
    JSON.stringify({
      kind,
      time: Date.now(),
      at: new Date().toISOString(),
      text,
    }) + '\n',
    { mode: 0o600 },
  );
}
function windows(action, value, folder) {
  const plan = join(folder, `process-${randomUUID()}.json`);
  json(plan, value);
  let text;
  try {
    text = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        native,
        action,
        plan,
      ],
      {
        encoding: 'utf8',
        timeout: action === 'dump' ? 55000 : 15000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    const tracePath = plan + '.trace.log';
    let trace =
      'native script did not write a trace (startup or launch may not have reached the script)';
    try {
      trace = readFileSync(tracePath, 'utf8');
    } catch {
      /* preserve the original bounded failure */
    }
    error.message += `\nnative ${action} trace (${tracePath}):\n${trace}`;
    throw error;
  }
  return text.trim() ? JSON.parse(text) : undefined;
}
function posixProcesses() {
  const text = execFileSync('ps', ['-axo', 'pid=,ppid=,lstart=,comm='], {
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, LC_ALL: 'C' },
  });
  return text.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+((?:\S+\s+){4}\S+)\s+(.+?)\s*$/.exec(
      line,
    );
    return match
      ? [
          {
            pid: Number(match[1]),
            parentPid: Number(match[2]),
            createdAt: match[3],
            executable: match[4],
          },
        ]
      : [];
  });
}
export function processIdentity(pid, folder) {
  return process.platform === 'win32'
    ? windows('identity', { pid }, folder)
    : posixProcesses().find((row) => row.pid === pid);
}
export const sameProcess = (actual, expected) =>
  Boolean(
    actual &&
    expected &&
    actual.pid === expected.pid &&
    actual.createdAt === expected.createdAt &&
    (process.platform === 'win32'
      ? actual.executable.toLowerCase() === expected.executable.toLowerCase()
      : actual.executable === expected.executable),
  );
function bornAfter(child, parent) {
  if (/^\d+$/.test(child.createdAt) && /^\d+$/.test(parent.createdAt))
    return BigInt(child.createdAt) >= BigInt(parent.createdAt);
  return Date.parse(child.createdAt) >= Date.parse(parent.createdAt);
}
function processes(folder) {
  return process.platform === 'win32'
    ? windows('list', {}, folder)
    : posixProcesses();
}
export function ownedProcesses(rows, owner, known = [], excluded = []) {
  const selected = new Map();
  const anchors = new Map([owner, ...known].map((row) => [row.pid, row]));
  for (const row of rows)
    if (!excluded.includes(row.pid) && sameProcess(row, anchors.get(row.pid)))
      selected.set(row.pid, row);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (selected.has(row.pid) || excluded.includes(row.pid)) continue;
      const parent = selected.get(row.parentPid) ?? anchors.get(row.parentPid);
      if (!parent) continue;
      const liveParent = rows.find((candidate) => candidate.pid === parent.pid);
      // A remembered parent may have exited; if its PID is alive with another
      // identity it cannot authorize a new descendant.
      if (liveParent && !sameProcess(liveParent, parent)) continue;
      if (!bornAfter(row, parent)) continue;
      selected.set(row.pid, row);
      changed = true;
    }
  }
  return [...selected.values()];
}
function terminateOwned(identity, folder) {
  if (process.platform === 'win32') {
    try {
      return windows('terminate', { owner: identity }, folder);
    } catch (error) {
      return { pid: identity.pid, terminated: false, error: String(error) };
    }
  }
  const current = processIdentity(identity.pid, folder);
  if (!sameProcess(current, identity))
    return { pid: identity.pid, terminated: false };
  try {
    process.kill(identity.pid, 'SIGKILL');
    return { pid: identity.pid, terminated: true };
  } catch {
    return { pid: identity.pid, terminated: false };
  }
}
function latestStage(folder) {
  try {
    return readFileSync(join(folder, 'progress.log'), 'utf8')
      .trim()
      .split('\n')
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      })
      .filter((row) => row.kind === 'stage')
      .at(-1);
  } catch {
    return undefined;
  }
}
function dump(owner, folder) {
  if (process.platform !== 'win32')
    return {
      status: 'unavailable',
      reason:
        'ProcDump is a Windows diagnostic; thread/process evidence was saved instead',
    };
  const requested = process.env.CIRCLE_DESKTOP_PROCDUMP;
  const found = requested
    ? [resolve(requested)]
    : ['procdump64.exe', 'procdump.exe'].flatMap((name) => {
        const result = spawnSync('where.exe', [name], {
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true,
        });
        return result.status === 0 ? result.stdout.trim().split(/\r?\n/) : [];
      });
  const executable = found.find((path) => existsSync(path));
  if (!executable)
    return {
      status: 'unavailable',
      reason: 'ProcDump was not found; no tool was installed automatically',
    };
  if (!sameProcess(processIdentity(owner.pid, folder), owner))
    return {
      status: 'unavailable',
      reason: 'test process identity changed before dump',
    };
  const output = join(folder, `node-${owner.pid}.dmp`);
  try {
    return windows('dump', { owner, procdump: executable, output }, folder);
  } catch (error) {
    return { status: 'unavailable', reason: String(error) };
  }
}
function collect(plan, reason, rows, stage, related = []) {
  const folder = join(plan.folder, 'observer');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const files = [
    'progress.log',
    'application.log',
    'msi-install.log',
    'data/updates/install.log',
    'data/updates/install.log.msi',
    'data/updates/install.json.out',
    'data/updates/install.json.err',
    'data/DevToolsActivePort',
  ];
  const copied = [],
    missing = [];
  for (const name of files) {
    const source = join(plan.folder, name),
      target = join(folder, name.replaceAll('/', '-'));
    try {
      copyFileSync(source, target);
      copied.push(name);
    } catch {
      missing.push(name);
    }
  }
  let threads;
  try {
    if (
      reason !== 'stage stalled' ||
      !sameProcess(processIdentity(plan.owner.pid, folder), plan.owner)
    )
      throw Error('owner identity is not verified; threads were not captured');
    threads =
      process.platform === 'win32'
        ? windows('threads', { owner: plan.owner }, folder)
        : execFileSync('ps', ['-M', '-p', String(plan.owner.pid)], {
            encoding: 'utf8',
            timeout: 5000,
          });
  } catch (error) {
    threads = { unavailable: String(error) };
  }
  json(join(folder, 'threads.json'), threads);
  const evidence = {
    reason,
    at: new Date().toISOString(),
    owner: plan.owner,
    stage,
    processes: rows,
    relatedProcesses: related,
    files: copied,
    missing,
    termination: [],
    complete: reason !== 'stage stalled',
  };
  json(join(folder, 'evidence.json'), evidence);
  let captured;
  try {
    captured =
      reason === 'stage stalled'
        ? dump(plan.owner, folder)
        : { status: 'unavailable', reason: 'owner identity is not verified' };
  } catch (error) {
    captured = { status: 'unavailable', reason: String(error) };
  }
  json(join(folder, 'dump.json'), captured);
  return evidence;
}
export async function observe(config) {
  const plan = readJson(config);
  if (
    !plan?.owner ||
    !plan.folder ||
    !plan.token ||
    !(plan.timeoutMs > 0) ||
    !(plan.pollMs > 0)
  )
    throw Error('invalid observer plan');
  const folder = join(plan.folder, 'observer');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const known = new Map((plan.known ?? []).map((row) => [row.pid, row]));
  for (;;) {
    if (readJson(join(plan.folder, 'observer-stop.json'))?.token === plan.token)
      return;
    let current;
    try {
      current = processIdentity(plan.owner.pid, folder);
    } catch (error) {
      json(join(folder, 'identity-query-error.json'), { error: String(error) });
      collect(plan, 'owner identity unavailable', [], latestStage(plan.folder));
      return;
    }
    if (!sameProcess(current, plan.owner)) {
      collect(
        plan,
        current ? 'owner identity changed' : 'owner exited',
        [],
        latestStage(plan.folder),
      );
      return;
    }
    if (!existsSync(join(folder, 'ready.json')))
      json(join(folder, 'ready.json'), { token: plan.token, pid: process.pid });
    let rows,
      all = [];
    try {
      all = processes(folder);
      rows = ownedProcesses(
        all,
        plan.owner,
        [...known.values()],
        [process.pid],
      );
    } catch (error) {
      json(join(folder, 'process-query-error.json'), { error: String(error) });
      rows = [current];
    }
    // The observer and the commands it starts are never members of the test.
    rows = rows.filter((row) => row.parentPid !== process.pid);
    for (const row of rows) known.set(row.pid, row);
    if (readJson(join(plan.folder, 'observer-stop.json'))?.token === plan.token)
      return;
    const stage = latestStage(plan.folder);
    if (
      Date.now() - (stage?.time ?? plan.startedAt ?? Date.now()) >=
      plan.timeoutMs
    ) {
      // Detached installer processes may have lost their transient parent. A
      // private scratch path ties their diagnostic identity to this run, but
      // that alone never authorizes termination.
      const marker = plan.folder.replaceAll('\\', '/').toLowerCase();
      const related = all.filter(
        (row) =>
          row.pid !== process.pid &&
          row.parentPid !== process.pid &&
          !rows.some((owned) => owned.pid === row.pid) &&
          bornAfter(row, plan.owner) &&
          String(row.command ?? '')
            .replaceAll('\\', '/')
            .toLowerCase()
            .includes(marker),
      );
      const evidence = collect(plan, 'stage stalled', rows, stage, related);
      const newerStage = latestStage(plan.folder);
      const stopped =
        readJson(join(plan.folder, 'observer-stop.json'))?.token === plan.token;
      if (
        stopped ||
        newerStage?.time !== stage?.time ||
        newerStage?.text !== stage?.text
      ) {
        evidence.reason = stopped
          ? 'observer stopped during capture'
          : 'stage recovered during capture';
        evidence.complete = true;
        json(join(folder, 'evidence.json'), evidence);
        return;
      }
      for (const row of rows
        .filter((row) => row.pid !== plan.owner.pid)
        .reverse())
        evidence.termination.push(terminateOwned(row, folder));
      evidence.termination.push(terminateOwned(plan.owner, folder));
      evidence.complete = true;
      json(join(folder, 'evidence.json'), evidence);
      return;
    }
    await delay(plan.pollMs);
  }
}
export async function startUpdateObserver(
  folder,
  { timeoutMs = 180000, pollMs = 1000 } = {},
) {
  const owner = processIdentity(process.pid, folder);
  if (!owner)
    throw Error('could not identify the update test Node before restart');
  const token = randomUUID(),
    config = join(folder, 'observer-plan.json');
  const known = ownedProcesses(processes(folder), owner);
  json(config, {
    folder,
    owner,
    known,
    token,
    timeoutMs,
    pollMs,
    startedAt: Date.now(),
  });
  const output = openSync(join(folder, 'observer.log'), 'a', 0o600);
  const child = spawn(process.execPath, [self, '--observe', config], {
    detached: true,
    stdio: ['ignore', output, output],
    windowsHide: true,
  });
  closeSync(output);
  const exited = new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  child.unref();
  const end = Date.now() + 10000;
  while (readJson(join(folder, 'observer', 'ready.json'))?.token !== token) {
    if (
      child.exitCode !== null ||
      child.signalCode !== null ||
      Date.now() > end
    )
      throw Error(
        `update observer did not start; see ${join(folder, 'observer.log')}`,
      );
    await delay(25);
  }
  return {
    async stop() {
      json(join(folder, 'observer-stop.json'), { token });
      child.ref();
      await Promise.race([exited, delay(20000, undefined, { ref: false })]);
      child.unref();
    },
  };
}
if (process.argv[2] === '--observe' && process.argv[3])
  await observe(process.argv[3]);
