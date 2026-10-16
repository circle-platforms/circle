import { join, posix, win32 } from 'node:path';
import { writePerformanceEvidence } from './native-performance-diagnostics.mjs';

/** Only attach to the Playwright-owned renderer; never connect an arbitrary browser. */
export async function startNativePerformanceCpuProfile(page, report) {
  const record = (report.cpuProfile = {
    optIn: true,
    startBeforeAt: Date.now(),
    observerOverhead:
      'CDP sampling profiler plus optional reading snapshots; not an uninstrumented strict baseline',
    timestampMapping:
      'Profiler monotonic startTime is bracketed by startBeforeAt/startAfterAt; wall-clock alignment is approximate by this RPC bracket.',
  });
  let session;
  try {
    session = await page.context().newCDPSession(page);
    await session.send('Profiler.enable');
    await session.send('Profiler.start');
    record.startAfterAt = Date.now();
    return { session, record };
  } catch (error) {
    record.unavailable = String(error);
    try {
      await session?.detach();
    } catch {}
    return undefined;
  }
}
export async function stopNativePerformanceCpuProfile(
  handle,
  output,
  report,
  writer,
) {
  if (!handle) return;
  const { session, record } = handle;
  record.stopBeforeAt = Date.now();
  try {
    const { profile } = await session.send('Profiler.stop');
    record.stopAfterAt = Date.now();
    record.file = join(output, 'renderer.cpuprofile');
    record.saved = await writePerformanceEvidence(
      report,
      record.file,
      JSON.stringify(profile),
      writer,
    );
  } catch (error) {
    record.stopError = String(error);
  } finally {
    try {
      await session.detach();
    } catch (error) {
      record.detachError = String(error);
    }
  }
}

/** Read-only snapshot; never waits for layout stability, changes scroll or substitutes an oracle. */
export function captureNativeReadingTrace({ phase, expected, capturedAnchor }) {
  const transcript = document.querySelector('.transcript');
  const bounds = transcript?.getBoundingClientRect();
  const rows = transcript
    ? [...transcript.querySelectorAll('[data-message-id]')].map((node) => {
        const box = node.getBoundingClientRect();
        return {
          id: node.getAttribute('data-message-id'),
          top: box.top,
          bottom: box.bottom,
          height: box.height,
          offset: box.top - bounds.top,
          visible:
            box.height > 0 &&
            box.bottom > bounds.top &&
            box.top < bounds.bottom,
        };
      })
    : [];
  let stored;
  try {
    const value = JSON.parse(
      localStorage.getItem('circle.workbench.live.views.v1') ?? 'null',
    );
    stored = value?.views?.map(([id, view]) => ({
      id,
      scroll: view?.presentation?.scroll,
    }));
  } catch {
    stored = 'unavailable';
  }
  return {
    at: Date.now(),
    phase,
    expected,
    capturedAnchor,
    backendActiveSessionId: window.__circleNativeReadingBackend,
    route: location.hash,
    header: document.querySelector('.session-title')?.textContent,
    selectedSidebar: [
      ...document.querySelectorAll('.sidebar .session-link.active'),
    ].map((node) => node.getAttribute('href')),
    viewport: transcript
      ? {
          top: bounds.top,
          bottom: bounds.bottom,
          width: bounds.width,
          height: bounds.height,
          scrollTop: transcript.scrollTop,
          scrollHeight: transcript.scrollHeight,
          clientHeight: transcript.clientHeight,
          hidden: Boolean(transcript.closest('[hidden]')),
        }
      : null,
    rows,
    storedScrolls: stored,
  };
}

/** Reuse hashes already verified from the actual owned app, including ASAR and cross-platform paths. */
export function executedRendererArtifactEvidence(executed) {
  const paths = executed.platform === 'win32' ? win32 : posix;
  const root = paths.dirname(executed.rendererPath);
  return executed.artifacts.flatMap((entry) => {
    const path = paths.relative(root, entry.path);
    return path && !path.startsWith('..') && !paths.isAbsolute(path)
      ? [{ path: path.split(paths.sep).join('/'), sha256: entry.sha256 }]
      : [];
  });
}
