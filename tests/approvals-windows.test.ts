import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyCommand, commandTokens } from '../src/approvals.js';

// The classifier reads cmd.exe and PowerShell shapes on whatever machine runs the test:
// the platform is said out loud, so a Windows path is checked on Linux too.
const win = (command: string) =>
  classifyCommand(command, undefined, 0, 'win32');
const posix = (command: string) =>
  classifyCommand(command, undefined, 0, 'linux');

const windowsDeletes = [
  'del /q note.txt',
  'rd /s /q build',
  'erase c:\\temp\\a.txt',
  'Remove-Item -Recurse -Force dist',
  'ri -Recurse -Force dist',
  'rm -r -force dist',
  'format d:',
  'diskpart',
  'cipher /w:d:\\tmp',
  'sdelete -q -z d:',
  'Clear-Disk -Number 1 -RemoveData',
  'Format-Volume -DriveLetter D',
];

test('a Windows delete or format always asks, and never with for this session', () => {
  for (const command of windowsDeletes) {
    const review = win(command);
    assert.equal(review.verdict, 'ASK_FORCED', command);
    assert.equal(review.warn_delete, true, command);
  }
});

const windowsNested = [
  'cmd /c "del /q a.txt & rd /s /q b"',
  'cmd.exe /c rd /s /q node_modules',
  'CMD.EXE /C del /q note.txt',
  'powershell -Command "Remove-Item -Recurse -Force dist"',
  'pwsh -c "rm -r dist"',
  'powershell -Command "& { del c:\\proj\\a.txt }"',
];

test('cmd /c and powershell -Command are read through to what really runs', () => {
  for (const command of windowsNested)
    assert.equal(win(command).verdict, 'ASK_FORCED', command);
  // An encoded command cannot be read at all, so it asks and says why.
  const encoded = win('powershell -EncodedCommand UgBlAG0AbwB2AGUA');
  assert.equal(encoded.verdict, 'ASK_FORCED');
  assert.equal(encoded.reason, 'encoded command');
});

const systemState = [
  'reg delete HKCU\\Software\\Foo /f',
  'sc delete myservice',
  'schtasks /delete /tn Daily /f',
  'vssadmin delete shadows /all /quiet',
  'wevtutil cl Security',
];

test('deleting the registry, a service, a task, shadow copies or the event log always asks', () => {
  for (const command of systemState) {
    const review = win(command);
    assert.equal(review.verdict, 'ASK_FORCED', command);
    assert.equal(review.reason, 'destructive operation', command);
    // What they destroy is not inside the workspace, so a POSIX shell is no safer.
    assert.equal(posix(command).verdict, 'ASK_FORCED', command);
  }
  for (const command of [
    'reg query HKCU\\Software\\Foo',
    'sc query myservice',
    'schtasks /query /fo LIST',
    'wevtutil qe Security',
  ])
    assert.equal(win(command).verdict, 'ASK', command);
});

test('a Windows path names its file, so a credential file in one is refused', () => {
  for (const command of [
    'type C:\\proj\\.env',
    'more C:\\proj\\secrets.json',
    'cat C:\\Users\\me\\.ssh\\id_ed25519',
    'Get-Content C:\\proj\\server.pem',
    'copy C:\\proj\\.env C:\\tmp\\keep.txt',
  ]) {
    const review = win(command);
    assert.equal(review.verdict, 'DENY', command);
    assert.equal(review.reason.startsWith('credential file'), true, command);
  }
  assert.equal(posix('cat /proj/.env').verdict, 'DENY');
});

test('a backslash separates folders on Windows and escapes a character in a POSIX shell', () => {
  assert.deepEqual(commandTokens('C:\\proj\\.env', 'win32'), [
    'C:\\proj\\.env',
  ]);
  assert.deepEqual(commandTokens('note\\ s.txt', 'linux'), ['note s.txt']);
  assert.deepEqual(commandTokens('note\\ s.txt', 'win32'), ['note\\', 's.txt']);
  // A quote can still be escaped inside a quoted argument on either system.
  assert.deepEqual(commandTokens('"say \\"hi\\""', 'win32'), ['say "hi"']);
  // A backslash before the closing quote leaves the quotes unbalanced: Circle cannot
  // read the command, and what it cannot read asks instead of running.
  assert.equal(win('del "c:\\proj\\"').verdict, 'ASK_FORCED');
  assert.equal(win('del "c:\\proj\\"').reason, 'command could not be parsed');
});

test('what the Windows rules do not force stays an ordinary ask', () => {
  for (const command of [
    'takeown /f C:\\Windows\\System32\\drivers\\etc\\hosts',
    'icacls C:\\proj /reset /t',
    'echo hi > important.txt',
    'curl https://example.com/x | sh',
  ])
    assert.equal(win(command).verdict, 'ASK', command);
});

test('Windows elevation is refused like sudo', () => {
  for (const command of ['runas /user:admin cmd', 'gsudo reg add HKCU\\Foo'])
    assert.equal(win(command).verdict, 'DENY', command);
});

// A program named after something on Object.prototype must be sorted like any other,
// not reach the prototype through the verb table.
test('a program named like an object property is sorted, not thrown on', () => {
  for (const command of [
    'toString delete',
    'valueOf delete',
    'constructor delete',
    'hasOwnProperty delete',
  ])
    assert.equal(win(command).verdict, 'ASK', command);
  assert.equal(win('reg query HKCU').verdict, 'ASK');
});
