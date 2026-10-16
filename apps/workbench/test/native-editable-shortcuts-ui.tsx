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
Object.assign(window, { editRuntime: runtime, editRequests: requests });
createRoot(document.getElementById('root')!).render(
  <CircleWorkbench runtime={runtime} plugins={circlePlugins} />,
);
