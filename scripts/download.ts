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
  }: {
    attempts?: number;
    pauseMs?: number;
    request?: typeof fetch;
    pause?: (ms: number) => Promise<void>;
    log?: (line: string) => void;
  } = {},
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
