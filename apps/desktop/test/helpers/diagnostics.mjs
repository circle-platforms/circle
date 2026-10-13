import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export function observePage(page, events) {
  page.on('pageerror', (error) => events.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') events.push(message.text());
  });
  page.on('requestfailed', (request) =>
    events.push(request.url() + ': ' + request.failure()?.errorText),
  );
}
export async function captureFailure(page, error, events, output) {
  const details = {
    error: String(error),
    events,
    url: page?.url(),
    body: await page
      ?.locator('body')
      .innerText()
      .catch(() => ''),
  };
  if (page)
    await page
      .screenshot({ path: join(output, 'failure.png') })
      .catch(() => {});
  await writeFile(
    join(output, 'failure.json'),
    JSON.stringify(details, null, 2) + '\n',
  );
  console.error(JSON.stringify(details));
}

// A check that is still running long after it should have ended (an application that
// neither answers nor quits) ends here with its evidence: the CI job's own limit would end
// it later and keep no log. `page` is read when the deadline passes, so a window that
// opens later still has its picture taken.
export function armDeadline({ minutes, page, events, output, checks }) {
  const timer = setTimeout(async () => {
    const error = Error(`no end after ${minutes} minutes`);
    console.error(
      `${error.message}; checks so far: ${checks?.length ?? 0}${checks?.length ? ` (last: ${checks.at(-1)})` : ''}`,
    );
    await Promise.race([
      captureFailure(page?.(), error, events ?? [], output).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 15000)),
    ]);
    try {
      console.error(
        execFileSync(
          process.platform === 'win32' ? 'tasklist' : 'ps',
          process.platform === 'win32' ? [] : ['-axo', 'pid,command'],
          { encoding: 'utf8', timeout: 20000 },
        )
          .split('\n')
          .filter((line) => /Circle|electron|chrome/i.test(line))
          .join('\n'),
      );
    } catch {
      /* no process list */
    }
    process.exit(1);
  }, minutes * 60000);
  timer.unref();
  return () => clearTimeout(timer);
}
