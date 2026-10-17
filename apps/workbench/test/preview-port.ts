import { createServer } from 'node:net';

/**
 * Port for a workbench preview in a test.
 * Pass `CIRCLE_WORKBENCH_TEST_PORT` to pin one. Otherwise the OS hands out a
 * free port, so a leftover vite on 4217 does not fail the run.
 */
export function previewPort(preferred?: string): Promise<number> {
  if (preferred !== undefined && preferred !== '') {
    const port = Number(preferred);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      return Promise.reject(new Error(`${preferred} is not a port`));
    return Promise.resolve(port);
  }
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('no free port'));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}
