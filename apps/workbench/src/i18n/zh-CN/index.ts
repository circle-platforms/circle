import { nativeGit } from './native-git.ts';
import { taskPanel } from './task-panel.ts';
import { developer } from './developer.ts';
import { terminal } from './terminal.ts';
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
  ...taskPanel,
  ...nativeGit,
  ...developer,
  ...terminal,
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
