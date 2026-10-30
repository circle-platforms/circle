// A stand-in for the GitHub CLI, for tests/pr-review-run.test.ts. It answers the
// calls the pr-review skill suggests the way GitHub does, records what it was
// asked for, and keeps the bodies it was given through --body-file. An argument
// list it does not know is an error: the skill must only suggest calls that exist.
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_LOG, JSON.stringify(args) + '\n');
const flag = (name) => args[args.indexOf(name) + 1];
const joined = args.join(' ');
const answer = (text, code = 0) => {
  process.stdout.write(text);
  process.exit(code);
};
const body = () => fs.readFileSync(flag('--body-file'), 'utf8');
const keep = (name, value) =>
  fs.writeFileSync(path.join(process.env.GH_KEPT, name), JSON.stringify(value));

if (
  joined === 'pr view --json number,state,url,isDraft,reviewDecision,mergeable'
)
  answer(
    JSON.stringify({
      number: 42,
      state: 'OPEN',
      url: 'https://github.com/o/r/pull/42',
      isDraft: false,
      reviewDecision: 'CHANGES_REQUESTED',
      mergeable: 'MERGEABLE',
    }),
  );
else if (joined === 'pr view 217 --json number,state,url,reviewDecision')
  answer(
    JSON.stringify({
      number: 217,
      state: 'OPEN',
      url: 'https://github.com/o/r/pull/217',
      reviewDecision: 'CHANGES_REQUESTED',
    }),
  );
else if (joined === 'pr view --json state,mergeable,reviewDecision')
  answer(
    JSON.stringify({
      state: 'OPEN',
      mergeable: 'MERGEABLE',
      reviewDecision: 'CHANGES_REQUESTED',
    }),
  );
else if (joined === 'pr checks')
  // A red check is the answer, not an error of the person running it.
  answer(
    'check (ubuntu-24.04)  fail  6m2s  https://github.com/o/r/actions/runs/9001\n',
    1,
  );
// A flag with no value of its own: presence, not the next word.
else if (args[0] === 'run' && args[1] === 'view' && args.includes('--log-failed'))
  answer('FAIL tests/file-rewind.test.ts\n    expected 2 items but got 3\n');
else if (joined === 'pr diff')
  answer('diff --git a/src/file_rewind.ts b/src/file_rewind.ts\n');
else if (joined === 'pr view --json reviews,comments')
  answer(
    JSON.stringify({
      reviews: [
        {
          id: 'r-1',
          state: 'CHANGES_REQUESTED',
          body: 'A turn that cannot be restored whole must not half restore',
          author: { login: 'reviewer' },
        },
      ],
      comments: [
        {
          id: 'c-7',
          path: 'src/file_rewind.ts',
          line: 41,
          body: 'Why is the plan file never recorded?',
          author: { login: 'reviewer' },
        },
      ],
    }),
  );
else if (args[0] === 'pr' && args[1] === 'comment' && flag('--body-file')) {
  keep('comment.json', {
    number: args[2],
    replyTo: flag('--reply-to'),
    body: body(),
  });
  answer('https://github.com/o/r/pull/42#issuecomment-1001\n');
} else if (args[0] === 'pr' && args[1] === 'review' && flag('--body-file')) {
  keep('review.json', { number: args[2], event: 'comment', body: body() });
  answer('https://github.com/o/r/pull/42#pullrequestreview-2002\n');
} else answer('unknown gh call: ' + joined + '\n', 2);