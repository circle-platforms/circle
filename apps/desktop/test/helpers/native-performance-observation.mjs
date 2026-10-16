/** Serialized into the renderer: uses actual input events and two visible frame opportunities. */
export function armNativeFeedback({ kind, selector, condition }) {
  window.__circleNativePerfPending = new Promise((resolve, reject) => {
    let started,
      frames = 0,
      backendId;
    const unsubscribe = condition.session
      ? window.circleDesktop.onRuntime((update) => {
          backendId = update.snapshot?.activeSessionId;
        })
      : undefined;
    const cleanup = () => {
      clearTimeout(timeout);
      unsubscribe?.();
      document.removeEventListener(kind, begin, true);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(Error('visible feedback timed out'));
    }, 10000);
    const visible = (node) => {
      if (!node || node.closest('[hidden]')) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const ready = () => {
      if (condition.session) {
        const expected = condition.session,
          transcript = document.querySelector('.transcript');
        if (
          backendId !== expected.id ||
          decodeURIComponent(location.hash) !== '#/session/' + expected.id
        )
          return false;
        if (
          document.querySelector('.session-title')?.textContent.trim() !==
            expected.title ||
          !visible(transcript)
        )
          return false;
        const frame = transcript.getBoundingClientRect();
        return [...transcript.querySelectorAll('[data-message-id]')].some(
          (node) => {
            const rect = node.getBoundingClientRect();
            return (
              visible(node) &&
              rect.bottom > frame.top &&
              rect.top < frame.bottom &&
              (node.textContent ?? '').includes(expected.content)
            );
          },
        );
      }
      const target = document.querySelector(condition.selector);
      if (!target) return false;
      if (condition.panel) {
        const panel = document.querySelector(condition.panel.selector);
        if (visible(panel) !== condition.panel.visible) return false;
      }
      if (condition.feedback) {
        const feedback = document.querySelector(condition.feedback.selector);
        if (!feedback || feedback.disabled !== condition.feedback.disabled)
          return false;
      }
      if (condition.attribute)
        return target.getAttribute(condition.attribute) === condition.equals;
      if (condition.value !== undefined)
        return target.value === condition.value;
      return (target.textContent ?? '').includes(condition.text);
    };
    const frame = () => {
      if (ready()) {
        if (++frames >= 2) {
          cleanup();
          resolve(performance.now() - started);
          return;
        }
      } else frames = 0;
      requestAnimationFrame(frame);
    };
    const begin = (event) => {
      if (started !== undefined || !event.target.closest(selector)) return;
      started = performance.now();
      requestAnimationFrame(frame);
    };
    document.addEventListener(kind, begin, true);
  });
}

/** Serialized into the renderer; captures a stable visible message rather than total-height guesses. */
export function captureNativeTranscriptAnchor() {
  const transcript = document.querySelector('.transcript');
  if (!transcript || transcript.closest('[hidden]'))
    throw Error('visible transcript is unavailable');
  const frame = transcript.getBoundingClientRect();
  const node = [...transcript.querySelectorAll('[data-message-id]')].find(
    (node) => {
      const box = node.getBoundingClientRect();
      return box.height > 0 && box.bottom > frame.top && box.top < frame.bottom;
    },
  );
  if (!node) throw Error('no visible message for scroll continuity');
  return {
    id: node.dataset.messageId,
    offset: node.getBoundingClientRect().top - frame.top,
    scrollTop: transcript.scrollTop,
  };
}

/** Join real source records to renderer observation phases. Missing phases stay missing. */
export function terminalObservationRows(events, timing, ax) {
  const rows = [];
  for (const event of events) {
    if (event.kind !== 'data' || typeof event.data !== 'string') continue;
    const phases = timing.filter(
      (row) =>
        row.eventSequence === event.sequence &&
        row.terminalId === event.terminalId,
    );
    for (const match of event.data.matchAll(
      /NATIVE_PERF\s+(\d{13})\s+(\d+)/g,
    )) {
      const producerAt = Number(match[1]),
        get = (phase) => phases.find((row) => row.phase === phase)?.at;
      const axAt = ax.find((row) => row.sourceAt === producerAt)?.sampleAt;
      const read = timing.find(
        (row) =>
          row.terminalId === event.terminalId &&
          row.phase === 'replay-response' &&
          row.afterSequence < event.sequence &&
          row.cursor >= event.sequence,
      );
      const row = {
        eventSequence: event.sequence,
        producerAt,
        runtimeAt: Date.parse(event.at),
        replayResponseAt: read?.at,
        writeEnqueuedAt: get('write-enqueued'),
        parsedAt: get('write-parsed'),
        frameAt: get('write-frame'),
        axAt,
      };
      rows.push({
        ...row,
        producerToRuntimeMs: row.runtimeAt - producerAt,
        ...(row.parsedAt === undefined
          ? {}
          : { producerToParsedMs: row.parsedAt - producerAt }),
        ...(row.frameAt === undefined
          ? {}
          : { producerToFrameMs: row.frameAt - producerAt }),
        ...(row.axAt === undefined
          ? {}
          : { producerToAxMs: row.axAt - producerAt }),
      });
    }
  }
  return rows;
}
