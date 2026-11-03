import { createHash } from 'node:crypto';
import { McpAuthProvider, keptFor } from '../../../src/mcp_auth.js';
const home = process.argv[2]!,
  server = process.argv[3]!;
try {
  const provider = new McpAuthProvider(
    home,
    server,
    keptFor(home, server).port ?? 0,
  );
  console.log('started');
  const token = await provider.backgroundToken(
    AbortSignal.timeout(10000),
    'synthetic-expired-access',
  );
  console.log(
    JSON.stringify({
      digest: createHash('sha256').update(token).digest('hex'),
      grant: keptFor(home, server).grant_id,
    }),
  );
} catch {
  console.error('synthetic child authorization failed');
  process.exitCode = 1;
}
