import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { formatMcpArguments, parseMcpArguments } from '../src/mcp-arguments.ts';

test('MCP configuration roundtrips complex inline JavaScript and every argv boundary', () => {
  const args = [
    '-e',
    'const config = {"path":"a b","quote":"\\\""}; console.log(JSON.stringify(config));',
    '',
    'a b',
    '"quoted"',
    "'single'",
    'C:\\tools\\mcp.js',
    'line\nbreak\ttab',
    '中文🚀',
    '\\',
    '$HOME; $(touch x) `id`',
    '\u0000',
  ];
  assert.deepEqual(parseMcpArguments(formatMcpArguments(args)), args);
  let saved = args;
  for (let toggle = 0; toggle < 10; toggle++)
    saved = parseMcpArguments(formatMcpArguments(saved));
  assert.deepEqual(saved, args);
});
test('manual and legacy argv syntax preserves empty words and quoted JSON', () => {
  assert.deepEqual(
    parseMcpArguments('-e \'console.log({"ok":true})\' --path a\\ b ""'),
    ['-e', 'console.log({"ok":true})', '--path', 'a b', ''],
  );
  assert.deepEqual(parseMcpArguments('one "two three" four'), [
    'one',
    'two three',
    'four',
  ]);
  assert.deepEqual(parseMcpArguments('["-e","console.log(\\"hi\\")",""]'), [
    '-e',
    'console.log("hi")',
    '',
  ]);
  assert.deepEqual(parseMcpArguments(''), []);
});
test('malformed quoted configuration is rejected before replacing saved argv', () => {
  for (const input of [
    '"unclosed',
    "'unclosed",
    '"bad\\q"',
    '[1]',
    '["unterminated]',
  ])
    assert.throws(() => parseMcpArguments(input));
});
test('decoded argv reaches a real child process byte-for-byte without shell evaluation', () => {
  const args = [
    'a b',
    '',
    '"quote"',
    "'single'",
    'C:\\tmp\\a.js',
    '\n\t',
    '中文',
    '$HOME; $(echo NOT_EXECUTED)',
  ];
  const decoded = parseMcpArguments(formatMcpArguments(args));
  const child = spawnSync(
    process.execPath,
    [
      '-e',
      'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
      '--',
      ...decoded,
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), args);
});
