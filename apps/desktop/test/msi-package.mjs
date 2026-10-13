// Inspect the compiled Windows Installer database without installing or registering it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log('compiled MSI inspection runs on Windows');
  process.exit(0);
}
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifest = JSON.parse(
  await readFile(join(root, '../../package.json'), 'utf8'),
);
const version = process.env.CIRCLE_DESKTOP_VERSION ?? manifest.version;
const msi =
  process.env.CIRCLE_DESKTOP_MSI ??
  join(
    process.env.CIRCLE_DESKTOP_OUTPUT_DIR ?? join(root, 'out'),
    `circle-desktop-${version}-windows-x64.msi`,
  );
const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$installer = New-Object -ComObject WindowsInstaller.Installer
$database = $installer.OpenDatabase($env:CIRCLE_DESKTOP_MSI, 0)
function Read-Table([string] $table) {
  $view = $database.OpenView('SELECT * FROM ' + $table)
  [void]$view.Execute()
  $columns = $view.ColumnInfo(0)
  $count = $columns.GetType().InvokeMember('FieldCount', 'GetProperty', $null, $columns, $null)
  $rows = @()
  while ($null -ne ($row = $view.Fetch())) {
    $fields = [ordered]@{}
    for ($i = 1; $i -le $count; $i++) {
      $name = $columns.GetType().InvokeMember('StringData', 'GetProperty', $null, $columns, @($i))
      $fields[$name] = $row.GetType().InvokeMember('StringData', 'GetProperty', $null, $row, @($i))
    }
    $rows += $fields
  }
  [void]$view.Close()
  return $rows
}
$tables = [ordered]@{}
foreach ($table in @('Property', 'Dialog', 'Control', 'CheckBox', 'ControlEvent', 'CustomAction', 'InstallExecuteSequence', 'File', 'Directory')) {
  $tables[$table] = @(Read-Table $table)
}
$tables | ConvertTo-Json -Depth 5 -Compress
`;
const result = spawnSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ],
  {
    encoding: 'utf8',
    env: { ...process.env, CIRCLE_DESKTOP_MSI: resolve(msi) },
    timeout: 30000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  },
);
assert.equal(result.status, 0, result.stderr || result.error?.message);
const tables = JSON.parse(result.stdout.trim());
const output = join(root, 'artifacts/msi');
await mkdir(output, { recursive: true });
await writeFile(
  join(output, 'compiled-tables.json'),
  JSON.stringify(tables, null, 2),
);
const properties = Object.fromEntries(
  tables.Property.map((row) => [row.Property, row.Value]),
);
assert.equal(properties.ProductName, 'Circle');
assert.equal(properties.ProductVersion, version);
assert.equal(properties.ARPNOMODIFY, '1');
assert.equal(properties.ARPNOREPAIR, '1');
assert.equal(properties.WIXUI_EXITDIALOGOPTIONALCHECKBOXTEXT, 'launch Circle');
assert.equal(properties.WIXUI_EXITDIALOGOPTIONALCHECKBOX, undefined);
assert.ok(tables.Dialog.some((row) => row.Dialog === 'ExitDialog'));
const checkbox = tables.Control.find(
  (row) => row.Dialog_ === 'ExitDialog' && row.Control === 'OptionalCheckBox',
);
assert.equal(checkbox.Type, 'CheckBox');
assert.equal(checkbox.Property, 'WIXUI_EXITDIALOGOPTIONALCHECKBOX');
assert.equal(
  tables.CheckBox.find((row) => row.Property === checkbox.Property).Value,
  '1',
);
const license = tables.Control.find(
  (row) => row.Dialog_ === 'WelcomeEulaDlg' && row.Control === 'LicenseText',
);
assert.ok(
  license.Text.includes('Apache License') &&
    license.Text.includes('qingshanfeihu') &&
    license.Text.includes('WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND'),
);
const finish = tables.ControlEvent.filter(
  (row) => row.Dialog_ === 'ExitDialog' && row.Control_ === 'Finish',
);
const launch = finish.filter(
  (row) => row.Event === 'DoAction' && row.Argument === 'LaunchCircle',
);
assert.equal(launch.length, 1, 'the completion button launches at most once');
assert.equal(
  launch[0].Condition,
  'NOT Installed AND WIXUI_EXITDIALOGOPTIONALCHECKBOX=1',
);
const close = finish.find((row) => row.Event === 'EndDialog');
assert.ok(Number(launch[0].Ordering) < Number(close.Ordering));
const action = tables.CustomAction.find((row) => row.Action === 'LaunchCircle');
assert.equal(action.Source, 'INSTALLFOLDER');
assert.equal(action.Target, '"[INSTALLFOLDER]Circle.exe"');
assert.equal(
  Number(action.Type),
  34 | 64 | 128,
  'immediate user action, asynchronous without waiting',
);
assert.ok(
  !tables.InstallExecuteSequence.some((row) => row.Action === 'LaunchCircle'),
  'quiet installation and update cannot launch',
);
assert.ok(
  tables.File.some((row) => row.FileName.split('|').at(-1) === 'Circle.exe'),
);
console.log(JSON.stringify({ msi, checks: 19, registered: false }));
