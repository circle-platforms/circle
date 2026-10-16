import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
/** Main-process capability, never accepted from workspace RPC parameters. */
export interface GitPushAuthentication {
  repository: string;
  withCredentials(
    run: (env: NodeJS.ProcessEnv, config: string[]) => Promise<string>,
  ): Promise<string>;
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
// No credential is written into this helper. Git's protocol input is checked
// before the owned gh process is allowed to retrieve the in-memory grant.
const helper = `const {spawnSync}=require('node:child_process');
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{input+=chunk;if(input.length>65536)process.exit(1)});
process.stdin.on('end',()=>{if(process.argv[2]!=='get')return;const fields=new Map(input.trimEnd().split('\\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)]}));
if(fields.get('protocol')!=='https'||fields.get('host')!=='github.com'||(fields.get('path')||'').replace(/\\.git$/,'')!==process.env.CIRCLE_GIT_REPOSITORY)process.exit(1);
const result=spawnSync(process.env.CIRCLE_GIT_GH,['auth','git-credential','get'],{input,encoding:'utf8',env:process.env,maxBuffer:65536,windowsHide:true});
if(result.status!==0)process.exit(1);process.stdout.write(result.stdout);});`;
export async function withGitHubPushCredentials(
  options: {
    repository: string;
    token: string;
    ghPath: string;
    nodePath?: string;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    assertActive(): void;
  },
  run: (env: NodeJS.ProcessEnv, config: string[]) => Promise<string>,
): Promise<string> {
  if (!/^[-\w.]+\/[-\w.]+$/.test(options.repository))
    throw Error('select an authorized GitHub repository');
  options.signal?.throwIfAborted();
  options.assertActive();
  const directory = await mkdtemp(path.join(tmpdir(), 'circle-git-auth-'));
  try {
    const file = path.join(directory, 'credential.cjs');
    await writeFile(file, helper, { mode: 0o600 });
    const emptyConfig = path.join(directory, 'empty-git-config');
    await writeFile(emptyConfig, '', { mode: 0o600 });
    options.signal?.throwIfAborted();
    options.assertActive();
    try {
      const cleanEnv: NodeJS.ProcessEnv = { ...options.env };
      for (const key of new Set([
        ...Object.keys(process.env),
        ...Object.keys(cleanEnv),
      ])) {
        if (
          /^(GIT_CONFIG_|GIT_TRACE|GIT_CURL_VERBOSE$|GIT_ASKPASS$|GIT_EXEC_PATH$|GIT_SSL_NO_VERIFY$|SSH_ASKPASS$|NODE_OPTIONS$|GH_DEBUG$|GH_TOKEN$|GITHUB_TOKEN$|GH_ENTERPRISE_TOKEN$|GITHUB_ENTERPRISE_TOKEN$|GH_HOST$|GH_REPO$|GH_CONFIG_DIR$)/i.test(
            key,
          )
        )
          cleanEnv[key] = undefined;
      }
      cleanEnv.GIT_ASKPASS = 'false';
      cleanEnv.SSH_ASKPASS = 'false';
      const result = await run(
        {
          ...cleanEnv,
          GH_TOKEN: options.token,
          GH_HOST: 'github.com',
          GH_CONFIG_DIR: directory,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: emptyConfig,
          CIRCLE_GIT_GH: options.ghPath,
          CIRCLE_GIT_REPOSITORY: options.repository,
          ELECTRON_RUN_AS_NODE: '1',
        },
        [
          '-c',
          'protocol.allow=never',
          '-c',
          'protocol.https.allow=always',
          '-c',
          'credential.helper=',
          '-c',
          `credential.helper=!${quote(options.nodePath ?? process.execPath)} ${quote(file)}`,
          '-c',
          'credential.useHttpPath=true',
          '-c',
          'core.hooksPath=' + directory,
          '-c',
          'http.followRedirects=false',
          '-c',
          'http.sslVerify=true',
        ],
      );
      options.signal?.throwIfAborted();
      options.assertActive();
      return result.split(options.token).join('[redacted]');
    } catch {
      throw Error(
        'GitHub push failed or was cancelled; reconcile the remote branch before retrying',
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
