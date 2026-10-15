// node-pty 1.1.0's Windows natural-exit path closes the output socket but
// leaves ConoutConnection's listening worker alive. Keep this private compatibility
// boundary pinned: never call pty.kill() after exit (its PID may have been reused).
const supportedVersion = '1.1.0';
const attached = new WeakMap();
export function assertSupportedWindowsPtyVersion(
  version,
  platform = process.platform,
) {
  if (platform === 'win32' && version !== supportedVersion)
    throw Error(
      `unsupported Windows PTY lifecycle adapter for node-pty ${String(version)}; expected ${supportedVersion}`,
    );
}
export function hasExitedWindowsPtyProcess(
  terminal,
  { version, platform = process.platform },
) {
  assertSupportedWindowsPtyVersion(version, platform);
  if (platform !== 'win32') return false;
  const agent = terminal?._agent;
  if (!agent || typeof agent._useConpty !== 'boolean')
    throw Error('unsupported node-pty 1.1.0 Windows process ownership shape');
  // Native ConPTY reports this before its delayed public output-close/onExit.
  // Never look up or signal the old numeric PID during that flush interval.
  return agent._useConpty && Number.isInteger(agent._exitCode);
}
export function installWindowsPtyExitCleanup(
  terminal,
  { version, platform = process.platform },
) {
  assertSupportedWindowsPtyVersion(version, platform);
  if (platform !== 'win32') return { dispose() {} };
  const previous = attached.get(terminal);
  if (previous) return previous;
  const agent = terminal?._agent;
  const connection = agent?._conoutSocketWorker;
  const input = agent?._inSocket;
  if (
    !connection ||
    typeof connection.dispose !== 'function' ||
    !input ||
    typeof input.destroy !== 'function'
  )
    throw Error(
      'unsupported node-pty 1.1.0 Windows worker/socket ownership shape',
    );
  let handled = false;
  const subscription = terminal.onExit(() => {
    if (handled) return;
    handled = true;
    // onExit follows the drained output socket's close event. dispose() drains
    // then terminates only this instance's worker; input.destroy closes our handle.
    // Neither action enumerates processes, sends signals, or uses a numeric PID.
    try {
      connection.dispose();
    } finally {
      input.destroy();
      subscription.dispose();
    }
  });
  attached.set(terminal, subscription);
  return subscription;
}
