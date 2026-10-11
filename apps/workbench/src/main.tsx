import { desktopHost } from './host';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { CircleWorkbench } from './workbench';
import { PreviewRuntime } from './model/state';
import { LiveRuntime } from './model/live';
import type { RuntimePort } from './model/types';
import { PlatformPreviewService } from './plugins/platform/store';
import { defaultPlugins } from './plugins/builtins';
import { applyTheme } from './theme';
const services = { platform: new PlatformPreviewService(localStorage) };
async function start() {
  const host = desktopHost();
  let runtime: RuntimePort;
  if (host) {
    const info = await host.info();
    document.documentElement.dataset.desktop = info.platform;
    document.documentElement.dataset.host = 'desktop';
    runtime = info.frontendOnly
      ? new PreviewRuntime(localStorage)
      : new LiveRuntime(host, await host.runtimeState(), localStorage);
    if (runtime.mode === 'live') {
      // Subscribe before reading again so updates during bootstrap cannot be missed.
      await host.runtimeCommand({
        id: crypto.randomUUID(),
        name: 'state',
        payload: {},
      });
    }
  } else runtime = new PreviewRuntime(localStorage);
  applyTheme(runtime.getSnapshot().settings.theme);
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <CircleWorkbench
        runtime={runtime}
        plugins={defaultPlugins}
        services={services}
      />
    </React.StrictMode>,
  );
}
void start();
