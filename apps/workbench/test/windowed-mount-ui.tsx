import { createRoot } from 'react-dom/client';
import { useRef, useLayoutEffect } from 'react';
import { WindowedList } from '../src/components/WindowedList';
import '../src/styles/app.css';
import { CircleWorkbench } from '../src/workbench';
import { PreviewRuntime } from '../src/model/state';
import { createFixtures } from '../src/preview/fixtures';
import { applyTheme } from '../src/theme';
import { setLanguage } from '../src/i18n';
const items = Array.from({ length: 10000 }, (_, index) => ({
  id: index,
  text: index === 9999 ? 'PERF_HISTORY_READY' : 'history ' + index,
}));
function Transcript() {
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = scroller.current!;
    const follow = () =>
      node.scrollTo({ top: node.scrollHeight, behavior: 'instant' });
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(node.firstElementChild!);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      className="transcript"
      ref={scroller}
      style={{ height: 400, flex: 'none' }}
    >
      <div className="transcript-column">
        <WindowedList
          items={items}
          itemKey={(item) => String(item.id)}
          scrollRef={scroller}
          renderItem={(item) => (
            <div style={{ height: 80 }} data-message={item.id}>
              {item.text}
            </div>
          )}
        />
      </div>
    </div>
  );
}
const data = createFixtures();
const session = data.sessions[0];
session.messages = items.map((item, index) => ({
  id: String(item.id),
  parentId: index ? String(index - 1) : null,
  role: index % 2 ? 'assistant' : 'user',
  text: item.text,
  at: 'fixture',
}));
session.branchIds = items.map((item) => String(item.id));
session.leafId = '9999';
session.state = 'idle';
session.presentation = undefined;
data.interactions = [];
data.requests = [];
data.agents = [];
data.jobs = [];
data.runtime = undefined;
const runtime = new PreviewRuntime({
  getItem: () => JSON.stringify(data),
  setItem: () => {},
  removeItem: () => {},
});
location.hash = '/session/' + session.id;
applyTheme('light');
setLanguage('en');
createRoot(document.getElementById('root')!).render(
  new URLSearchParams(location.search).has('full') ? (
    <CircleWorkbench runtime={runtime} plugins={[]} />
  ) : (
    <Transcript />
  ),
);
