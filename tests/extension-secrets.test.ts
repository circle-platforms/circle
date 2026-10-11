import { scratch, cleanup } from './helpers.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  ExtensionSecrets,
  ExtensionSecretError,
  SecretMask,
  extensionSecretsDir,
} from '../src/extension_secrets.js';
import { ExtensionHost } from '../src/extensions.js';
import {
  cancelRequest,
  createExtensionRequest,
  listPending,
  requestsDir,
  secretDestination,
  submitAnswer,
  type SecretRequest,
} from '../src/secret_prompt.js';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings, trustFolder } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import type { Message, ToolContext } from '../src/types.js';
import { Sandbox } from '../src/sandbox.js';
import { DEFAULT_CREDENTIAL_FILES } from '../src/approvals.js';

const schema = '{type:"object",properties:{}}';
const VALUE = 'tok-SECRET-4f9a2c';
function extension(root: string, name: string, source: string): void {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'extension.mjs'), source);
}
const assistant = (
  text: string,
  calls: Message['tool_calls'] = [],
): Message => ({
  id: crypto.randomUUID(),
  role: 'assistant',
  content: text,
  tool_calls: calls,
});
function leftoverRequests(home: string): string[] {
  const directory = requestsDir(home);
  return existsSync(directory)
    ? readdirSync(directory).filter((name) => !name.startsWith('.'))
    : [];
}
const toolContext = (): ToolContext =>
  ({
    signal: new AbortController().signal,
    sessionId: 'test',
    emitAttachments: () => {},
  }) as unknown as ToolContext;

test('an extension keeps secrets in a private file of its own, apart from settings and credentials', async (t) => {
  const home = scratch(t);
  const alpha = new ExtensionSecrets(home, 'alpha');
  const beta = new ExtensionSecrets(home, 'beta');
  await alpha.set('token', VALUE);
  await alpha.set('server.url', 'https://lab.example.test');
  assert.equal(await alpha.get('token'), VALUE);
  assert.deepEqual(await alpha.names(), ['server.url', 'token']);
  assert.equal(await beta.get('token'), undefined);
  assert.deepEqual(await beta.names(), []);
  const file = join(extensionSecretsDir(home), 'alpha.secrets.json');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).token, VALUE);
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(extensionSecretsDir(home)).mode & 0o777, 0o700);
  }
  // The file is a credential file by name: the model's file tools and commands refuse it.
  const sandbox = new Sandbox(
    home,
    join(home, 'data'),
    DEFAULT_CREDENTIAL_FILES,
  );
  assert.throws(() => sandbox.checkCredentialPath(file), /credential file/);
  assert.ok(!existsSync(join(home, 'settings.json')));
  assert.ok(!existsSync(join(home, 'credentials.json')));
  assert.equal(await alpha.delete('token'), true);
  assert.equal(await alpha.delete('token'), false);
  assert.equal(await alpha.get('token'), undefined);
  await assert.rejects(alpha.set('../escape', VALUE), ExtensionSecretError);
  await assert.rejects(alpha.set('token', ''), ExtensionSecretError);
  await assert.rejects(alpha.set('token', 'a\0b'), ExtensionSecretError);
  await assert.rejects(
    alpha.set('token', 'x'.repeat(4097)),
    ExtensionSecretError,
  );
});

test('the mask replaces remembered values in text and in JSON, escaped or not, and leaves short ones', () => {
  const mask = new SecretMask();
  mask.remember('abc');
  assert.equal(mask.text('abc'), 'abc');
  mask.remember(VALUE);
  mask.remember('quote"and\\slash');
  assert.equal(mask.text(`token ${VALUE} end`), 'token *** end');
  assert.deepEqual(
    mask.value({ token: VALUE, other: 'quote"and\\slash', keep: 1 }),
    { token: '***', other: '***', keep: 1 },
  );
  assert.equal(mask.value(null), null);
});

test('askSecret shows a masked card, hands the value only to the extension, and keeps it out of the model and the session', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  extension(
    join(home, 'extensions'),
    'sample',
    `export function register(api){
      api.registerTool('sign_in','sign in',${schema},async()=>{
        const value = await api.askSecret('Token for the lab server');
        if (value === null) return 'cancelled';
        await api.secrets.set('token', value);
        return { signed_in: true, echo: 'got ' + value };
      },{readOnly:true});
      api.registerCommand('whoami','show the token',async(args,ctx)=>{
        ctx.toast('token is ' + await api.secrets.get('token'));
      });
    }`,
  );
  const presented: SecretRequest[] = [];
  const model = new ScriptedModel([
    { message: assistant('', [{ id: 'one', name: 'sign_in', args: {} }]) },
    { message: assistant('done') },
  ]);
  const runtime = new AgentRuntime({
    home,
    workspace,
    settings: trustFolder(defaultSettings(), workspace),
    model,
    secret: async (request) => {
      presented.push(request);
      assert.deepEqual(
        listPending(home).map((item) => item.id),
        [request.id],
      );
      await submitAnswer(home, request.id, VALUE);
    },
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('sign in to the lab');
  assert.equal(presented.length, 1);
  assert.equal(presented[0]!.extension, 'sample');
  assert.equal(presented[0]!.key, '');
  assert.equal(presented[0]!.target_file, '');
  assert.equal(secretDestination(presented[0]!), '→ extension sample');
  const result = runtime.harness.messages.find(
    (message) => message.role === 'tool',
  )!;
  assert.match(result.content, /"signed_in":true/);
  assert.match(result.content, /got \*\*\*/);
  // What the model was sent next, and everything the session keeps.
  assert.ok(!JSON.stringify(model.requests).includes(VALUE));
  assert.ok(!JSON.stringify(runtime.harness.messages).includes(VALUE));
  assert.equal(await new ExtensionSecrets(home, 'sample').get('token'), VALUE);
  assert.deepEqual(leftoverRequests(home), []);
  const toasts: string[] = [];
  await runtime.extensions
    .commands()
    .get('whoami')!
    .handler('', {
      workspace,
      toast: (message) => toasts.push(message),
      append: () => {},
      sendUserMessage: () => {},
    });
  assert.deepEqual(toasts, ['token is ***']);
});

test('askSecret returns null on cancel, fails without a card or after an abort, and leaves no request behind', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  extension(
    join(home, 'extensions'),
    'asker',
    `export function register(api){
      api.registerTool('ask','ask',${schema},async(args,context)=>{
        try { return { value: await api.askSecret('Key please', { signal: context.signal }) } }
        catch (error) { return { error: error.name + ': ' + error.message } }
      },{readOnly:true});
    }`,
  );
  const cancelling = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    secret: async (request) => cancelRequest(home, request.id),
  }).load();
  const ask = cancelling.tools().find((tool) => tool.name === 'ask')!;
  assert.equal(await ask.run({}, toolContext()), '{"value":null}');
  assert.deepEqual(leftoverRequests(home), []);

  const cardless = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
  }).load();
  assert.match(
    await cardless.tools()[0]!.run({}, toolContext()),
    /cannot ask for a secret/,
  );

  const controller = new AbortController();
  const waiting = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    secret: (request, signal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
        controller.abort();
      }),
  }).load();
  const aborted = await waiting.tools()[0]!.run({}, {
    ...toolContext(),
    signal: controller.signal,
  } as ToolContext);
  assert.match(aborted, /AbortError/);
  assert.deepEqual(leftoverRequests(home), []);
});

test('a watch returned by an extension tool has its results masked when they arrive', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  await new ExtensionSecrets(home, 'watcher').set('token', VALUE);
  extension(
    join(home, 'extensions'),
    'watcher',
    `export function register(api){
      api.registerTool('wait','wait',${schema},async()=>{
        const token = await api.secrets.get('token');
        return new api.Watch('wait', () => ({ done: true, token }), { interval_s: 0.01 });
      },{readOnly:true});
    }`,
  );
  const host = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
  }).load();
  const output = await host.tools()[0]!.run({}, toolContext());
  assert.equal(output, '{"done":true,"token":"***"}');
});

test('pending secret requests from an extension are listed, and a malformed one is not', (t) => {
  const home = scratch(t);
  const request = createExtensionRequest(home, {
    question: 'Token',
    extension: 'sample',
  });
  assert.deepEqual(
    listPending(home).map((item) => [item.id, item.extension]),
    [[request.id, 'sample']],
  );
  writeFileSync(
    join(requestsDir(home), request.id + '.request.json'),
    JSON.stringify({ ...request, key: 'TOKEN' }),
  );
  assert.deepEqual(listPending(home), []);
  assert.throws(() =>
    createExtensionRequest(home, { question: 'x', extension: '../evil' }),
  );
});
