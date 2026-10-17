import '../src/styles/app.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Tooltip } from 'radix-ui';
import { RuntimeProvider } from '../src/app/context';
import { PluginProvider } from '../src/plugins/context';
import { PreviewRuntime } from '../src/model/state';
import { Conversation } from '../src/features/Conversation';
import { setLanguage } from '../src/i18n';
import { applyTheme } from '../src/theme';
setLanguage('en');
applyTheme('light');
const runtime = new PreviewRuntime(localStorage);
if (!localStorage.getItem('reading-anchor-seeded')) {
  runtime.change((snapshot) => {
    const base = snapshot.sessions[0];
    const make = (id: string, length: number) => ({
      ...structuredClone(base),
      id,
      title: id,
      messages: Array.from({ length }, (_, index) => ({
        id: `${id}-${index}`,
        parentId: index ? `${id}-${index - 1}` : null,
        role: 'assistant' as const,
        at: '12:00',
        text:
          `Reading anchor ${index}\n\n` +
          Array.from(
            { length: 1 + (index % 5) },
            (_, row) =>
              `Variable height row ${row}: ` +
              'words '.repeat(3 + (index % 17)),
          ).join('\n\n'),
      })),
      leafId: `${id}-${length - 1}`,
      branchIds: undefined,
      hiddenIds: [],
      presentation: undefined,
      draft: 'unchanged manual draft',
      attachments: [],
      queue: [],
      state: 'idle' as const,
    });
    snapshot.sessions = [make('history', 10000), make('alternate', 1)];
    snapshot.activeSessionId = 'history';
  });
  localStorage.setItem('reading-anchor-seeded', 'true');
}
Object.assign(window, { readingRuntime: runtime });
function Fixture() {
  const [source, setSource] = useState(false);
  const [finding, setFinding] = useState(false);
  return (
    <Tooltip.Provider>
      <RuntimeProvider runtime={runtime}>
        <PluginProvider plugins={[]} services={{}}>
          <div
            style={{
              height: '100vh',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div>
              <button onClick={() => runtime.selectSession('history')}>
                history
              </button>
              <button onClick={() => runtime.selectSession('alternate')}>
                alternate
              </button>
              <button onClick={() => setSource((value) => !value)}>
                {source ? 'close source' : 'open source and remount'}
              </button>
            </div>
            {source ? (
              <div>
                Source placeholder; conversation is deliberately unmounted for
                recovery coverage.
              </div>
            ) : (
              <Conversation
                onDialog={() => {}}
                onPanel={() => {}}
                onAgent={() => {}}
                onFile={() => setSource(true)}
                onAttach={() => {}}
                onCommand={() => {}}
                finding={finding}
                setFinding={setFinding}
              />
            )}
          </div>
        </PluginProvider>
      </RuntimeProvider>
    </Tooltip.Provider>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
