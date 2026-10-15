import { captureNativeFailure } from './native-failure.mjs';
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
  try {
    await captureNativeFailure(page, error, events, output);
  } catch {
    try {
      console.error('native failure evidence unavailable');
    } catch {}
  }
}
