// Components import their stylesheets for Vite. Node unit tests render markup only.
import { registerHooks } from 'node:module';

registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css'))
      return { format: 'module', source: '', shortCircuit: true };
    return next(url, context);
  },
});
