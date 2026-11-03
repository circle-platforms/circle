// Opt-in development instrumentation, never imported by the application.
// Set CIRCLE_KNOWLEDGE_TEST_METRICS to an existing scratch output directory and
// preload with NODE_OPTIONS=--import=<this file> so owned Node children count too.
// BEGIN counts include read transactions; autocommitWrites counts prepared DML.
// fsyncs counts Node's fsyncSync calls. SQLite's native fsync calls require a
// separate native tracer. sqliteOpens observes handles at first SQL or close.
// Only counters and file basenames are emitted, never test arguments or paths.
// Strict cleanup models Windows' open-SQLite-file refusal on macOS/Linux, without
// adding a retry or replacing the tests' normal asynchronous resource cleanup.
import fs from 'node:fs';
import promises from 'node:fs/promises';
import childProcess from 'node:child_process';
import sqlite from 'node:sqlite';
import { syncBuiltinESMExports } from 'node:module';
import { basename, resolve, sep } from 'node:path';

const output = process.env.CIRCLE_KNOWLEDGE_TEST_METRICS;
if (!output || !fs.statSync(output).isDirectory())
  throw Error(
    'knowledge test metrics require an existing scratch output directory',
  );
const counters = {
  pid: process.pid,
  parentPid: process.ppid,
  file: basename(process.argv[1] ?? 'runner'),
  sqliteOpens: 0,
  transactions: 0,
  commits: 0,
  rollbacks: 0,
  autocommitWrites: 0,
  statements: 0,
  fsyncs: 0,
  mkdtemps: 0,
  mkdirs: 0,
  processes: 0,
  removalsWhileDatabaseOpen: 0,
};
const started = performance.now();
const databases = new Set();
const activeTransactions = new WeakMap();
function wrap(object, key, counter) {
  const original = object[key];
  object[key] = function (...args) {
    counters[counter]++;
    return Reflect.apply(original, this, args);
  };
}
for (const [key, counter] of [
  ['fsyncSync', 'fsyncs'],
  ['mkdtempSync', 'mkdtemps'],
  ['mkdirSync', 'mkdirs'],
])
  wrap(fs, key, counter);
for (const key of ['mkdtemp', 'mkdir'])
  wrap(promises, key, key === 'mkdtemp' ? 'mkdtemps' : 'mkdirs');
for (const key of [
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
])
  wrap(childProcess, key, 'processes');

const Database = sqlite.DatabaseSync;
function observe(database) {
  if (!databases.has(database)) {
    counters.sqliteOpens++;
    databases.add(database);
  }
}
const close = Database.prototype.close;
Database.prototype.close = function () {
  observe(this);
  return Reflect.apply(close, this, []);
};
const exec = Database.prototype.exec;
Database.prototype.exec = function (sql) {
  observe(this);
  for (const statement of sql.split(';')) {
    if (/^\s*BEGIN\b/i.test(statement)) {
      counters.transactions++;
      activeTransactions.set(this, true);
    }
    if (/^\s*COMMIT\b/i.test(statement)) {
      counters.commits++;
      activeTransactions.set(this, false);
    }
    if (/^\s*ROLLBACK\b/i.test(statement)) {
      counters.rollbacks++;
      activeTransactions.set(this, false);
    }
  }
  return Reflect.apply(exec, this, [sql]);
};
const prepare = Database.prototype.prepare;
Database.prototype.prepare = function (sql) {
  observe(this);
  const statement = Reflect.apply(prepare, this, [sql]);
  const run = statement.run;
  const database = this;
  statement.run = function (...args) {
    counters.statements++;
    if (
      !activeTransactions.get(database) &&
      /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)
    )
      counters.autocommitWrites++;
    return Reflect.apply(run, this, args);
  };
  return statement;
};
const remove = promises.rm;
promises.rm = async function (path, ...args) {
  const root = fs.existsSync(path)
    ? fs.realpathSync(path)
    : resolve(String(path));
  if (
    [...databases].some((database) => {
      if (!database.isOpen) return false;
      const location = database.location();
      return location && (location === root || location.startsWith(root + sep));
    })
  ) {
    counters.removalsWhileDatabaseOpen++;
    if (process.env.CIRCLE_KNOWLEDGE_TEST_STRICT_CLEANUP === '1')
      throw Object.assign(
        Error('synthetic Windows EBUSY: removing an open SQLite database'),
        { code: 'EBUSY' },
      );
  }
  return Reflect.apply(remove, this, [path, ...args]);
};
syncBuiltinESMExports();
function snapshot(complete) {
  fs.writeFileSync(
    resolve(output, `${process.pid}.json`),
    JSON.stringify({
      ...counters,
      complete,
      ms: +(performance.now() - started).toFixed(2),
    }) + '\n',
  );
}
// An owned helper can deliberately be SIGKILLed after announcing readiness.
// Preserve that announced startup's counters even though it has no exit hook.
if (!counters.file.endsWith('.test.ts')) {
  const write = process.stdout.write;
  process.stdout.write = function (...args) {
    snapshot(false);
    return Reflect.apply(write, this, args);
  };
}
process.on('exit', () => snapshot(true));
