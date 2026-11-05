import { HashRouter } from 'react-router-dom';
import { App } from './app/App';
import { RuntimeProvider } from './app/context';
import { PluginProvider } from './plugins/context';
import type { RuntimePort } from './model/types';
import type { WorkbenchPlugin, ServiceRegistry } from './plugins/types';
import { useLocale } from './i18n';
import './styles/app.css';
import './styles/workbench-unified.css';
// Subscribe to language changes without replacing mounted editors and resources.
function LocalizedApp() {
  useLocale();
  return <App />;
}
/** Hosts inject the Circle session port and independent, versioned component plugins. */
export function CircleWorkbench({
  runtime,
  plugins,
  services = {},
}: {
  runtime: RuntimePort;
  plugins: WorkbenchPlugin[];
  services?: ServiceRegistry;
}) {
  return (
    <RuntimeProvider runtime={runtime}>
      <PluginProvider plugins={plugins} services={services}>
        <HashRouter>
          <LocalizedApp />
        </HashRouter>
      </PluginProvider>
    </RuntimeProvider>
  );
}
export type { RuntimePort } from './model/types';
export type { WorkbenchPlugin, ServiceRegistry } from './plugins/types';
