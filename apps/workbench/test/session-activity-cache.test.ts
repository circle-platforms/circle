import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFixtures } from '../src/preview/fixtures.ts';
import {
  sessionActivityAt,
  recentSessions,
  orderedProjects,
} from '../src/model/session-management.ts';
import type { Message } from '../src/model/types.ts';

function fixture() {
  const snapshot = createFixtures();
  const session = structuredClone(snapshot.sessions[0]!);
  session.messages = Array.from(
    { length: 10000 },
    (_, index) =>
      ({
        id: `activity-${index}`,
        parentId: null,
        role: 'assistant',
        text: 'history',
        at: new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString(),
      }) satisfies Message,
  );
  return { snapshot, session };
}

test('repeated activity consumers parse each unchanged timestamp once while keeping the latest message time', (t) => {
  const { snapshot, session } = fixture();
  const parse = Date.parse;
  let calls = 0;
  t.mock.method(Date, 'parse', (text: string) => {
    calls++;
    return parse(text);
  });
  const expected = session.messages.at(-1)!.at;
  assert.equal(sessionActivityAt(session), expected);
  assert.equal(calls, 10000);
  for (let i = 0; i < 10; i++)
    assert.equal(sessionActivityAt({ ...session, draft: String(i) }), expected);
  assert.equal(
    calls,
    10000,
    'view-only changes never reparse ten thousand timestamps',
  );
  recentSessions([session]);
  // Project groups are in name order; they read no activity at all.
  orderedProjects(snapshot.workspaces, [session]);
  assert.equal(
    calls,
    10001,
    'sort consumers parse their one summary, not the full history',
  );
});

test('same-array internal timestamp edits, replacements, append and deletion invalidate cached activity', () => {
  const { session } = fixture();
  const last = session.messages.at(-1)!.at;
  assert.equal(sessionActivityAt(session), last);
  session.messages[4]!.at = '2030-01-01T00:00:00Z';
  assert.equal(sessionActivityAt(session), '2030-01-01T00:00:00Z');
  session.messages[4] = { ...session.messages[4]!, at: 'bad timestamp' };
  assert.equal(sessionActivityAt(session), last);
  session.messages.push({
    ...session.messages[0]!,
    id: 'appended',
    at: '2031-01-01T00:00:00Z',
  });
  assert.equal(sessionActivityAt(session), '2031-01-01T00:00:00Z');
  session.messages.pop();
  assert.equal(sessionActivityAt(session), last);
  session.messages.reverse();
  assert.equal(
    sessionActivityAt(session),
    last,
    'array order is not chronological order',
  );
});

test('equal instants retain the last written spelling and invalid-only histories use the current fallback', () => {
  const { session } = fixture();
  session.messages = [
    { ...session.messages[0]!, at: '2030-01-01T00:00:00Z' },
    { ...session.messages[1]!, at: '2030-01-01T01:00:00+01:00' },
  ];
  assert.equal(sessionActivityAt(session), '2030-01-01T01:00:00+01:00');
  session.messages.reverse();
  assert.equal(sessionActivityAt(session), '2030-01-01T00:00:00Z');
  session.messages.forEach((message) => {
    message.at = 'unknown';
  });
  session.updatedAt = 'fallback one';
  assert.equal(sessionActivityAt(session), 'fallback one');
  session.updatedAt = 'fallback two';
  assert.equal(sessionActivityAt(session), 'fallback two');
});
