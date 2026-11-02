// Adapted from Circle Hub contracts/src/sync-canonical.ts (Apache-2.0), without a Hub or Zod dependency.
import { createHash } from 'node:crypto';
import { SYNC_LIMITS, isObjectId, validateSync } from './protocol.js';
import { parseStrictJson } from './strict-json.js';
import type { SyncObject } from './types.js';
import { wellFormedText } from './unicode.js';

export const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');
export function normalizeSyncText(value: string): string {
  if (!wellFormedText(value)) throw new TypeError('malformed Unicode');
  return value
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .normalize('NFC');
}
function canonical(value: unknown, depth = 0): string {
  if (depth > 64) throw new TypeError('sync nesting limit');
  if (value === null) return 'null';
  if (typeof value === 'string')
    return JSON.stringify(normalizeSyncText(value));
  if (typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return '[' + value.map((v) => canonical(v, depth + 1)).join(',') + ']';
  if (
    value &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  ) {
    const mapped = new Map<string, unknown>();
    for (const [key, item] of Object.entries(value)) {
      const normalized = normalizeSyncText(key);
      if (mapped.has(normalized))
        throw new TypeError('normalized member collision');
      mapped.set(normalized, item);
    }
    return (
      '{' +
      [...mapped.keys()]
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) + ':' + canonical(mapped.get(key), depth + 1),
        )
        .join(',') +
      '}'
    );
  }
  throw new TypeError('non-JSON sync value');
}
export function encodeSyncObject(input: unknown): Buffer {
  validateSync('personal-sync-object@1', input);
  const bytes = Buffer.from(canonical(input));
  if (bytes.length > SYNC_LIMITS.objectBytes)
    throw new RangeError('sync object size');
  validateSync('personal-sync-object@1', JSON.parse(bytes.toString('utf8')));
  return bytes;
}
export const syncObjectId = (input: unknown): string =>
  sha256(encodeSyncObject(input));
export function decodeSyncObject(
  bytes: Uint8Array,
  expected: string,
): SyncObject {
  if (bytes.byteLength > SYNC_LIMITS.objectBytes)
    throw new RangeError('sync object size');
  if (!isObjectId(expected)) throw new TypeError('invalid object identity');
  const value = parseStrictJson(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
  );
  const encoded = encodeSyncObject(value);
  if (!Buffer.from(bytes).equals(encoded))
    throw new TypeError('noncanonical sync object');
  if (sha256(encoded) !== expected)
    throw new TypeError('sync object hash mismatch');
  return value as SyncObject;
}
