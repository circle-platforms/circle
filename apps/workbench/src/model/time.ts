import { dateLocale } from '../i18n/index.ts';
/**
 * A time as people read it. The core sends ISO times: today's show as `14:05`, earlier ones
 * as `10 Oct 14:05` (with the year when it is not this one). Anything else, such as the
 * preview's `10:24` or `yesterday`, is shown as it is.
 */
export function shownTime(at: string, now = new Date()): string {
  // A reply still arriving has no clock time. The turn line says what it is doing.
  if (at === 'streaming') return '';
  if (!/^\d{4}-\d{2}-\d{2}T/.test(at)) return at;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  const time = date.toLocaleTimeString(dateLocale(), {
    hour: '2-digit',
    minute: '2-digit',
  });
  if (date.toDateString() === now.toDateString()) return time;
  const day = date.toLocaleDateString(dateLocale(), {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
  return `${day} ${time}`;
}
/** The full local time for a tooltip, or nothing when `at` is not an ISO time. */
export function fullTime(at: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(at)) return undefined;
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? undefined
    : date.toLocaleString(dateLocale());
}
