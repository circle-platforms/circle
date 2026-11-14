import { jobLine, type JobOwner, type JobRegistry } from './jobs.js';
import {
  prepareRun,
  runTool,
  scriptCommand,
  type RunToolOptions,
} from './local_skills.js';

/** How a pack's script runs: the same choices as a command the model runs with execute. */
export interface ScriptRunOptions {
  jobs?: JobRegistry;
  owner: JobOwner;
  signal: AbortSignal;
  /** The workspace, where the script runs. */
  cwd: string;
  /** Seconds, at most 600. Without it a run still going after 120 s goes on as a background job. */
  timeout?: number;
  background?: boolean;
}

/**
 * Runs a pack's script in the workspace as execute runs a command. Still running at 120 s, it goes on as a background
 * job and the model gets its id and output file; given a `timeout`, it is ended then; with `background`, it starts as
 * a job. Where background jobs are not available it runs here, to its end or the timeout.
 */
export async function runScript(
  run: RunToolOptions,
  options: ScriptRunOptions,
): Promise<string> {
  const { jobs, owner, signal, timeout, background } = options;
  if (
    timeout !== undefined &&
    (!Number.isFinite(timeout) || timeout < 0 || timeout > 600)
  )
    throw new Error('timeout is in seconds, at most 600');
  if (jobs) {
    const prepared = await prepareRun(run);
    const command = await scriptCommand(prepared);
    if (background) {
      signal.throwIfAborted();
      const job = await jobs.startShell(
        command,
        owner,
        timeout,
        signal,
        prepared.env,
      );
      return `In background: ${jobLine(job)}. A notice will arrive when it ends; do not poll or sleep.`;
    }
    const result = await jobs.execute(
      command,
      owner,
      signal,
      timeout || undefined,
      undefined,
      prepared.env,
    );
    return result.job
      ? result.output
      : `${result.output}\nExit code: ${result.exit_code}`;
  }
  if (background) throw new Error('background runs are not available here');
  const result = await runTool({
    ...run,
    cwd: options.cwd,
    signal,
    timeoutMs: (timeout || 120) * 1000,
  });
  return [
    result.stdout,
    result.stderr ? `${result.stdout ? '\n' : ''}${result.stderr}` : '',
    result.timed_out
      ? `\nThe script was ended after ${timeout || 120} seconds.`
      : '',
    result.truncated && !result.timed_out ? '\nOutput was cut.' : '',
    `\nExit code: ${result.exit_code ?? 'none'}`,
  ].join('');
}
