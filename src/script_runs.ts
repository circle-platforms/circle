import {
  commandAnswer,
  jobLine,
  type JobOwner,
  type JobRegistry,
} from './jobs.js';
import {
  prepareRun,
  prepareScriptCommand,
  runTool,
  type RunToolOptions,
} from './local_skills.js';

export interface ScriptRunOptions {
  jobs?: JobRegistry;
  owner: JobOwner;
  signal: AbortSignal;
  cwd: string;
  timeout?: number;
  background?: boolean;
}

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
    const script = await prepareScriptCommand(prepared);
    try {
      if (background) {
        signal.throwIfAborted();
        const job = await jobs.startShell(
          script.command,
          owner,
          timeout,
          signal,
          prepared.env,
        );
        return `In background: ${jobLine(job)}. A notice will arrive when it ends; do not poll or sleep.`;
      }
      const result = await jobs.execute(
        script.command,
        owner,
        signal,
        timeout || undefined,
        undefined,
        prepared.env,
      );
      if (result.job) return result.output;
      return commandAnswer(result.output, result.exit_code);
    } catch (error) {
      await script.cleanup();
      throw error;
    }
  }
  if (background) throw new Error('background runs are not available here');
  const result = await runTool({
    ...run,
    cwd: options.cwd,
    signal,
    timeoutMs: (timeout || 120) * 1000,
  });
  return commandAnswer(
    [
      result.stdout,
      result.stderr ? `${result.stdout ? '\n' : ''}${result.stderr}` : '',
      result.timed_out
        ? `\nThe script was ended after ${timeout || 120} seconds.`
        : '',
      result.truncated && !result.timed_out ? '\nOutput was cut.' : '',
    ].join(''),
    result.exit_code,
    result.timed_out,
  );
}
