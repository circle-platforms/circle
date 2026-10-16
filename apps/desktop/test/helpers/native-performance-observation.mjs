/** Serialized into the renderer: uses actual input events and two visible frame opportunities. */
export function armNativeFeedback({ kind, selector, condition }) {
  window.__circleNativePerfPending = new Promise((resolve, reject) => {
    let started,
      frames = 0,
      backendId;
    const armedTarget = condition.file
      ? document.querySelector(selector)
      : undefined;
    const diagnostic = condition.file
      ? {
          selector,
          expected: condition.file,
          text: condition.text,
          armedAt: Date.now(),
          clicks: [],
        }
      : undefined;
    const fileState = () =>
      [...document.querySelectorAll('.file-view')].map((view) => ({
        heading: view.querySelector('.file-view-filename strong')?.textContent,
        sourceAria: view
          .querySelector('.file-source-origin')
          ?.getAttribute('aria-label'),
        hiddenAncestor: Boolean(view.closest('[hidden]')),
        rect:
          view.getBoundingClientRect().toJSON?.() ??
          view.getBoundingClientRect(),
        style:
          typeof getComputedStyle === 'function'
            ? {
                display: getComputedStyle(view).display,
                visibility: getComputedStyle(view).visibility,
              }
            : undefined,
        targets: [...view.querySelectorAll(condition.selector)].map((node) => ({
          text: node.textContent?.slice(0, 4096),
          hiddenAncestor: Boolean(node.closest('[hidden]')),
          rect:
            node.getBoundingClientRect().toJSON?.() ??
            node.getBoundingClientRect(),
          style:
            typeof getComputedStyle === 'function'
              ? {
                  display: getComputedStyle(node).display,
                  visibility: getComputedStyle(node).visibility,
                }
              : undefined,
        })),
      }));
    const saveDiagnostic = (outcome) => {
      if (!diagnostic) return;
      Object.assign(diagnostic, {
        outcome,
        recordedAt: Date.now(),
        started: started !== undefined,
        startedAt: started,
        frames,
        armedConnected: Boolean(armedTarget?.isConnected),
        currentSelectorMatches: document.querySelectorAll(selector).length,
        fileState: fileState(),
      });
      const records = (window.__circleNativePerfFeedbackDiagnostics ??= []);
      if (records.length < 64) records.push(diagnostic);
      else window.__circleNativePerfFeedbackDiagnosticOverflow = true;
    };
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
      saveDiagnostic('timeout');
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
      let target;
      if (condition.file) {
        const views = [...document.querySelectorAll('.file-view')].filter(
          (view) =>
            visible(view) &&
            view
              .querySelector('.file-view-filename strong')
              ?.textContent.trim() === condition.file.path &&
            view
              .querySelector('.file-source-origin')
              ?.getAttribute('aria-label')
              ?.endsWith(': ' + condition.file.sourceDirectory),
        );
        if (views.length !== 1) return false;
        target = [...views[0].querySelectorAll(condition.selector)].find(
          visible,
        );
      } else target = document.querySelector(condition.selector);
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
          saveDiagnostic('resolved');
          resolve(performance.now() - started);
          return;
        }
      } else frames = 0;
      requestAnimationFrame(frame);
    };
    const begin = (event) => {
      if (diagnostic && diagnostic.clicks.length < 16) {
        const anchor = event.target.closest('a');
        diagnostic.clicks.push({
          at: Date.now(),
          trusted: event.isTrusted,
          href: anchor?.getAttribute?.('href'),
          dataFlag: anchor?.getAttribute?.('data-perf-target'),
          matchesSelector: Boolean(event.target.closest(selector)),
          sameArmed: anchor === armedTarget,
          armedConnected: Boolean(armedTarget?.isConnected),
        });
      }
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
        terminalId: event.terminalId,
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

/** Eligibility requires recorded product visibility for the entire producer-to-frame interval. */
export function terminalVisibilityCohorts(rows, timing) {
  const transitions = timing.filter(
    (entry) => entry.phase === 'view-active' || entry.phase === 'view-inactive',
  );
  return rows.map((row) => {
    const own = transitions
      .filter((entry) => entry.terminalId === row.terminalId)
      .sort((a, b) => a.at - b.at);
    const before = own.filter((entry) => entry.at <= row.producerAt).at(-1);
    const throughFrame = own.filter(
      (entry) => entry.at > row.producerAt && entry.at <= row.frameAt,
    );
    if (row.frameAt === undefined || !before)
      return { ...row, visibilityCohort: 'unknown' };
    if (before.phase === 'view-active' && throughFrame.length === 0)
      return {
        ...row,
        visibilityCohort: 'continuously-visible',
        visibilityEpoch: before.visibilityEpoch,
      };
    const reveal = throughFrame
      .filter((entry) => entry.phase === 'view-active')
      .at(-1);
    if (
      reveal &&
      !throughFrame.some(
        (entry) => entry.at > reveal.at && entry.phase === 'view-inactive',
      )
    )
      return {
        ...row,
        visibilityCohort: 'hidden-recovery',
        revealAt: reveal.at,
        revealToFrameMs: row.frameAt - reveal.at,
        visibilityEpoch: reveal.visibilityEpoch,
      };
    return { ...row, visibilityCohort: 'not-continuously-visible' };
  });
}
