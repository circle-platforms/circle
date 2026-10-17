export const PERFORMANCE_RAW_MESSAGES = 10001;
export const PERFORMANCE_PROJECTED_MESSAGES = 10000;
/** A persisted tool call/result pair is one workbench row, not two. */
export function performanceMessages({ png, log }) {
  const messages = Array.from({ length: 9998 }, (_, index) => ({
    id: `history-${index}`,
    role: index % 2 ? 'assistant' : 'user',
    content: `persisted history ${index} · ${'readable transcript '.repeat(5)}`,
  }));
  messages.push({
    id: 'history-tool-call',
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: 'perf-execute',
        name: 'execute',
        args: { command: 'historical performance fixture' },
      },
    ],
  });
  messages.push({
    id: 'history-tool-result',
    role: 'tool',
    tool_call_id: 'perf-execute',
    content: log,
  });
  messages.push({
    id: 'history-last',
    role: 'assistant',
    content:
      'PERF_HISTORY_READY\n\n[README](README.md#L1) · [SECOND](SECOND.md#L1)',
    attachments: [
      {
        kind: 'image',
        filename: 'performance-original.png',
        mime_type: 'image/png',
        data: png,
      },
    ],
  });
  return messages;
}
