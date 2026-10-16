/**
 * A model failure as the terminal should say it. Endpoints often answer with a JSON body;
 * a bad model name should point at /models instead of that body.
 */
export function friendlyModelError(message: string, status?: number): string {
  const text = message.replace(/\s+/g, ' ').trim();
  let detail = text;
  const jsonAt = text.indexOf('{');
  if (jsonAt >= 0) {
    try {
      const body = JSON.parse(text.slice(jsonAt)) as {
        error?: { message?: unknown; type?: unknown } | string;
        message?: unknown;
      };
      const error = body.error;
      const inner =
        typeof error === 'string'
          ? error
          : typeof error?.message === 'string'
            ? error.message
            : typeof body.message === 'string'
              ? body.message
              : '';
      if (inner) detail = inner;
    } catch {
      /* Not JSON; the status line below still shortens a raw body. */
    }
  }
  const modelProblem =
    status === 404 ||
    /not[_\s-]?found|does not exist|unknown model|invalid model|model:/i.test(
      detail,
    );
  if (modelProblem)
    return `Unknown model${detail && detail.length < 160 && !detail.startsWith('{') ? ` · ${detail}` : ''}. /models lists what this endpoint offers.`;
  if (text.includes('{') || text.length > 240)
    return `The endpoint rejected the request${status ? ` (${status})` : ''}${detail && detail !== text ? ` · ${detail.slice(0, 160)}` : ''}. /models lists the models it offers.`;
  return text;
}
