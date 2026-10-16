import { scratch, cleanup } from './helpers.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ExtensionHost, bundledExtensionsRoot } from '../src/extensions.js';
import { HUB_ZH, hubLocaleChinese, hubText } from '../src/hub_text.js';

const savedLocale = {
  LANGUAGE: process.env.LANGUAGE,
  LC_ALL: process.env.LC_ALL,
  LC_MESSAGES: process.env.LC_MESSAGES,
  LANG: process.env.LANG,
};

function restoreLocale(): void {
  for (const [key, value] of Object.entries(savedLocale)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function decodeLiteral(quote: string, body: string): string {
  return body.replace(
    /\\(u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(.))/g,
    (_all, _kind, braced: string, u4: string, hex: string, char: string) => {
      if (braced) return String.fromCodePoint(Number.parseInt(braced, 16));
      if (u4) return String.fromCharCode(Number.parseInt(u4, 16));
      if (hex) return String.fromCharCode(Number.parseInt(hex, 16));
      if (char === 'n') return '\n';
      if (char === 'r') return '\r';
      if (char === 't') return '\t';
      return char ?? '';
    },
  );
}

function hubLiterals(source: string): string[] {
  const found: string[] = [];
  const re = /hubText\(\s*(['"])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  for (const match of source.matchAll(re))
    found.push(decodeLiteral(match[1]!, match[2]!));
  return found;
}

const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();

test('hub interface words follow a Chinese process language', async (t) => {
  t.after(restoreLocale);
  for (const [english, chinese] of Object.entries(HUB_ZH))
    assert.deepEqual(placeholders(chinese), placeholders(english), english);
  for (const file of [
    'src/extensions/hub/extension.ts',
    'src/tui/slash_handlers.ts',
  ]) {
    for (const literal of hubLiterals(readFileSync(file, 'utf8')))
      assert.equal(
        Object.hasOwn(HUB_ZH, literal),
        true,
        `${file} has no Chinese for ${JSON.stringify(literal)}`,
      );
  }

  process.env.LANGUAGE = 'en_US.UTF-8';
  process.env.LC_ALL = 'zh_CN.UTF-8';
  assert.equal(hubLocaleChinese(), false);
  assert.equal(hubText('hub · signed out'), 'hub · signed out');

  delete process.env.LANGUAGE;
  process.env.LC_ALL = 'C';
  process.env.LC_MESSAGES = 'POSIX';
  process.env.LANG = 'zh_CN.UTF-8';
  assert.equal(hubLocaleChinese(), true);
  assert.equal(
    hubText('/{name} failed: {message}', { name: 'hub', message: '未登录' }),
    '/hub 失败：未登录',
  );
  assert.equal(
    hubText('reconcile {task}\n  {detail}', {
      task: 'task_one',
      detail: 'No independently observed receipt',
    }),
    '核对 task_one\n  No independently observed receipt',
  );

  process.env.LANGUAGE = 'zh_CN.UTF-8';
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const send = (status: number, value: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (url.pathname === '/v1/auth/dev-login') {
        assert.equal(request.headers['accept-language'], 'zh');
        return send(200, {
          data: { token: 'tok-zh', tokenType: 'Bearer', scopes: ['scp_lab'] },
        });
      }
      if (url.pathname === '/v1/packs')
        return send(403, {
          status: 'failed',
          error: {
            code: 'FORBIDDEN_ACTION',
            message: 'English refusal',
            messageZh: '中文拒绝',
          },
        });
      if (url.pathname === '/v1/status')
        return send(200, { data: { apiVersion: '1.0.0' } });
      if (url.pathname === '/v1/tools') return send(200, { data: [] });
      if (url.pathname === '/v1/tasks/task_one/reconcile') {
        const asked = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        return send(asked.operationId ? 202 : 200, {
          data: asked.operationId
            ? { status: 'accepted' }
            : {
                reconciliation:
                  'No independently observed receipt is available for an unknown execution',
              },
        });
      }
      send(404, { status: 'failed', error: { code: 'TARGET_NOT_FOUND' } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup(
    t,
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const port = (server.address() as AddressInfo).port;
  const host = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: bundledExtensionsRoot(),
    settings: { hub: { enabled: true } },
  }).load();
  cleanup(t, () => host.close());
  const lines: string[] = [];
  const context = {
    workspace,
    toast: (text: string) => lines.push(text),
    append: (text: string) => lines.push(text),
    sendUserMessage: () => {},
    secret: 'pw-zh',
  };
  const command = host.commands().get('hub')!;
  await command.handler('help', context);
  const help = lines.at(-1)!;
  assert.match(help, /未登录/);
  assert.match(help, /当前登录位置/);
  assert.match(help, /\/hub login/);
  assert.equal(help.includes('not signed in'), false);
  assert.equal(help.includes('where you are signed in'), false);
  await assert.rejects(
    async () => command.handler('nope', context),
    /未知：\/hub nope/,
  );

  await command.handler(`login http://127.0.0.1:${port} tester`, context);
  assert.ok(
    lines.some((line) => /已登录/.test(line) && /范围 scp_lab/.test(line)),
    lines.join('\n'),
  );
  await command.handler('reconcile task_one', context);
  assert.match(
    lines.at(-1)!,
    /^核对 task_one\n {2}No independently observed receipt/,
  );
  await command.handler('reconcile task_one op_9', context);
  assert.match(lines.at(-1)!, /^✓ 核对 task_one · accepted/);
  await assert.rejects(
    async () => command.handler('packs', context),
    (error: Error) => {
      assert.match(error.message, /中文拒绝/);
      assert.equal(error.message.includes('English refusal'), false);
      return true;
    },
  );
});
