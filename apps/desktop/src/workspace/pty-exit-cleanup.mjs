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
  { version, platform = process.platform, onError },
) {
  assertSupportedWindowsPtyVersion(version, platform);
  if (platform !== 'win32') return { dispose() {} };
  const previous = attached.get(terminal);
  if (previous) return previous;
  const agent = terminal?._agent;
  const connection = agent?._conoutSocketWorker;
  const input = agent?._inSocket;
  const output = agent?._outSocket;
  const worker = connection?._worker;
  const closeOutput = agent?._cleanUpProcess;
  if (
    !connection ||
    typeof connection.dispose !== 'function' ||
    !input ||
    typeof input.destroy !== 'function' ||
    typeof input.on !== 'function' ||
    !output ||
    typeof output.destroy !== 'function' ||
    typeof output.on !== 'function' ||
    !worker ||
    typeof worker.terminate !== 'function' ||
    typeof worker.on !== 'function' ||
    typeof agent._useConpty !== 'boolean' ||
    typeof agent._useConptyDll !== 'boolean' ||
    typeof closeOutput !== 'function'
  )
    throw Error(
      'unsupported node-pty 1.1.0 Windows worker/socket ownership shape',
    );
  let handled = false;
  // The pinned ConoutConnection creates a Worker with no error listener. A
  // transport failure must be reported to its owner, rather than become an
  // uncaught application exception. Leave raw probes unchanged without a sink.
  if (onError) {
    worker.on('error', onError);
    input.on('error', onError);
    output.on('error', onError);
  }
  const report = (error) => {
    if (onError) onError(error);
    else
      queueMicrotask(() => {
        throw error;
      });
  };
  let release;
  const releaseWorker = () => (release ??= worker.terminate());
  let closing = false;
  // node-pty invokes this only after native exit and its resettable 1000ms
  // output-idle flush. Its original order destroys the receiving socket while
  // ConoutWorker can still pipe data into it for another 1000ms. Terminate only
  // our worker first, then close our already-drained receiving socket. Do not
  // change the upstream native-exit detection or its output-idle timer.
  if (agent._useConpty && !agent._useConptyDll) {
    agent._cleanUpProcess = () => {
      if (closing) return;
      closing = true;
      void releaseWorker().then(
        () => closeOutput.call(agent),
        (error) => {
          report(error);
          closeOutput.call(agent);
        },
      );
    };
  }
  const subscription = terminal.onExit(() => {
    if (handled) return;
    handled = true;
    // An earlier natural EOF can bypass _cleanUpProcess. Its public onExit still
    // means the receiving socket has closed, so there is no further output to
    // drain to this consumer. Release exactly this worker and input handle.
    try {
      void releaseWorker().catch(report);
    } finally {
      input.destroy();
      subscription.dispose();
    }
  });
  attached.set(terminal, subscription);
  return subscription;
}
