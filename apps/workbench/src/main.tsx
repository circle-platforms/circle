import { desktopHost } from './host';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { CircleWorkbench } from './workbench';
import { PreviewRuntime } from './model/state';
import { LiveRuntime } from './model/live';
import type { RuntimePort } from './model/types';
import { circlePlugins } from './plugins/builtins';
import { popoutRoute } from './model/popouts';
import { PopoutApp } from './popout/PopoutApp';
import { RuntimeProvider } from './app/context';
import { applyTheme } from './theme';
import { loadLanguage, locale, subscribeLanguage } from './i18n';
// How far start-up got, for a window that stays blank: each step names
// what it waits for.
const boot = (step: string) => {
  document.documentElement.dataset.boot = step;
};
/** A storage that can be read but keeps nothing written to it. */
function readOnlyStorage(): Storage {
  return {
    get length() {
      return localStorage.length;
    },
    key: (index) => localStorage.key(index),
    getItem: (key) => localStorage.getItem(key),
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  };
}
async function start() {
  boot('host');
  const host = desktopHost();
  let runtime: RuntimePort;
  const info = host ? await host.info() : undefined;
  boot('runtime');
  if (host && info) {
    document.documentElement.dataset.desktop = info.platform;
    document.documentElement.dataset.host = 'desktop';
    // A window a mode was popped out into reads the runtime but writes nothing of the
    // view (drafts, scroll) to the storage the main window keeps them in.
    const storage = popoutRoute(location.hash)
      ? readOnlyStorage()
      : localStorage;
    runtime = info.frontendOnly
      ? new PreviewRuntime(storage)
      : new LiveRuntime(host, await host.runtimeState(), storage);
    if (runtime.mode === 'live') {
      boot('subscribe');
      // Subscribe before reading again so updates during bootstrap cannot be missed.
      await host.runtimeCommand({
        id: crypto.randomUUID(),
        name: 'state',
        payload: {},
      });
    }
  } else runtime = new PreviewRuntime(localStorage);
  applyTheme(
    runtime.getSnapshot().settings.theme,
    runtime.getSnapshot().settings.textSize,
  );
  loadLanguage(localStorage, info?.language);
  // Menus, system dialogs and notifications follow the window's language.
  void host?.setLanguage(locale());
  subscribeLanguage(() => void host?.setLanguage(locale()));
  boot('render');
  const popout = popoutRoute(location.hash);
  if (popout) document.documentElement.dataset.popout = popout.kind;
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      {popout ? (
        <RuntimeProvider runtime={runtime}>
          <PopoutApp kind={popout.kind} sessionId={popout.sessionId} />
        </RuntimeProvider>
      ) : (
        <CircleWorkbench runtime={runtime} plugins={circlePlugins} />
      )}
    </React.StrictMode>,
  );
}
void start();
