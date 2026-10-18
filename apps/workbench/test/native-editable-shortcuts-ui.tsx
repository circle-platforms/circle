import { createRoot } from 'react-dom/client';
import { CircleWorkbench } from '../src/workbench';
import { PreviewRuntime } from '../src/model/state';
import { circlePlugins } from '../src/plugins/builtins';
import { setLanguage } from '../src/i18n';
setLanguage('en');
const runtime = new PreviewRuntime();
const requests: unknown[] = [];
const original = runtime.request.bind(runtime);
runtime.request = (kind, payload) => {
  requests.push({ kind, payload });
  return original(kind, payload);
};
const commands: string[] = [];
const command = runtime.command.bind(runtime);
runtime.command = (name, ...rest) => {
  commands.push(name);
  return command(name, ...rest);
};
Object.assign(window, {
  editRuntime: runtime,
  editRequests: requests,
  editCommands: commands,
});
createRoot(document.getElementById('root')!).render(
  <CircleWorkbench runtime={runtime} plugins={circlePlugins} />,
);
