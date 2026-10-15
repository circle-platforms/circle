# Workspace event streams

`WorkspaceEventStream` writes one JSONL journal per granted workspace. `append`
and `appendBatch` resolve only after append and fsync; subscribers are notified
afterwards. A persistence failure rejects writes and requires reopening the
journal. Producers must await append: exceeding the pending-byte limit is an
explicit backpressure error, not a dropped successful event.

Use `replay({offset, seq}, limit)` to recover a disconnected renderer. Limits are
1–4096 records. Cursor offsets are byte boundaries, sequence numbers are globally
contiguous within the journal, and epochs change when a producer restarts. Opening
the journal retains complete records and truncates an unterminated final record;
complete corrupt records fail closed. Neither the ring nor renderer cache is a
history archive: all raw events remain in the journal.

Host integration:

- Derive the journal path from the authorized workspace, never a renderer path.
- Create one stream per workspace. Use a single producer owner and close it when
  shutting down workspace services, not when switching conversation tabs.
- Forward committed events with their `cursor`. Keep journal sequence ordering;
  filtering by session before delivery creates intentional gaps. Use one
  `WorkspaceStreamStore` per journal, then subscribe by resource key in React.
- Replay requests must recheck the requesting window's workspace grant. Install
  the live listener first, fetch bounded pages, and deduplicate buffered live
  events after replay. On `gap`, replay from the last applied cursor; do not
  reset to the incoming event or invent successful delivery.
- Terminal services already keep their original output logs. Append bounded
  output references/notifications to this journal rather than duplicating all
  raw chunks in global snapshots; the terminal replay endpoint retrieves bytes.
- Surface persistence/backpressure errors in the owning task. Pause the producer
  instead of continuing a task whose evidence cannot be stored.

`WorkspaceStreamStore` keeps bounded resource histories and coalesces subscriber
notifications. `snapshot(key)` is stable until that resource changes and can be
used with `useSyncExternalStore`. Full logs must be retrieved by replay, not by
concatenating the bounded cache.

`WindowedList` shares the existing transcript scroll element. The caller owns
durable row UI state and sets `revealIndex` before navigating to an unmounted
search result. Measured heights are retained by stable row key. The helper does
not make browser find-in-page discover unmounted rows.

Run `node apps/desktop/scripts/benchmark-workspace-stream.ts` for a synthetic
10,000-event, eight-resource durable-storage/store microbenchmark. Reported p50
and p95 exclude IPC, native rendering/input and model/network wait; they are not
end-to-end UI acceptance results.
