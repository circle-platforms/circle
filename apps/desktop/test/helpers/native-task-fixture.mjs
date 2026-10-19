const answer = (id, content, tool_calls) => ({
  message: {
    id,
    role: 'assistant',
    content,
    ...(tool_calls ? { tool_calls } : {}),
  },
});
const read = (id, file_path) => ({
  id,
  name: 'read_file',
  args: { file_path },
});

export const nativeTaskJourneyIds = {
  JOURNEY_WRITE_A: 'journey-write-a',
  JOURNEY_WRITE_B: 'journey-write-b',
  JOURNEY_READ_ONLY: 'journey-read-only',
};
export const nativeTaskJourneyEnqueueCall = 'journey-enqueue-tasks';

/**
 * Scripts are per real conversation; approval order cannot consume another agent's reply.
 * The parent's second turn stays active until it is aborted. With `startTasks`, a file
 * path, that turn first waits for the file and then schedules the three tasks itself, as
 * Circle does: the person never makes a task.
 */
export function nativeTaskJourneyFixture(requestsPath, { startTasks } = {}) {
  const criteria = 'Inspect actual file and git effects';
  const workers = [
    {
      marker: 'JOURNEY_WRITE_A',
      route: 'writer-a',
      access: 'write',
      calls: [
        {
          id: 'task-a-file',
          name: 'write_file',
          args: {
            file_path: 'agent-result.txt',
            content: 'isolated task output\n',
          },
        },
        {
          id: 'task-a-git',
          name: 'execute',
          args: { command: 'git status --short' },
        },
      ],
      path: 'agent-result.txt',
    },
    {
      marker: 'JOURNEY_WRITE_B',
      route: 'writer-b',
      access: 'write',
      calls: [
        {
          id: 'task-b-file',
          name: 'write_file',
          args: {
            file_path: 'agent-result.txt',
            content: 'isolated task output\n',
          },
        },
      ],
      path: 'agent-result.txt',
    },
    {
      marker: 'JOURNEY_READ_ONLY',
      route: 'readonly',
      access: 'readonly',
      calls: [read('task-read', 'README.md')],
      path: 'README.md',
    },
  ];
  return {
    requestsPath,
    routes: [
      {
        id: 'parent',
        match: { role: 'parent', firstUser: 'Prepare native journey' },
        replies: [
          answer('journey-baseline', 'Native journey ready: README.md'),
          ...(startTasks
            ? [
                {
                  chunks: [{ waitForFile: startTasks }],
                  message: answer('journey-schedule-tasks', '', [
                    {
                      id: nativeTaskJourneyEnqueueCall,
                      name: 'native_tasks_enqueue',
                      args: {
                        operationId: 'journey-enqueue-three',
                        tasks: workers.map((worker) => ({
                          id: nativeTaskJourneyIds[worker.marker],
                          prompt: worker.marker,
                          access: worker.access,
                          acceptanceCriteria: [criteria],
                        })),
                      },
                    },
                  ]).message,
                },
              ]
            : []),
          { waitForAbort: true },
        ],
      },
      ...workers.flatMap((worker) => [
        {
          id: worker.route,
          match: {
            role: 'worker',
            taskPrompt: worker.marker,
            access: worker.access,
          },
          replies: [
            answer(`task-${worker.route}`, '', worker.calls),
            answer(
              `task-${worker.route}-completed`,
              `${worker.marker} effects ready for independent verification`,
            ),
          ],
        },
        {
          id: `${worker.route}-reviewer`,
          match: {
            role: 'reviewer',
            taskPrompt: worker.marker,
            access: worker.access,
          },
          replies: [
            answer(`${worker.route}-review-read`, '', [
              read(`${worker.route}-review-source`, worker.path),
            ]),
            answer(
              `${worker.route}-review-result`,
              JSON.stringify({
                checks: [
                  {
                    criterion: criteria,
                    status: 'needs_review',
                    evidence: `Read actual ${worker.path} in the candidate workspace; source inspection alone does not verify the entire file and Git acceptance criterion. Human or command-oracle evidence is still required.`,
                    sources: [{ path: worker.path, line: 1 }],
                  },
                ],
              }),
            ),
          ],
        },
      ]),
    ],
  };
}
