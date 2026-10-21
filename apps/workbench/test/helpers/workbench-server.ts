import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { createServer, type ViteDevServer } from 'vite';

type Cleanup = (close: () => Promise<unknown>) => void;

/** Register ownership before setup can fail, and attempt every close in reverse order. */
export function workbenchCleanup(t: TestContext): Cleanup {
  const closes: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    const errors: unknown[] = [];
    for (const close of closes.reverse()) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(errors, 'workbench cleanup failed');
  });
  return (close) => closes.push(close);
}

/**
 * Compiles the window's whole module graph, lazy panels included, and waits for it:
 * a test's limits then measure the interface, not a slow runner's first on-demand
 * compile (the Intel macOS runner took longer than 30 s).
 */
export async function warmModules(
  server: ViteDevServer,
  entry = '/src/main.tsx',
): Promise<number> {
  const warmed = new Set<string>();
  const warm = async (url: string): Promise<void> => {
    if (warmed.has(url)) return;
    warmed.add(url);
    await server.transformRequest(url);
    const node = await server.moduleGraph.getModuleByUrl(url);
    await Promise.all(
      [...(node?.importedModules ?? [])].map((child) => warm(child.url)),
    );
  };
  await warm(entry);
  return warmed.size;
}

/**
 * The window's Vite server, with an optimizer cache and Circle folders of its own in
 * `scratch`, compiled before it is returned. Each test file runs in its own process, so
 * the environment it sets reaches only this server.
 */
export async function workbenchServer(
  scratch: string,
  port: number,
  cleanup: Cleanup,
): Promise<ViteDevServer> {
  // vite.config.ts reads this when the server is created: a cache of its own, and
  // dependencies optimized before the server answers.
  process.env.CIRCLE_COMPONENT_UI_EVIDENCE = scratch;
  process.env.CIRCLE_HOME = join(scratch, 'home');
  process.env.CIRCLE_WORKBENCH_DATA_DIR = join(scratch, 'desktop');
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const server = await createServer({
    root,
    configFile: join(root, 'vite.config.ts'),
    server: { host: '127.0.0.1', port, strictPort: true },
    logLevel: 'error',
  });
  cleanup(() => server.close());
  await server.listen();
  await warmModules(server);
  return server;
}
