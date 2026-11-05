import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { sha256 } from './canonical.js';
import { decodeBase64 } from './protocol.js';
import { scanForCredentials, CREDENTIAL_SCANNER } from './portable/scan.js';
import { textParser } from './portable/parsers/text.js';
import { jsonParser } from './portable/parsers/json.js';
import { markdownParser } from './portable/parsers/markdown.js';
import {
  ParseError,
  QUOTATION_UNITS,
  type Parser,
  type ParsedDocument,
  type QuotationUnit,
} from './portable/parser.js';
import type { SnapshotGraph } from './graph.js';
import type { SyncObject } from './types.js';
import { wellFormedText } from './unicode.js';

export const LOCAL_VERIFIER = 'circle-local-verification@1';
export const WORKSPACE_VERIFIER = 'circle-workspace-verification@1';
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
export function requireClean(bytes: Uint8Array): void {
  const scan = scanForCredentials(bytes);
  if (!scan.clean || scan.truncated)
    throw Error(
      scan.findings.length
        ? `credential rejected: ${JSON.stringify(scan.findings)}`
        : 'credential scan incomplete',
    );
}
export function matchTextQuote(text: string, quote: string): boolean {
  if (
    !wellFormedText(quote) ||
    !/[^\p{White_Space}]/u.test(quote) ||
    !text.includes(quote)
  )
    return false;
  if (!/^[A-Za-z0-9_]+$/.test(quote)) return true;
  let index = text.indexOf(quote);
  while (index !== -1) {
    const before = index > 0 ? text[index - 1]! : '';
    const after =
      index + quote.length < text.length ? text[index + quote.length]! : '';
    if (!/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after))
      return true;
    index = text.indexOf(quote, index + 1);
  }
  return false;
}
export function refineSelectorWithQuote(
  document: ParsedDocument,
  selector: string,
  quotation: string,
): { fragment: { selector: string; text: string }; relocated: boolean } | null {
  const direct = document.locate(selector);
  if (
    !(direct instanceof Promise) &&
    direct &&
    matchTextQuote(direct.text, quotation)
  )
    return {
      fragment: { selector: direct.selector, text: direct.text },
      relocated: false,
    };
  const source = (
    document as {
      [QUOTATION_UNITS]?: (options: { properties: boolean }) => {
        units: readonly QuotationUnit[];
      };
    }
  )[QUOTATION_UNITS]?.({ properties: true });
  if (!source) return null;
  const { units } = source;
  const matchedIndices = new Set<number>();
  for (let i = 0; i < units.length; i++) {
    if (matchTextQuote(units[i]!.text, quotation)) matchedIndices.add(i);
  }
  const hasMatchedDescendant = new Set<number>();
  for (const idx of matchedIndices) {
    let p = units[idx]!.parent;
    while (p >= 0) {
      if (matchedIndices.has(p)) hasMatchedDescendant.add(p);
      p = units[p]!.parent;
    }
  }
  const leaves = [...matchedIndices].filter(
    (idx) => !hasMatchedDescendant.has(idx),
  );
  if (leaves.length !== 1) return null;
  const unit = units[leaves[0]!]!;
  return {
    fragment: { selector: unit.selector, text: unit.text },
    relocated: true,
  };
}
export function checkWorkspaceFreshness(
  workspaceRoot: string,
  source: SyncObject<'source_revision'>,
  relativePath?: string,
): 'fresh' | 'stale' | 'missing' | 'external' {
  if (source.body.media_type.includes('circle-origin=')) return 'external';
  const label = (relativePath ?? source.body.name ?? '').replace(/^\/+/, '');
  if (!label || label.includes('\0') || isAbsolute(label)) return 'external';
  const root = existsSync(workspaceRoot)
    ? realpathSync.native(workspaceRoot)
    : resolve(workspaceRoot);
  const candidate = resolve(root, label);
  const rel = relative(root, candidate);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return 'external';
  if (!existsSync(candidate)) return 'missing';
  try {
    const target = realpathSync.native(candidate);
    const realRel = relative(root, target);
    if (!realRel || realRel.startsWith('..') || isAbsolute(realRel))
      return 'external';
    return sha256(readFileSync(target)) === source.body.raw_sha256
      ? 'fresh'
      : 'stale';
  } catch {
    return 'missing';
  }
}

export function verifyLocal(
  graph: SnapshotGraph,
  priorObservations?: ReadonlyMap<string, Verification>,
): Verification[] {
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
  const conflictedItems = new Set(graph.conflicts.map((c) => c.item_id));
  const sourceBytes = (source: SyncObject<'source_revision'>): Buffer => {
    const bytes = Buffer.concat(
      source.body.chunks.map((id) => {
        const object = graph.objects.get(id);
        if (object?.kind !== 'bytes') throw Error('source unavailable');
        return decodeBase64(object.body.bytes_base64);
      }),
    );
    if (bytes.length !== source.body.size) throw Error('source unavailable');
    return bytes;
  };
  const verify = (id: string, depth = 0): Verification => {
    const kept = results.get(id);
    if (kept) return kept;
    const entry = graph.objects.get(id);
    if (
      priorObservations &&
      entry?.kind === 'entry_revision' &&
      !conflictedItems.has(entry.body.item_id) &&
      graph.paths.get(entry.body.directory_id) != null &&
      entry.body.grounds.length > 0 &&
      entry.body.grounds.every((g) => {
        if (!('source' in g) || !current.has(g.source)) return false;
        const src = graph.objects.get(g.source);
        return (
          src?.kind === 'source_revision' &&
          graph.paths.get(src.body.directory_id) !== null
        );
      })
    ) {
      const prior = priorObservations.get(id);
      if (
        prior &&
        prior.rule === LOCAL_VERIFIER &&
        prior.scanner === CREDENTIAL_SCANNER &&
        !prior.reasons.some(
          (r) =>
            r.code === 'source unavailable or conflicted' ||
            r.code === 'entry conflicted' ||
            r.code === 'entry directory unresolved',
        )
      ) {
        results.set(id, prior);
        return prior;
      }
    }
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
    if (entry?.kind !== 'entry_revision' || depth > 100) {
      observation.reasons.push({ ground: null, code: 'entry unavailable' });
      return observation;
    }
    let incomplete = false;
    const reason = (ground: number | null, code: string, missing = false) => {
      observation.reasons.push({ ground, code });
      incomplete ||= missing;
    };
    if (conflictedItems.has(entry.body.item_id))
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
          else if (!matchTextQuote(parent.body.content.statement, quotation))
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
        const direct = document.locate(ground.selector);
        if (direct instanceof Promise) {
          reason(position, 'parser unavailable', true);
          continue;
        }
        if (!refineSelectorWithQuote(document, ground.selector, quotation))
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
