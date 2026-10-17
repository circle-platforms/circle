import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';
import { useRuntime } from '../app/context';
import { t } from '../i18n';
import { platformTitle } from './labels';
import { PluginRegistry, effectivePlugins } from './registry';
import type { ServiceRegistry, WorkbenchPlugin, PluginService } from './types';
interface Value {
  registry: PluginRegistry;
  services: ServiceRegistry;
  enabled: string[];
  toggle: (id: string, enabled: boolean) => void;
}
const Context = createContext<Value | null>(null);
export function PluginProvider({
  plugins,
  services,
  children,
}: {
  plugins: WorkbenchPlugin[];
  services: ServiceRegistry;
  children: ReactNode;
}) {
  const { snapshot, runtime, perform } = useRuntime();
  const registry = useMemo(() => new PluginRegistry(plugins), [plugins]);
  const enabled = effectivePlugins(
    registry.plugins,
    snapshot.uiPlugins,
    snapshot.extensions,
  );
  return (
    <Context.Provider
      value={{
        registry,
        services,
        enabled,
        toggle: (id, enabled) => {
          const plugin = registry.plugins.find((item) => item.id === id);
          // A paired page has its own switch. Turning it on turns the shared
          // runtime extension on; turning the last one off turns that extension off.
          if (plugin?.runtimeExtension) {
            const name = plugin.runtimeExtension;
            perform(async () => {
              if (runtime.mode !== 'live')
                throw Error(t('this interface needs the Circle runtime'));
              if (!snapshot.extensions.some((item) => item.name === name))
                throw Error(
                  t('runtime extension {name} is not installed', {
                    name: platformTitle(name),
                  }),
                );
              let reload = false;
              runtime.change((state) => {
                const row = state.extensions.find((item) => item.name === name);
                if (!row) return;
                const chosen = registry.change(
                  state.uiPlugins.filter((item) =>
                    registry.plugins.some((candidate) => candidate.id === item),
                  ),
                  id,
                  enabled,
                );
                state.uiPlugins = chosen;
                const still = registry.plugins.some(
                  (item) =>
                    item.runtimeExtension === name && chosen.includes(item.id),
                );
                reload = row.enabled !== still;
                row.enabled = still;
              });
              if (reload) await runtime.request('reload', {});
            });
            return;
          }
          perform(() =>
            runtime.change((state) => {
              state.uiPlugins = registry.change(
                state.uiPlugins.filter((id) =>
                  registry.plugins.some((plugin) => plugin.id === id),
                ),
                id,
                enabled,
              );
            }),
          );
        },
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function usePlugins() {
  const value = useContext(Context);
  if (!value) throw Error('PluginProvider is required');
  return value;
}
export function usePluginService<T extends PluginService>(id: string): T {
  const { services } = usePlugins();
  const service = services[id];
  if (!service) throw Error('service not supplied: ' + id);
  return service as T;
}
