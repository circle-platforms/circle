// The desktop's Node debugger and TypeScript/JavaScript language service.
// It ships with Circle and stays off until `/extensions enable developer`.
// The terminal loads this file as written (Node strips the types). The desktop
// build compiles it to extension.js. The debugger and the language service run
// in the desktop utility process; this entry only marks the extension as on.
import type { ExtensionAPI } from '../../extensions.js';

export async function register(api: ExtensionAPI) {
  api.setView({ provider: 'developer', version: '0.1.0' });
  api.setStatus('ready', 'ok');
}
