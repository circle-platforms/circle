import { browserDiagnostics } from './browser-diagnostics.ts';
import { debug } from './debug.ts';
import { editor } from './editor.ts';
import { app } from './app.ts';
import { common } from './common.ts';
import { components } from './components.ts';
import { conversation } from './conversation.ts';
import { dialogs } from './dialogs.ts';
import { model } from './model.ts';
import { pages } from './pages.ts';
import { panels } from './panels.ts';
import { plugins } from './plugins.ts';

/** Every interface text in Simplified Chinese, keyed by its English. */
export const ZH_CN: Record<string, string> = {
  ...browserDiagnostics,
  ...debug,
  ...common,
  ...editor,
  ...app,
  ...components,
  ...conversation,
  ...dialogs,
  ...model,
  ...pages,
  ...panels,
  ...plugins,
};
