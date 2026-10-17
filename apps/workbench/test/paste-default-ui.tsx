import { createRoot } from 'react-dom/client';
import { CircleWorkbench } from '../src/workbench';
import { PreviewRuntime } from '../src/model/state';
import { circlePlugins } from '../src/plugins/builtins';
import { setLanguage } from '../src/i18n';
setLanguage('en');
const runtime = new PreviewRuntime();
Object.assign(window, { pasteRuntime: runtime });
createRoot(document.getElementById('root')!).render(
  <CircleWorkbench runtime={runtime} plugins={circlePlugins} />,
);
