// Helpers shared by the refs tests: fixture loading, a seeded generator and SHA-256.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function fixture(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(
      new URL(`./fixtures/knowledge-parsers/${name}`, import.meta.url),
    ),
  );
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function latin1(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'latin1'));
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Deterministic generator (mulberry32) so property tests are reproducible from their seed. */
export function seeded(seed: number): {
  next(): number;
  int(max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
} {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (max) => Math.floor(next() * max),
    pick: (items) => items[Math.floor(next() * items.length)]!,
    chance: (p) => next() < p,
  };
}

/** Elapsed milliseconds of a synchronous call, with its result or thrown error. */
export function timed<T>(run: () => T): {
  ms: number;
  value: T | null;
  error: unknown;
} {
  const start = performance.now();
  try {
    const value = run();
    return { ms: performance.now() - start, value, error: null };
  } catch (error) {
    return { ms: performance.now() - start, value: null, error };
  }
}
