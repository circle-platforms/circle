import { useState } from 'react';
import { Server } from 'lucide-react';
import { useRuntime } from '../app/context';
import {
  Button,
  DataBlock,
  EmptyState,
  Facts,
  Page,
  Status,
} from '../components/common';
import type { RuntimeExtension } from '../model/types';
import type { WorkbenchPlugin } from './types';

// What the bundled circle-server extension publishes with api.setView.
interface ServerView {
  url: string;
  username: string;
  scopeId: string;
  signedIn: boolean;
  following: string[];
  tasks: { taskId: string; title: string; seq: number; saved?: boolean }[];
  recent: string[];
}
export function serverView(
  extensions: readonly RuntimeExtension[],
): ServerView | undefined {
  const view = extensions.find((item) => item.name === 'circle-server')?.view;
  return view && typeof view === 'object' ? (view as ServerView) : undefined;
}
/** The interface half of the circle-server extension: its commands, as a page. */
export function ServerPage() {
  const { snapshot, runtime, perform } = useRuntime();
  const view = serverView(snapshot.extensions);
  const [address, setAddress] = useState(view?.url || '');
  const [user, setUser] = useState(view?.username || '');
  // Every action is the extension's own /server command; its lines go to the conversation.
  const run = (args: string) =>
    perform(async () => {
      await runtime.command('server', args);
    });
  return (
    <Page
      title="circle-server"
      description="Work handed to a circle-server from here. The server keeps each task; closing Circle does not stop it."
      action={<Button onClick={() => run('tasks')}>refresh</Button>}
    >
      {view ? (
        <Facts
          values={{
            server: view.url || 'none',
            user: view.username || 'none',
            project: view.scopeId || 'none',
            state: (
              <Status value={view.signedIn ? 'signed in' : 'signed out'} />
            ),
            following: view.following.length
              ? view.following.join(', ')
              : 'nothing',
          }}
        />
      ) : (
        <EmptyState title="not connected">
          The circle-server extension has published nothing yet.
        </EmptyState>
      )}
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (address && user) run(`login ${address} ${user}`);
        }}
      >
        <input
          aria-label="server address"
          placeholder="http://127.0.0.1:7410"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
        <input
          aria-label="user"
          placeholder="user"
          value={user}
          onChange={(event) => setUser(event.target.value)}
        />
        <Button type="submit">sign in</Button>
      </form>
      {view?.tasks.length ? (
        <div className="extension-list">
          {view.tasks.map((task) => (
            <article className="extension-card" key={task.taskId}>
              <div className="detail-title">
                <div>
                  <h2>{task.title || task.taskId}</h2>
                  <p>
                    {task.taskId} · seen to {task.seq}
                    {task.saved ? ' · results saved' : ''}
                  </p>
                </div>
                <Button
                  aria-label={`follow ${task.taskId}`}
                  onClick={() => run(`task ${task.taskId}`)}
                >
                  follow
                </Button>
                <Button
                  aria-label={`save results of ${task.taskId}`}
                  onClick={() => run(`get ${task.taskId}`)}
                >
                  save results
                </Button>
              </div>
            </article>
          ))}
        </div>
      ) : null}
      {view?.recent.length ? (
        <DataBlock title="recent" value={view.recent.join('\n')} />
      ) : null}
    </Page>
  );
}
export const serverPlugin: WorkbenchPlugin = {
  id: 'circle-server',
  apiVersion: 1,
  version: '0.1.0',
  title: 'circle-server',
  description:
    'Hand work to a circle-server and follow it: the interface half of the bundled circle-server extension.',
  icon: Server,
  runtimeExtension: 'circle-server',
  pages: [
    {
      id: 'server',
      title: 'circle-server',
      icon: Server,
      component: ServerPage,
    },
  ],
};
