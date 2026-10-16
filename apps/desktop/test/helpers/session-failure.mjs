import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { waitDesktopReady } from './desktop-readiness.mjs';

const describe = (error) => {
  try {
    return {
      name: String(error?.name ?? typeof error),
      message: String(error?.message ?? error),
      stack: String(error?.stack ?? ''),
    };
  } catch {
    return { unavailable: 'the thrown value could not be inspected' };
  }
};
const emit = (record) => {
  try {
    console.error(JSON.stringify(record));
  } catch {}
};
const save = (output, file, record) => {
  try {
    writeFileSync(join(output, file), JSON.stringify(record, null, 2) + '\n', {
      flag: 'wx',
    });
  } catch (error) {
    emit({ evidenceWriteError: describe(error) });
  }
};

// Submitted once after failure; no application command or DOM mutation is made.
export function sessionMenuState() {
  const text = (value) => String(value ?? '').slice(0, 300);
  const node = (element) => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      tag: element.tagName,
      id: element.id,
      class: text(element.getAttribute('class')),
      role: element.getAttribute('role'),
      label: text(element.getAttribute('aria-label')),
      state: element.getAttribute('data-state'),
      ariaHidden: element.getAttribute('aria-hidden'),
      inlinePointerEvents: element.style?.pointerEvents ?? null,
      pointerEvents: style.pointerEvents,
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      visible:
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none',
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  };
  const list = (selector) => {
    const elements = [...document.querySelectorAll(selector)];
    return {
      count: elements.length,
      truncated: elements.length > 20,
      nodes: elements.slice(0, 20).map((element) => ({
        ...node(element),
        text: text(element.textContent),
      })),
    };
  };
  const target = [...document.querySelectorAll('.sidebar .session-link')].find(
    (element) => element.textContent.includes('managed fixture B'),
  );
  const rect = target?.getBoundingClientRect();
  const center = rect
    ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    : null;
  return {
    observedAt: new Date().toISOString(),
    url: location.href,
    documentVisibilityState: document.visibilityState,
    documentHasFocus: document.hasFocus(),
    viewport: {
      innerWidth,
      innerHeight,
      devicePixelRatio,
    },
    bodyPointer: {
      inline: document.body.style.pointerEvents,
      computed: getComputedStyle(document.body).pointerEvents,
    },
    htmlPointer: {
      inline: document.documentElement.style.pointerEvents,
      computed: getComputedStyle(document.documentElement).pointerEvents,
    },
    menus: list('[role="menu"]'),
    dialogs: list('[role="dialog"], [role="alertdialog"]'),
    tooltips: list('[role="tooltip"], .tooltip'),
    focus: node(document.activeElement),
    target: node(target),
    center,
    hitTarget: center
      ? node(document.elementFromPoint(center.x, center.y))
      : null,
  };
}

// Primary evidence precedes one bounded DOM read. The budget bounds waiting,
// not cancellation of an already submitted renderer operation.
export async function captureSessionFailure(app, error, output) {
  try {
    const attempt = randomUUID();
    const primary = {
      attempt,
      at: new Date().toISOString(),
      error: describe(error),
    };
    emit(primary);
    save(output, `failure-${attempt}-primary.json`, primary);
    const details = {
      attempt,
      observation:
        'One post-failure DOM sample; it does not reconstruct the earlier interaction',
    };
    try {
      const page = app?.windows()[0];
      if (!page) throw Error('no owned renderer page is available');
      const { sample } = await waitDesktopReady(
        () => page.evaluate(sessionMenuState),
        () => true,
        { label: 'session failure DOM evidence', timeoutMs: 2000, stableMs: 0 },
      );
      details.sample = sample;
    } catch (secondary) {
      details.unavailable = describe(secondary);
    }
    save(output, `failure-${attempt}-state.json`, details);
    emit(details);
  } catch (secondary) {
    emit({ evidenceError: describe(secondary) });
  }
}

export async function cleanupSessionTest(operations) {
  let passed = true;
  for (const operation of operations) {
    try {
      await operation();
    } catch (error) {
      passed = false;
      emit({ cleanupError: describe(error) });
    }
  }
  return passed;
}
