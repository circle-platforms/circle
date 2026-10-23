import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

interface DownloadOptions {
  attempts?: number;
  pauseMs?: number;
  request?: typeof fetch;
  pause?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

const sha256 = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

// A release build downloads the pinned Node.js once. A dropped connection or a busy
// server on the way must not fail it, so those are tried again, each time after twice
// the pause before (2 s up to 32 s, a minute in all); a missing file is not. The
// caller checks the archive against its SHA-256 either way.
export async function downloadRuntime(
  url: string,
  {
    attempts = 6,
    pauseMs = 2000,
    request = fetch,
    pause = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
    log = (line: string) => console.error(line),
  }: DownloadOptions = {},
): Promise<Buffer> {
  for (let attempt = 1; ; attempt++) {
    let final = false;
    try {
      const response = await request(url, {
        signal: AbortSignal.timeout(120_000),
      });
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      final = ![408, 429].includes(response.status) && response.status < 500;
      throw new Error(`runtime download failed: ${response.status} ${url}`);
    } catch (error) {
      if (final || attempt >= attempts) throw error;
      const wait = pauseMs * 2 ** (attempt - 1);
      const failure = error as Error & {
        cause?: { code?: string; message?: string };
      };
      const cause = failure.cause?.code ?? failure.cause?.message;
      log(
        `${url}: ${failure.message}${cause ? ` (${cause})` : ''}; trying again in ${wait / 1000} s, attempt ${attempt + 1} of ${attempts}`,
      );
      await pause(wait);
    }
  }
}

/**
 * The pinned runtime archive, kept on disk between builds. A release run builds
 * six targets, and each one used to download the same archive again; #279 was a
 * release that an unreachable nodejs.org took down, retries notwithstanding.
 * An entry is used only while its SHA-256 matches the pinned digest — the check
 * a fresh download gets — and one that does not match is downloaded again
 * rather than trusted. A download whose digest does not match is never cached.
 */
export async function downloadRuntimeCached(
  url: string,
  cachePath: string,
  expectedSha256: string,
  options: DownloadOptions = {},
): Promise<Buffer> {
  const log = options.log ?? ((line: string) => console.error(line));
  if (existsSync(cachePath)) {
    const cached = readFileSync(cachePath);
    if (sha256(cached) === expectedSha256) {
      log(`${url}: using the cached archive at ${cachePath}`);
      return cached;
    }
    log(`${url}: the cached archive at ${cachePath} fails its digest check`);
  }
  const bytes = await downloadRuntime(url, options);
  if (sha256(bytes) !== expectedSha256)
    throw new Error('runtime checksum does not match pinned digest');
  mkdirSync(dirname(cachePath), { recursive: true });
  const staging = `${cachePath}.tmp-${process.pid}`;
  writeFileSync(staging, bytes);
  renameSync(staging, cachePath);
  return bytes;
}
