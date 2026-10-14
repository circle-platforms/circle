import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Server } from 'node:https';
import { createServer as httpServer } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { build } from 'esbuild';
import { cp } from 'node:fs/promises';
import { dirname } from 'node:path';
import { scratch, cleanup } from './helpers.js';
import {
  defaultSettings,
  saveSettings,
  saveCredentials,
  trustFolder,
} from '../src/settings.js';

const openssl = spawnSync('openssl', ['version']).status === 0;
function certificates(t: TestContext, host: string) {
  const root = scratch(t, 'circle-network-ca-');
  const run = (args: string[]) => {
    const out = spawnSync('openssl', args, { cwd: root, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
  };
  run([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '2',
    '-subj',
    `/CN=${host} test CA`,
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
  ]);
  run([
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    `/CN=${host}`,
    '-keyout',
    'key.pem',
    '-out',
    'leaf.csr',
  ]);
  writeFileSync(
    join(root, 'ext.cnf'),
    `subjectAltName=DNS:${host},IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`,
  );
  run([
    'x509',
    '-req',
    '-in',
    'leaf.csr',
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-set_serial',
    '2',
    '-days',
    '2',
    '-out',
    'leaf.pem',
    '-extfile',
    'ext.cnf',
  ]);
  return {
    ca: join(root, 'ca.pem'),
    key: readFileSync(join(root, 'key.pem')),
    cert: readFileSync(join(root, 'leaf.pem')),
  };
}
async function listen(t: TestContext, server: Server) {
  const sockets = new Set<Duplex>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup(t, () => {
    for (const socket of sockets) socket.destroy();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return (server.address() as { port: number }).port;
}
function cleanEnv(home: string): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
    CIRCLE_HOME: home,
    CIRCLE_WORKBENCH_DATA_DIR: join(home, 'data'),
    CIRCLE_NO_UPDATE_CHECK: '1',
    CIRCLE_NO_MODELS_REFRESH: '1',
  };
  for (const key of Object.keys(env))
    if (
      /^(https?_proxy|all_proxy|no_proxy|ssl_cert_(file|dir)|node_extra_ca_certs|node_use_env_proxy|circle_trust_certs)$/i.test(
        key,
      )
    )
      delete env[key as keyof typeof env];
  return env;
}
async function child(args: string[], env: NodeJS.ProcessEnv, stdin = '') {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const process = spawn(globalThis.process.execPath, args, {
        env,
        stdio: 'pipe',
      });
      let stdout = '',
        stderr = '';
      const timer = setTimeout(() => {
        process.kill();
        reject(Error('network fixture timed out'));
      }, 30000);
      process.stdout.on('data', (data) => (stdout += data));
      process.stderr.on('data', (data) => (stderr += data));
      process.on('error', reject);
      process.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      process.stdin.end(stdin);
    },
  );
}

test(
  'shared bootstrap adds two CAs, retains default trust and makes actual child HTTPS requests through CONNECT',
  { skip: !openssl },
  async (t) => {
    const a = certificates(t, 'first.circle.test');
    const b = certificates(t, 'second.circle.test');
    const first = await listen(
      t,
      createServer(a, (_req, res) => res.end('first CA')),
    );
    const second = await listen(
      t,
      createServer(b, (_req, res) => res.end('second CA')),
    );
    const seen: string[] = [];
    const proxy = httpServer((_req, res) => res.writeHead(502).end());
    proxy.on('connect', (req, socket, head) => {
      seen.push(req.url!);
      const tunnel = connect(
        req.url!.startsWith('first.') ? first : second,
        '127.0.0.1',
        () => {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          tunnel.write(head);
          socket.pipe(tunnel);
          tunnel.pipe(socket);
        },
      );
      socket.on('close', () => tunnel.destroy());
      tunnel.on('error', () => socket.destroy());
      socket.on('error', () => tunnel.destroy());
    });
    const port = await listen(t, proxy as unknown as Server);
    const home = scratch(t),
      settings = defaultSettings();
    settings.trust_cert_files = [a.ca, b.ca];
    saveSettings(settings, home);
    const script = `
    import assert from 'node:assert/strict'; import tls from 'node:tls'; import { readFileSync } from 'node:fs'; import { X509Certificate } from 'node:crypto'; import { spawn } from 'node:child_process';
    import { initializeNetwork } from './src/network_bootstrap.ts';
    const before = tls.getCACertificates('default').map(p=>new X509Certificate(p).fingerprint256);
    const status = initializeNetwork(process.env.CIRCLE_HOME);
    const after = tls.getCACertificates('default').map(p=>new X509Certificate(p).fingerprint256);
    assert.ok(before.every(p=>after.includes(p))); assert.equal(status.certificates,2); assert.equal(status.problems.length,0);
    assert.ok(status.sources.some(s=>s.name==='trust_cert_files' && s.certificates===2));
    const run = spawn(process.execPath,['--input-type=module','-e', 'console.log(await (await fetch("https://first.circle.test/page")).text()); console.log(await (await fetch("https://second.circle.test/page")).text());'],{env:process.env,stdio:'inherit'});
    const code = await new Promise(resolve=>run.on('close',resolve)); assert.equal(code,0);
    for (const port of [${first},${second}]) {
      const verify=spawn('openssl',['s_client','-connect','127.0.0.1:'+port,'-verify_return_error','-CAfile',process.env.SSL_CERT_FILE],{env:process.env,stdio:['pipe','ignore','pipe']});
      let diagnostic='';verify.stderr.on('data',bytes=>diagnostic+=bytes);verify.stdin.end();
      const result=await new Promise(resolve=>verify.on('close',resolve));assert.equal(result,0,diagnostic);assert.match(diagnostic,/Verification: OK|verify return:1/);
    }
    console.log(JSON.stringify(status));
  `;
    const out = await child(
      ['--import', 'tsx', '--input-type=module', '-e', script],
      { ...cleanEnv(home), HTTPS_PROXY: `http://127.0.0.1:${port}` },
    );
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /first CA\nsecond CA/);
    assert.deepEqual([...new Set(seen)].sort(), [
      'first.circle.test:443',
      'second.circle.test:443',
    ]);
    const status = JSON.parse(out.stdout.trim().split('\n').at(-1)!);
    assert.ok(status.authorities > 2);
    assert.ok(status.bundle.startsWith(join(home, 'trust')));
  },
);

test(
  'bundled desktop worker initializes settings CA and proxy before its first real model request',
  { skip: !openssl },
  async (t) => {
    const ca = certificates(t, 'worker.circle.test');
    let requests = 0;
    const port = await listen(
      t,
      createServer(ca, async (req, res) => {
        for await (const _ of req) {
          /* drain model request */
        }
        requests++;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(
          'data: ' +
            JSON.stringify({
              choices: [
                {
                  index: 0,
                  delta: { content: 'worker network ready' },
                  finish_reason: 'stop',
                },
              ],
            }) +
            '\n\ndata: [DONE]\n\n',
        );
      }),
    );
    const tunnels: string[] = [];
    const relay = httpServer();
    relay.on('connect', (req, socket, head) => {
      tunnels.push(req.url!);
      const tunnel = connect(port, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        tunnel.write(head);
        socket.pipe(tunnel);
        tunnel.pipe(socket);
      });

      socket.on('close', () => tunnel.destroy());
      tunnel.on('error', () => socket.destroy());
      socket.on('error', () => tunnel.destroy());
    });
    const proxyPort = await listen(t, relay as unknown as Server);
    const home = scratch(t),
      workspace = scratch(t),
      settings = trustFolder(defaultSettings(), workspace);
    settings.initialized = true;
    settings.update_check = false;
    settings.trust_cert_files = [ca.ca];
    settings.auth = {
      ...settings.auth,
      base_url: 'https://worker.circle.test/v1',
      model: 'fixture-model',
    };
    saveSettings(settings, home);
    saveCredentials({ api_key: 'synthetic-key' }, home);
    writeFileSync(
      join(home, 'desktop-session.json'),
      JSON.stringify({ workspace, sessionId: 'missing-fixture-session' }),
    );
    const bundle = join(scratch(t), 'runtime-worker.mjs');
    await build({
      entryPoints: ['apps/desktop/src/runtime-worker.ts'],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
    });
    await cp('src/prompts', join(dirname(bundle), 'prompts'), {
      recursive: true,
    });
    await cp('src/data', join(dirname(bundle), 'data'), { recursive: true });
    const wrapper = `
    const listeners=[]; let prompted=false;
    Object.defineProperty(process,'parentPort',{value:{on(_name,listener){listeners.push(listener)},postMessage(value){
      if(value.type==='update' && !prompted){prompted=true;queueMicrotask(()=>listeners[0]({data:{id:'request',name:'prompt',sessionId:value.update.snapshot.activeSessionId,payload:{text:'hello'}}}));}
      if(value.type==='update' && value.update.snapshot.sessions.some(s=>s.messages.some(m=>m.text==='worker network ready'))){console.log('worker network ready');queueMicrotask(()=>listeners[0]({data:{id:'close',name:'close',payload:{}}}));setTimeout(()=>process.exit(0),100);}
    }}});
    await import(${JSON.stringify(bundle)});
  `;
    const out = await child(['--input-type=module', '-e', wrapper], {
      ...cleanEnv(home),
      CIRCLE_DESKTOP_RUNTIME_HOME: home,
      CIRCLE_WORKBENCH_TEST_PROFILE: '1',
      HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
    });
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /worker network ready/);
    assert.equal(requests, 1);
    assert.ok(tunnels.includes('worker.circle.test:443'));
  },
);

test(
  'real TLS and HTTP search failures reach the next model request and stored history on both fallback hosts',
  { skip: !openssl },
  async (t) => {
    const untrusted = certificates(t, 'lite.duckduckgo.com'),
      trusted = certificates(t, 'html.duckduckgo.com');
    const first = await listen(
      t,
      createServer(untrusted, (_req, res) => res.end('must not trust this CA')),
    );
    const second = await listen(
      t,
      createServer(trusted, (_req, res) =>
        res.writeHead(503).end('unavailable'),
      ),
    );
    const seen: string[] = [];
    const relay = httpServer();
    relay.on('connect', (req, socket, head) => {
      seen.push(req.url!);
      const target = req.url!.startsWith('lite.') ? first : second;
      const tunnel = connect(target, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        tunnel.write(head);
        socket.pipe(tunnel);
        tunnel.pipe(socket);
      });
      socket.on('close', () => tunnel.destroy());
      tunnel.on('error', () => socket.destroy());
      socket.on('error', () => tunnel.destroy());
    });
    const port = await listen(t, relay as unknown as Server);
    const home = scratch(t),
      workspace = scratch(t),
      settings = trustFolder(defaultSettings(), workspace);
    settings.trust_cert_files = [trusted.ca];
    saveSettings(settings, home);
    const script = `
    import assert from 'node:assert/strict';import {initializeNetwork} from './src/network_bootstrap.ts';import {AgentRuntime} from './src/runtime.ts';import {ScriptedModel} from './src/testing.ts';import {loadSettings} from './src/settings.ts';
    initializeNetwork(process.env.CIRCLE_HOME);
    const model=new ScriptedModel([{message:{id:'search',role:'assistant',content:'',tool_calls:[{id:'network-search',name:'websearch',args:{query:'secret-query'}}]}},{message:{id:'done',role:'assistant',content:'network error received'}}]);
    const runtime=new AgentRuntime({home:process.env.CIRCLE_HOME,workspace:process.env.TEST_WORKSPACE,settings:loadSettings(process.env.CIRCLE_HOME),model,headless:true});
    try {
      await runtime.harness.run('search');
      const next=model.requests[1].messages.find(m=>m.tool_call_id==='network-search');
      const saved=runtime.store.messages(runtime.session.id).find(m=>m.tool_call_id==='network-search');
      assert.equal(next.status,'error');assert.equal(saved.content,next.content);assert.match(next.content,/TLS failure on lite.duckduckgo.com/);assert.match(next.content,/HTTP failure on html.duckduckgo.com: HTTP 503/);assert.ok(!next.content.includes('secret-query'));console.log('classified failure present in next model request and saved history');
    } finally {await runtime.close();}
  `;
    const out = await child(
      ['--import', 'tsx', '--input-type=module', '-e', script],
      {
        ...cleanEnv(home),
        TEST_WORKSPACE: workspace,
        HTTPS_PROXY: `http://127.0.0.1:${port}`,
      },
    );
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /classified failure present/);
    assert.deepEqual([...new Set(seen)].sort(), [
      'html.duckduckgo.com:443',
      'lite.duckduckgo.com:443',
    ]);
  },
);

test(
  'the CLI uses settings trust for its first HTTPS model request and records a classified TLS failure without weakening verification',
  { skip: !openssl },
  async (t) => {
    const ca = certificates(t, 'cli.circle.test');
    const port = await listen(
      t,
      createServer(ca, async (req, res) => {
        for await (const _ of req) {
          /* drain */
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(
          'data: ' +
            JSON.stringify({
              choices: [
                {
                  index: 0,
                  delta: { content: 'CLI CA ready' },
                  finish_reason: 'stop',
                },
              ],
            }) +
            '\n\ndata: [DONE]\n\n',
        );
      }),
    );
    const home = scratch(t),
      workspace = scratch(t),
      settings = trustFolder(defaultSettings(), workspace);
    settings.initialized = true;
    settings.update_check = false;
    settings.auth = {
      ...settings.auth,
      base_url: `https://127.0.0.1:${port}/v1`,
      model: 'fixture-model',
    };
    saveSettings(settings, home);
    saveCredentials({ api_key: 'synthetic-key' }, home);
    const refused = await child(
      ['--import', 'tsx', 'src/cli.ts', '-p', 'hello', workspace],
      cleanEnv(home),
    );
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /TLS failure on 127.0.0.1/);
    assert.match(refused.stderr, /trust/);
    settings.trust_cert_files = [ca.ca];
    saveSettings(settings, home);
    const allowed = await child(
      ['--import', 'tsx', 'src/cli.ts', '-p', 'hello', workspace],
      cleanEnv(home),
    );
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.equal(allowed.stdout, 'CLI CA ready\n');
    assert.match(allowed.stderr, /trust_cert_files/);
  },
);

test(
  'bootstrap reports invalid trust and proxy configuration, and an environment CA source is visible',
  { skip: !openssl },
  async (t) => {
    const ca = certificates(t, 'env.circle.test'),
      home = scratch(t);
    const invalid = join(home, 'invalid.pem');
    writeFileSync(invalid, 'not a PEM certificate');
    const settings = defaultSettings();
    settings.trust_cert_files = [invalid, join(home, 'missing.pem')];
    saveSettings(settings, home);
    const out = await child(
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `import {initializeNetwork} from './src/network_bootstrap.ts';console.log(JSON.stringify(initializeNetwork(process.env.CIRCLE_HOME)))`,
      ],
      {
        ...cleanEnv(home),
        CIRCLE_TRUST_CERTS: ca.ca,
        HTTPS_PROXY: 'http://user:proxy-secret@bad\nproxy',
      },
    );
    assert.equal(out.code, 0, out.stderr);
    const state = JSON.parse(out.stdout);
    assert.equal(state.proxy, false);
    assert.equal(state.certificates, 1);
    assert.equal(state.problems.length, 3);
    assert.ok(
      state.sources.some(
        (source: { name: string; certificates: number }) =>
          source.name === 'CIRCLE_TRUST_CERTS' && source.certificates === 1,
      ),
    );
    assert.ok(!out.stdout.includes('proxy-secret'));
  },
);
