import { lstat } from 'node:fs/promises';
import stripAnsi from 'strip-ansi';
import { jobLine, type JobOwner, type JobRegistry } from './jobs.js';
import {
  LocalSkillsError,
  prepareRun,
  prepareScriptCommand,
  runTool,
  type RunToolOptions,
} from './local_skills.js';
import { redactSecrets } from './secrets.js';

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
    signal.throwIfAborted();
    const prepared = await prepareRun(run);
    const launched = await prepareScriptCommand(prepared);
    if (background) {
      let job;
      try {
        signal.throwIfAborted();
        job = await jobs.startShell(
          launched.command,
          owner,
          timeout,
          signal,
          prepared.env,
        );
      } catch (error) {
        await launched.cleanup();
        throw error;
      }
      return `In background: ${jobLine(job)}. A notice will arrive when it ends; do not poll or sleep.`;
    }
    let result;
    try {
      result = await jobs.execute(
        launched.command,
        owner,
        signal,
        timeout || undefined,
        undefined,
        prepared.env,
      );
    } catch (error) {
      await launched.cleanup();
      throw error;
    }
    if (result.job) return result.output;
    const unstarted =
      (await lstat(launched.specPath).catch(() => null)) !== null;
    await launched.cleanup();
    const naturalExit =
      !result.execution ||
      (result.execution.status !== 'stopped' &&
        result.execution.reason !== 'timeout');
    if (unstarted && naturalExit) {
      const detail = redactSecrets(stripAnsi(result.output), run.secrets ?? {})
        .trim()
        .slice(0, 240);
      throw new LocalSkillsError(
        `脚本没有启动：Node 运行时未执行脚本入口（Node: ${launched.nodeExecutable}，退出码: ${result.exit_code ?? 'none'}）` +
          (detail ? `：${detail}` : ''),
        '确认 Circle 自带的 node 可执行文件正常后再试',
      );
    }
    return `${result.output}\nExit code: ${result.exit_code}`;
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
