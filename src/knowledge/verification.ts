import { sha256 } from './canonical.js';
import { decodeBase64 } from './protocol.js';
import { scanForCredentials, CREDENTIAL_SCANNER } from './portable/scan.js';
import { textParser } from './portable/parsers/text.js';
import { jsonParser } from './portable/parsers/json.js';
import { markdownParser } from './portable/parsers/markdown.js';
import {
  ParseError,
  type Parser,
  type ParsedDocument,
} from './portable/parser.js';
import type { KnowledgeGraph } from './graph.js';
import type { SyncObject } from './types.js';
import { wellFormedText } from './unicode.js';

export const LOCAL_VERIFIER = 'circle-local-verification@1';
export interface Verification {
  object: string;
  rule: typeof LOCAL_VERIFIER;
  scanner: string;
  status: 'verified' | 'unverified';
  outcome: 'matched' | 'mismatch' | 'incomplete';
  reasons: { ground: number | null; code: string }[];
  parsers: string[];
}
const parsers = new Map<string, Parser>(
  [textParser, jsonParser, markdownParser].map((p) => [
    `${p.id}@${p.version}`,
    p,
  ]),
);
/** Errors contain detector/position only; never include rejected text, paths or library error details. */
export function requireClean(bytes: Uint8Array): void {
  const scan = scanForCredentials(bytes);
  if (!scan.clean || scan.truncated)
    throw Error(
      scan.findings.length
        ? `credential rejected: ${JSON.stringify(scan.findings)}`
        : 'credential scan incomplete',
    );
}
export const exactQuotation = (text: string, quote: string): boolean =>
  wellFormedText(quote) &&
  /[^\p{White_Space}]/u.test(quote) &&
  text.includes(quote);

/** Local observations confer no Hub read/share authority and are never copied into immutable object bodies. */
export function verifyLocal(graph: KnowledgeGraph): Verification[] {
  const results = new Map<string, Verification>();
  const documents = new Map<string, ParsedDocument>();
  let inspectedBytes = 0;
  const reserve = (bytes: number) => {
    inspectedBytes += bytes;
    if (inspectedBytes > 64 * 1024 * 1024)
      throw Error('local verification work limit');
  };
  const current = new Set(
    graph.items.filter((i) => i.heads.length === 1).flatMap((i) => i.heads),
  );
  const sourceBytes = (source: SyncObject<'source_revision'>): Buffer => {
    const bytes = Buffer.concat(
      source.body.chunks.map((id) => {
        const object = graph.objects.get(id);
        if (object?.kind !== 'bytes') throw Error('source unavailable');
        return decodeBase64(object.body.bytes_base64);
      }),
    );
    if (
      sha256(bytes) !== source.body.raw_sha256 ||
      bytes.length !== source.body.size
    )
      throw Error('source unavailable');
    return bytes;
  };
  const verify = (id: string, depth = 0): Verification => {
    const kept = results.get(id);
    if (kept) return kept;
    const observation: Verification = {
      object: id,
      rule: LOCAL_VERIFIER,
      scanner: CREDENTIAL_SCANNER,
      status: 'unverified',
      outcome: 'incomplete',
      reasons: [],
      parsers: [],
    };
    results.set(id, observation);
    const entry = graph.objects.get(id);
    if (entry?.kind !== 'entry_revision' || depth > 100) {
      observation.reasons.push({ ground: null, code: 'entry unavailable' });
      return observation;
    }
    let incomplete = false;
    const reason = (ground: number | null, code: string, missing = false) => {
      observation.reasons.push({ ground, code });
      incomplete ||= missing;
    };
    if (graph.conflicts.some((c) => c.item_id === entry.body.item_id))
      reason(null, 'entry conflicted', true);
    if (graph.paths.get(entry.body.directory_id) == null)
      reason(null, 'entry directory unresolved', true);
    try {
      const content = Buffer.from(JSON.stringify(entry.body.content));
      reserve(content.length);
      requireClean(content);
    } catch {
      reason(null, 'credential rejected', true);
    }
    if (!entry.body.grounds.length) reason(null, 'no grounds', true);
    for (const [position, ground] of entry.body.grounds.entries()) {
      try {
        const quote = graph.objects.get(ground.quotation);
        if (quote?.kind !== 'bytes') {
          reason(position, 'quotation unavailable', true);
          continue;
        }
        const quoteBytes = decodeBase64(quote.body.bytes_base64);
        reserve(quoteBytes.length);
        requireClean(quoteBytes);
        const quotation = new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: true,
        }).decode(quoteBytes);
        if ('reference' in ground) {
          reason(position, 'authorized remote resolver unavailable', true);
          continue;
        }
        if ('entry' in ground) {
          const parent = graph.objects.get(ground.entry);
          if (
            !current.has(ground.entry) ||
            parent?.kind !== 'entry_revision' ||
            verify(ground.entry, depth + 1).status !== 'verified'
          )
            reason(position, 'cited entry unavailable or unverified', true);
          else if (!exactQuotation(parent.body.content.statement, quotation))
            reason(position, 'quotation mismatch');
          continue;
        }
        observation.parsers.push(ground.parser);
        const parser = parsers.get(ground.parser);
        if (!parser) {
          reason(position, 'parser unavailable', true);
          continue;
        }
        const source = graph.objects.get(ground.source);
        if (
          source?.kind !== 'source_revision' ||
          !current.has(ground.source) ||
          graph.paths.get(source.body.directory_id) === null
        ) {
          reason(position, 'source unavailable or conflicted', true);
          continue;
        }
        const key = ground.source + '/' + ground.parser;
        let document = documents.get(key);
        if (!document) {
          reserve(source.body.size);
          const bytes = sourceBytes(source);
          requireClean(bytes);
          document = parser.parse(bytes, {
            mediaType: source.body.media_type,
            maxNodes: 100000,
          });
          documents.set(key, document);
        }
        const fragment = document.locate(ground.selector);
        if (fragment instanceof Promise) {
          reason(position, 'parser unavailable', true);
          continue;
        }
        if (!fragment || !exactQuotation(fragment.text, quotation))
          reason(position, 'quotation mismatch');
      } catch (error) {
        reason(
          position,
          error instanceof ParseError
            ? 'source unparseable'
            : 'source read or scan incomplete',
          true,
        );
      }
    }
    observation.parsers = [...new Set(observation.parsers)].sort();
    if (!observation.reasons.length) {
      observation.status = 'verified';
      observation.outcome = 'matched';
    } else observation.outcome = incomplete ? 'incomplete' : 'mismatch';
    return observation;
  };
  for (const item of graph.items)
    if (item.kind === 'entry_revision' && item.heads.length === 1)
      verify(item.heads[0]!);
  return [...results.values()];
}
