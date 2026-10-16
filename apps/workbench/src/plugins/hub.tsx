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

// What the bundled hub extension publishes with api.setView.
interface HubView {
  url: string;
  username: string;
  scopeId: string;
  signedIn: boolean;
  following: string[];
  tasks: { taskId: string; title: string; seq: number; saved?: boolean }[];
  recent: string[];
}
export function hubView(
  extensions: readonly RuntimeExtension[],
): HubView | undefined {
  const view = extensions.find((item) => item.name === 'hub')?.view;
  return view && typeof view === 'object' ? (view as HubView) : undefined;
}
/** The interface half of the hub extension: its commands, as a page. */
export function HubPage() {
  const { snapshot, runtime, perform } = useRuntime();
  const view = hubView(snapshot.extensions);
  const [address, setAddress] = useState(view?.url || '');
  const [user, setUser] = useState(view?.username || '');
  // Every action is the extension's own /hub command; its lines go to the conversation.
  const run = (args: string) =>
    perform(async () => {
      await runtime.command('hub', args);
    });
  return (
    <Page
      title="hub"
      description="Work handed to a hub from here. The server keeps each task; closing Circle does not stop it."
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
          The hub extension has published nothing yet.
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
          aria-label="hub address"
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
export const hubPlugin: WorkbenchPlugin = {
  id: 'hub',
  apiVersion: 1,
  version: '0.1.0',
  title: 'hub',
  description:
    'Hand work to a hub and follow it: the interface half of the bundled hub extension.',
  icon: Server,
  runtimeExtension: 'hub',
  pages: [
    {
      id: 'hub',
      title: 'hub',
      icon: Server,
      component: HubPage,
    },
  ],
};
