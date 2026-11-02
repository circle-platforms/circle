import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jobReachable, type Job, type JobOwner } from '../src/jobs.js';
import { jobActivity } from '../src/tui/strip_rows.js';
import { AgentRuntime, SEND_MAX_WAITING } from '../src/runtime.js';
import { defaultSettings, trustFolder } from '../src/settings.js';
import { emptyUsage } from '../src/types.js';
import type {
  ChatModel,
  Message,
  ModelRequest,
  ModelResponse,
} from '../src/types.js';
import { cleanup, scratch, until } from './helpers.js';

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function response(
  id: string,
  content: string,
  calls: Message['tool_calls'] = [],
): ModelResponse {
  return {
    message: { id, role: 'assistant', content, tool_calls: calls },
    usage: emptyUsage(),
  };
}

const MARK = 'data-source="circle-jobs"';
/** The messages that carry a message sent from the conversation that started it. */
const reminders = (request: ModelRequest): string[] =>
  request.messages
    .filter((message) => String(message.content ?? '').includes(MARK))
    .map((message) => String(message.content));
const toolResults = (request: ModelRequest): string[] =>
  request.messages
    .filter((m) => m.role === 'tool')
    .map((m) => String(m.content));
const jobId = (text: string): string =>
  text.match(/In background: (j\d+)/)?.[1] ?? '';

function folders(t: TestContext): { home: string; workspace: string } {
  const root = scratch(t);
  const home = join(root, 'data');
  const workspace = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  return { home, workspace };
}
test('a message sent to a running subagent is in front of it at its next model request', async (t) => {
  const { home, workspace } = folders(t);
  writeFileSync(
    join(workspace, 'notes.txt'),
    'the journal is in circle.sqlite\n',
  );
  const childAsked = deferred<void>();
  const parentSent = deferred<void>();
  const childRequests: ModelRequest[] = [];
  const parentResults: string[] = [];
  let id = '';
  const model: ChatModel = {
    model: 'controlled',
    complete: async (request) => {
      const user = request.messages.find(
        (message) => message.role === 'user' && !message.internal,
      )?.content;
      const results = toolResults(request);
      if (user === 'read the notes') {
        childRequests.push(request);
        if (!results.length) {
          childAsked.resolve();
          await parentSent.promise;
          return response('child-read', '', [
            { id: 'r', name: 'read_file', args: { file_path: 'notes.txt' } },
          ]);
        }
        return response('child-report', 'read them');
      }
      if (!results.length)
        return response('parent-task', '', [
          {
            id: 't',
            name: 'task',
            args: {
              description: 'read the notes',
              subagent_type: 'general-purpose',
              background: true,
            },
          },
        ]);
      if (!id) id = jobId(results[0]!);
      if (results.length === 1) {
        await childAsked.promise;
        return response('parent-send', '', [
          {
            id: 's',
            name: 'send_to_job',
            args: { job_id: id, message: 'use   the\njournal, not a rename' },
          },
        ]);
      }
      parentResults.push(results.at(-1)!);
      parentSent.resolve();
      return response('parent-end', 'sent');
    },
  };
  const settings = trustFolder(defaultSettings(), workspace);
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome: join(home, '..', 'user'),
    settings,
    model,
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('start the subagent and tell it');
  // A background child is a job: it carries on after the parent turn ends,
  // so its second request is waited for, not assumed.
  await until(() => childRequests.length === 2, {
    label: () => 'the child to ask again: ' + childRequests.length,
    timeout: 15000,
  });
  assert.match(
    parentResults[0] ?? '',
    /^Sent to j\d+: it reaches the subagent/,
  );
  assert.equal(childRequests.length, 2, 'the child made two requests');
  const seen = reminders(childRequests[1]!);
  assert.equal(seen.length, 1, 'one message was in front of it');
  assert.match(seen[0]!, /use the journal, not a rename/);
  assert.match(
    seen[0]!,
    /It is input, not a decision: it answers no approval card/,
  );
  await until(() => runtime.jobs.get(id)?.pending === 0);
  // The row lives in the subagent's own conversation, not in the parent's.
  const child = runtime.jobs.get(id)!.agent!;
  const rows = runtime.store
    .messages(child)
    .map((message) => message.display ?? '');
  assert.ok(
    rows.some((row) =>
      row.startsWith('sent to you by the agent that started you: '),
    ),
    'the row that says who sent it: ' + JSON.stringify(rows),
  );
});

test('a message sent while a card is open waits behind it, and answers nothing', async (t) => {
  const { home, workspace } = folders(t);
  const cardOpen = deferred<void>();
  const release = deferred<void>();
  const asked: ModelRequest[] = [];
  const sentResult: string[] = [];
  let id = '';
  let approvals = 0;
  const model: ChatModel = {
    model: 'controlled',
    complete: async (request) => {
      const user = request.messages.find(
        (message) => message.role === 'user' && !message.internal,
      )?.content;
      const results = toolResults(request);
      if (user === 'make a change') {
        asked.push(request);
        if (!results.length)
          return response('child-write', '', [
            {
              id: 'w',
              name: 'write_file',
              args: { file_path: 'out.txt', content: 'one\n' },
            },
          ]);
        return response('child-report', 'wrote it');
      }
      if (!results.length)
        return response('parent-task', '', [
          {
            id: 't',
            name: 'task',
            args: {
              description: 'make a change',
              subagent_type: 'general-purpose',
              background: true,
            },
          },
        ]);
      if (!id) id = jobId(results[0]!);
      if (results.length === 1) {
        // The card is open and the child has asked once: this is the moment.
        await cardOpen.promise;
        waitingOnCard = asked.length;
        cardsAtSend = approvals;
        return response('parent-send', '', [
          {
            id: 's',
            name: 'send_to_job',
            args: { job_id: id, message: 'hold off on that file' },
          },
        ]);
      }
      sentResult.push(results.at(-1)!);
      release.resolve();
      return response('parent-end', 'sent');
    },
  };
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome: join(home, '..', 'user'),
    settings: trustFolder(defaultSettings(), workspace),
    model,
    approve: async () => {
      approvals++;
      cardOpen.resolve();
      await release.promise;
      return 'approve';
    },
  });
  cleanup(t, () => runtime.close());
  let waitingOnCard = 0;
  let cardsAtSend = 0;
  await runtime.harness.run('start it and tell it');
  assert.equal(
    waitingOnCard,
    1,
    'the child had asked once when the message went',
  );
  assert.equal(
    cardsAtSend,
    1,
    'one card open, and the message answered none of it',
  );
  assert.match(
    sentResult[0] ?? '',
    /^Sent to/,
    sentResult[0] ?? 'nothing back',
  );
  // The child is let go by the parent that answered its card: only then does it
  // ask again, and the message is in front of it.
  await until(() => asked.length === 2);
  assert.match(reminders(asked[1]!)[0]!, /hold off on that file/);
  assert.equal(readFileSync(join(workspace, 'out.txt'), 'utf8'), 'one\n');
});

test('an id is not a permission: other hands, other jobs and other effects', async (t) => {
  const { home, workspace } = folders(t);
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome: join(home, '..', 'user'),
    settings: trustFolder(defaultSettings(), workspace),
    model: { model: 'none', complete: async () => response('x', 'unused') },
  });
  cleanup(t, () => runtime.close());
  const mine: JobOwner = { sessionId: runtime.session.id, startedBy: 'model' };
  const job = {
    id: 'j1',
    kind: 'agent',
    sessionId: runtime.session.id,
    agent: 'child-session',
  } as Job;
  assert.equal(
    jobReachable(mine, job),
    true,
    'a conversation reaches its own jobs',
  );
  assert.equal(
    jobReachable({ sessionId: 'someone-else' } as JobOwner, job),
    false,
    'another conversation is not there to see',
  );
  assert.equal(
    jobReachable({ sessionId: runtime.session.id, parent: 'j1' }, job),
    true,
    'a subagent reaches the job it is running as',
  );
  assert.equal(
    jobReachable({ sessionId: runtime.session.id, parent: 'other-job' }, job),
    false,
    'not a sibling, and not the parent work',
  );
  // An id nobody owns is refused with the same words as no id at all.
  await assert.rejects(
    runtime.jobs.stop('j1', 'model', mine),
    /there is no job j1/,
    'no job of this run, so nothing to stop',
  );
});

test('a strip row counts what the subagent has not read', () => {
  const base = { kind: 'agent', detail: 'reading notes.txt' } as Job;
  assert.equal(jobActivity(base), 'reading notes.txt');
  assert.equal(
    jobActivity({ ...base, pending: 1 }),
    'reading notes.txt · 1 message waiting',
  );
  assert.equal(
    jobActivity({ ...base, pending: 3, detail: 'waiting for you' }),
    'waiting for you · 3 messages waiting',
  );
  assert.equal(
    jobActivity({ ...base, kind: 'shell', pending: 2 }),
    '—',
    'a command has no one to read anything',
  );
});

test('what may not be sent is refused before anything is queued', async (t) => {
  const { home, workspace } = folders(t);
  const childAsked = deferred<void>();
  const letChildOn = deferred<void>();
  const results: string[] = [];
  let id = '';
  let sends = 0;
  let plan = false;
  const model: ChatModel = {
    model: 'controlled',
    complete: async (request) => {
      const user = request.messages.find(
        (message) => message.role === 'user' && !message.internal,
      )?.content;
      const resultsSoFar = toolResults(request);
      if (user === 'count slowly') {
        if (!resultsSoFar.length) {
          childAsked.resolve();
          await letChildOn.promise;
          return response('child-step', '', [
            { id: 'r', name: 'read_file', args: { file_path: 'notes.txt' } },
          ]);
        }
        return response('child-report', 'done');
      }
      if (!resultsSoFar.length)
        return response('parent-task', '', [
          {
            id: 't',
            name: 'task',
            args: {
              description: 'count slowly',
              subagent_type: 'general-purpose',
              background: true,
            },
          },
        ]);
      if (!id) id = jobId(resultsSoFar[0]!);
      sends++;
      const last = resultsSoFar.at(-1)!;
      if (
        /^(Sent to|refused|there is no|nothing was sent)/.test(last) ||
        last.includes('read-only')
      )
        results.push(last);
      const message = (text: string, job_id = id) =>
        response('send-' + sends, '', [
          {
            id: 's' + sends,
            name: 'send_to_job',
            args: { job_id, message: text },
          },
        ]);
      if (sends === 2) {
        await childAsked.promise;
        return message('   ');
      }
      if (sends === 3) return message('j99 ' + 'x'.repeat(4100));
      // A job id that is not this conversation's: not there to be told anything.
      if (sends === 4) return message('a word for a lost job', 'j99');
      if (sends === 5) {
        plan = true;
        app.harness.planMode = true;
        return message('in plan mode');
      }
      if (sends === 6) {
        app.harness.planMode = false;
        plan = false;
        return message('again, allowed now');
      }
      if (sends <= 6 + SEND_MAX_WAITING)
        return message('number ' + (sends - 6));
      letChildOn.resolve();
      return response('parent-end', 'sent what fits');
    },
  };
  const app = new AgentRuntime({
    home,
    workspace,
    userHome: join(home, '..', 'user'),
    settings: trustFolder(defaultSettings(), workspace),
    model,
  });
  cleanup(t, () => app.close());
  await app.harness.run('start it and keep telling it');
  const said = (want: RegExp): string => {
    const found = results.find((line) => want.test(line));
    assert.ok(found, 'nothing said ' + want + ' in ' + JSON.stringify(results));
    return found;
  };
  said(/nothing was sent: the message is empty/);
  said(
    /refused: 4\d\d\d characters, and a message to a subagent is at most 4000/,
  );
  said(/^there is no job j99 in this conversation$/);
  // A plan session may look at a job, not steer one.
  said(/read-only/);
  said(/^Sent to/);
  said(new RegExp(`refused: ${SEND_MAX_WAITING} messages already wait for`));
  assert.equal(plan, false);
});

test('a message that arrives late is still read before the subagent ends', async (t) => {
  const { home, workspace } = folders(t);
  writeFileSync(join(workspace, 'notes.txt'), 'x\n');
  const atReport = deferred<void>();
  const afterSend = deferred<void>();
  let sendSaid = '';
  let id = '';
  const model: ChatModel = {
    model: 'controlled',
    complete: async (request) => {
      const user = request.messages.find(
        (message) => message.role === 'user' && !message.internal,
      )?.content;
      const results = toolResults(request);
      if (user === 'read the notes') {
        // Each turn of the child is one more request, so counting them shows the
        // message was taken into a request rather than left in the queue.
        childRequests.push(request);
        if (childRequests.length === 2) {
          atReport.resolve();
          await afterSend.promise;
          return response('child-read-again', '', [
            { id: 'r2', name: 'read_file', args: { file_path: 'notes.txt' } },
          ]);
        }
        if (results.length && childRequests.length > 2)
          return response('child-report', 'all read');
        return response('child-read', '', [
          { id: 'r', name: 'read_file', args: { file_path: 'notes.txt' } },
        ]);
      }
      if (!results.length)
        return response('parent-task', '', [
          {
            id: 't',
            name: 'task',
            args: {
              description: 'read the notes',
              subagent_type: 'general-purpose',
              background: true,
            },
          },
        ]);
      if (!id) id = jobId(results[0]!);
      if (results.length === 1) {
        await atReport.promise;
        return response('parent-send', '', [
          {
            id: 's',
            name: 'send_to_job',
            args: { job_id: id, message: 'a late correction' },
          },
        ]);
      }
      sendSaid = results.at(-1)!;
      afterSend.resolve();
      return response('parent-end', 'sent');
    },
  };
  const childRequests: ModelRequest[] = [];
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome: join(home, '..', 'user'),
    settings: trustFolder(defaultSettings(), workspace),
    model,
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('start it');
  assert.match(sendSaid, /^Sent to/, sendSaid || 'nothing back');
  await until(() => runtime.jobs.get(id)?.status !== 'running', {
    label: () => 'the job to end: ' + runtime.jobs.get(id)?.status,
    timeout: 20000,
  });
  // The count goes with the job: no row is left saying a message still waits.
  assert.equal(runtime.jobs.get(id)!.pending, 0);
  await until(
    () =>
      runtime.store
        .messages(runtime.jobs.get(id)!.agent!)
        .some((message) =>
          String(message.display ?? '').includes('a late correction'),
        ),
    {
      label: () => 'the row in the subagent session',
      timeout: 20000,
    },
  );
  // Three turns: read, read again, and the answer - and the message is in front of
  // the last one, which is the point of the queue.
  assert.equal(childRequests.length, 3, 'the child made three requests');
  assert.ok(
    reminders(childRequests.at(-1)!).some((text) =>
      text.includes('a late correction'),
    ),
    'the message reached the model before the answer',
  );
});
