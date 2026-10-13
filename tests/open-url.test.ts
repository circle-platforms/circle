import { scratch } from './helpers.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkedUrl, openInBrowser, OpenUrlError } from '../src/open_url.js';
import { ExtensionHost } from '../src/extensions.js';

const schema = '{type:"object",properties:{}}';

test('only plain http and https links are opened, as one argument to the platform opener', async () => {
  assert.equal(
    checkedUrl('https://lab.example.test/live?x=1'),
    'https://lab.example.test/live?x=1',
  );
  for (const bad of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://u:p@x.test/',
    'not a url',
    42,
  ])
    assert.throws(() => checkedUrl(bad), OpenUrlError);
  const calls: [string, string[]][] = [];
  const runner = async (command: string, args: string[]) => {
    calls.push([command, args]);
  };
  const url = 'https://x.test/a b;rm -rf ~';
  await openInBrowser(url, runner, 'darwin');
  await openInBrowser(url, runner, 'linux');
  await openInBrowser(url, runner, 'win32');
  const href = new URL(url).href;
  assert.deepEqual(calls, [
    ['open', [href]],
    ['xdg-open', [href]],
    ['rundll32', ['url.dll,FileProtocolHandler', href]],
  ]);
  await assert.rejects(openInBrowser('ftp://x.test', runner), OpenUrlError);
});

test('api.openUrl hands the interface a checked link, and fails where links cannot be opened', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  const path = join(home, 'extensions', 'linker');
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, 'extension.mjs'),
    `export function register(api){api.registerTool('open','open',${schema},async(args)=>{try{await api.openUrl(args.url);return 'opened'}catch(e){return e.message}},{readOnly:true})}`,
  );
  const opened: string[] = [];
  const context = {
    signal: new AbortController().signal,
    sessionId: 't',
  } as never;
  const host = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: false,
    openUrl: async (url) => {
      opened.push(url);
    },
  }).load();
  const tool = host.tools()[0]!;
  assert.equal(
    await tool.run({ url: 'https://lab.example.test/live' }, context),
    'opened',
  );
  assert.match(
    await tool.run({ url: 'file:///etc/hosts' }, context),
    /only http and https/,
  );
  assert.deepEqual(opened, ['https://lab.example.test/live']);
  const none = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: false,
  }).load();
  assert.match(
    await none.tools()[0]!.run({ url: 'https://x.test' }, context),
    /cannot open links/,
  );
});
