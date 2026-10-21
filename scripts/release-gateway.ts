import type { Server } from 'node:http';

/** Bind in the dynamic port range, outside Fetch's blocked service ports.
 * listen(0) can choose a blocked port on systems with a custom ephemeral range.
 */
export async function listenReleaseGateway(server: Server): Promise<number> {
  if (server.listening) throw Error('release gateway is already listening');
  for (let port = 49152; port <= 65535; port++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const listening = () => {
          server.off('error', failed);
          resolve();
        };
        const failed = (error: Error) => {
          server.off('listening', listening);
          reject(error);
        };
        server.once('listening', listening);
        server.once('error', failed);
        try {
          server.listen(port, '127.0.0.1');
        } catch (error) {
          server.off('listening', listening);
          server.off('error', failed);
          reject(error);
        }
      });
      return port;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' && code !== 'EACCES') throw error;
    }
  }
  throw Error('no available local port for the release gateway');
}
