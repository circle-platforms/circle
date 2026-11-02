// node-pty 1.1.0 leaves three descriptors behind on macOS each time it starts a terminal: the
// /dev/ptmx it opens only to keep descriptors 0-2 taken, the terminal's slave end, and the
// kqueue its exit watcher waits on (microsoft/node-pty#882, #931; fixed upstream after 1.1.0,
// so far only in 1.2 prereleases). On macOS this applies those fixes to 1.1.0's source and
// builds it for both architectures in place of the prebuilt binaries the package ships, so the
// application, its package and its tests all load the fixed library. Windows and Linux keep
// node-pty as installed: the leaks are in its macOS code, and Windows is held to 1.1.0's
// lifecycle (src/workspace/pty-exit-cleanup.mjs).
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const NODE_PTY_VERSION = '1.1.0';
const SOURCE = 'src/unix/pty.cc';
export const PRISTINE_SHA256 =
  '5e1005d6bdcfbe97b486ee415419fe7adae99035047f07340fbad36419e0bae6';
export const PATCHED_SHA256 =
  'd22d74ce3a192bd911b52ae44ca09148d533a325edc93249d62b770c0a7405bc';
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// After the exit watcher has its answer, its kqueue is closed (upstream #931).
const KQUEUE_BEFORE = `          HANDLE_EINTR(waitpid(pid, &stat_loc, 0));
        }
      }
    }
#else`;
const KQUEUE_AFTER = `          HANDLE_EINTR(waitpid(pid, &stat_loc, 0));
        }
      }
    }
    // Circle: the watcher's kqueue is closed (node-pty#931).
    close(kq);
#else`;

// The spawn closes what it opened on every path (upstream #882): the slave end, which the
// child has its own copy of, the master when the spawn fails, and each low descriptor, which
// 1.1.0 left open whenever there was only one. The loop never reads past the three it holds.
const SPAWN_START = `static void
pty_posix_spawn(char** argv, char** env,
                const struct termios *termp,
                const struct winsize *winp,
                int* master,
                pid_t* pid,
                int* err) {
  int low_fds[3];`;
const SPAWN_END = `  for (; count > 0; count--) {
    close(low_fds[count]);
  }
}`;
const SPAWN = `static void
pty_posix_spawn(char** argv, char** env,
                const struct termios *termp,
                const struct winsize *winp,
                int* master,
                pid_t* pid,
                int* err) {
  // Circle: every descriptor opened here is closed on every path (node-pty#882).
  // Keep descriptors 0-2 taken while the pty is opened, so neither end lands there.
  int low_fds[3];
  size_t opened = 0;
  while (opened < 3) {
    int fd = posix_openpt(O_RDWR);
    if (fd == -1) break;
    low_fds[opened++] = fd;
    if (fd >= STDERR_FILENO) break;
  }

  int flags = POSIX_SPAWN_CLOEXEC_DEFAULT |
              POSIX_SPAWN_SETSIGDEF |
              POSIX_SPAWN_SETSIGMASK |
              POSIX_SPAWN_SETSID;
  int slave = -1;
  char slave_pty_name[128];
  sigset_t signal_set;
  posix_spawn_file_actions_t acts;
  posix_spawnattr_t attrs;
  posix_spawn_file_actions_init(&acts);
  posix_spawnattr_init(&attrs);
  *err = 0;

  *master = posix_openpt(O_RDWR);
  if (*master == -1) {
    *err = errno ? errno : EIO;
    goto done;
  }
  if (grantpt(*master) == -1 || unlockpt(*master) == -1) {
    *err = errno ? errno : EIO;
    goto done;
  }
  // Use TIOCPTYGNAME instead of ptsname() to avoid threading problems.
  if (ioctl(*master, TIOCPTYGNAME, slave_pty_name) == -1) {
    *err = errno ? errno : EIO;
    goto done;
  }
  slave = open(slave_pty_name, O_RDWR | O_NOCTTY);
  if (slave == -1) {
    *err = errno ? errno : EIO;
    goto done;
  }
  if (termp && tcsetattr(slave, TCSANOW, termp) == -1) {
    *err = errno ? errno : EIO;
    goto done;
  }
  if (winp && ioctl(slave, TIOCSWINSZ, winp) == -1) {
    *err = errno ? errno : EIO;
    goto done;
  }

  posix_spawn_file_actions_adddup2(&acts, slave, STDIN_FILENO);
  posix_spawn_file_actions_adddup2(&acts, slave, STDOUT_FILENO);
  posix_spawn_file_actions_adddup2(&acts, slave, STDERR_FILENO);
  posix_spawn_file_actions_addclose(&acts, slave);
  posix_spawn_file_actions_addclose(&acts, *master);

  *err = posix_spawnattr_setflags(&attrs, flags);
  if (*err != 0) {
    goto done;
  }

  /* Reset all signal the child to their default behavior */
  sigfillset(&signal_set);
  *err = posix_spawnattr_setsigdefault(&attrs, &signal_set);
  if (*err != 0) {
    goto done;
  }

  /* Reset the signal mask for all signals */
  sigemptyset(&signal_set);
  *err = posix_spawnattr_setsigmask(&attrs, &signal_set);
  if (*err != 0) {
    goto done;
  }

  do
    *err = posix_spawn(pid, argv[0], &acts, &attrs, argv, env);
  while (*err == EINTR);
done:
  posix_spawn_file_actions_destroy(&acts);
  posix_spawnattr_destroy(&attrs);
  if (slave != -1) {
    close(slave);
  }
  if (*err != 0 && *master != -1) {
    close(*master);
    *master = -1;
  }
  while (opened > 0) {
    close(low_fds[--opened]);
  }
}`;

function replaceOnce(text, before, after, what) {
  const at = text.indexOf(before);
  if (at === -1 || text.indexOf(before, at + 1) !== -1)
    throw Error(`node-pty ${NODE_PTY_VERSION} source: ${what} not found once`);
  return text.slice(0, at) + after + text.slice(at + before.length);
}

/** node-pty 1.1.0's unix source with the macOS descriptor fixes; the same when already fixed. */
export function patchNodePtySource(text) {
  const hash = sha256(text);
  if (hash === PATCHED_SHA256) return text;
  if (hash !== PRISTINE_SHA256)
    throw Error(
      `unexpected node-pty ${SOURCE} (${hash}): update scripts/node-pty-macos.mjs`,
    );
  let patched = replaceOnce(text, KQUEUE_BEFORE, KQUEUE_AFTER, 'exit watcher');
  const start = patched.indexOf(SPAWN_START);
  const end = patched.indexOf(SPAWN_END, start);
  if (
    start === -1 ||
    end === -1 ||
    patched.indexOf(SPAWN_START, start + 1) !== -1
  )
    throw Error(`node-pty ${NODE_PTY_VERSION} source: spawn not found once`);
  patched =
    patched.slice(0, start) + SPAWN + patched.slice(end + SPAWN_END.length);
  if (sha256(patched) !== PATCHED_SHA256)
    throw Error('patched node-pty source differs from the reviewed fix');
  return patched;
}

/** node-gyp: npm's own, which it names to install scripts, or the one beside this Node. */
function nodeGyp() {
  const candidates = [
    process.env.npm_config_node_gyp,
    join(
      dirname(process.execPath),
      '..',
      'lib',
      'node_modules',
      'npm',
      'node_modules',
      'node-gyp',
      'bin',
      'node-gyp.js',
    ),
  ].filter(Boolean);
  const found = candidates.find((path) => existsSync(path));
  if (!found)
    throw Error(
      'node-gyp is needed to build node-pty on macOS; install npm with Node.js',
    );
  return found;
}

/**
 * On macOS: fixes node-pty's source and builds pty.node and spawn-helper for arm64 and x64
 * into prebuilds/darwin-*, the directories node-pty loads them from. A build already made from
 * the fixed source is kept. Elsewhere nothing changes.
 */
export async function repairNodePtyOnMacos(
  root,
  {
    platform = process.platform,
    archs = ['arm64', 'x64'],
    run = execFileSync,
    gyp = nodeGyp,
  } = {},
) {
  if (platform !== 'darwin') return false;
  const require = createRequire(join(root, 'package.json'));
  const packageRoot = dirname(require.resolve('node-pty/package.json'));
  const { version } = JSON.parse(
    await readFile(join(packageRoot, 'package.json'), 'utf8'),
  );
  if (version !== NODE_PTY_VERSION)
    throw Error(
      `node-pty ${version} is installed; scripts/node-pty-macos.mjs fixes ${NODE_PTY_VERSION}: drop it if ${version} has the fixes`,
    );
  const sourcePath = join(packageRoot, SOURCE);
  const source = await readFile(sourcePath, 'utf8');
  const patched = patchNodePtySource(source);
  if (patched !== source) await writeFile(sourcePath, patched);
  const receipt = { version, source: PATCHED_SHA256 };
  for (const arch of archs) {
    const target = join(packageRoot, 'prebuilds', `darwin-${arch}`);
    const marker = join(target, 'circle-build.json');
    const built = await readFile(marker, 'utf8').then(
      JSON.parse,
      () => undefined,
    );
    if (
      built?.source === receipt.source &&
      built.arch === arch &&
      existsSync(join(target, 'pty.node')) &&
      existsSync(join(target, 'spawn-helper'))
    )
      continue;
    run(process.execPath, [gyp(), 'rebuild', `--arch=${arch}`], {
      cwd: packageRoot,
      stdio: 'inherit',
    });
    const release = join(packageRoot, 'build', 'Release');
    const lipoArch = arch === 'x64' ? 'x86_64' : arch;
    for (const file of ['pty.node', 'spawn-helper']) {
      const archs = String(
        run('lipo', ['-archs', join(release, file)], { encoding: 'utf8' }),
      ).trim();
      if (archs !== lipoArch)
        throw Error(`node-pty ${file} built for ${archs}, not ${lipoArch}`);
    }
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    await cp(join(release, 'pty.node'), join(target, 'pty.node'));
    await cp(join(release, 'spawn-helper'), join(target, 'spawn-helper'));
    await chmod(join(target, 'spawn-helper'), 0o755);
    await writeFile(marker, JSON.stringify({ ...receipt, arch }) + '\n');
  }
  // node-pty loads build/Release before prebuilds: nothing is left there to shadow the fix.
  await rm(join(packageRoot, 'build'), { recursive: true, force: true });
  return true;
}
