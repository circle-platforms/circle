// Which MCP revision Circle speaks with a server. By default it asks a server reached over Streamable HTTP, and a
// program it starts, whether it speaks the 2026-07-28 revision (`server/discover`), and connects with the older
// handshake (`initialize`) when it does not. What a program answered is kept for 7 days in the Circle home, so a
// program that speaks only the older revision is not asked again in that time: asking one costs a start of the
// program, and one that does not answer is waited for. CIRCLE_MCP_PROTOCOL_NEGOTIATION changes that: `auto` asks
// every time, `legacy` never asks.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { formatJcs } from './knowledge/canonical.js';
import { ensureHome } from './paths.js';
import {
  isRecord,
  readJson,
  withPrivateJsonLock,
  writePrivateJson,
} from './settings.js';

/** The revision a connection speaks: 2026-07-28 or later, or one before it. */
export type Era = 'modern' | 'legacy';
/** How Circle asks: by default, asking every time, or never. */
export type Negotiation = 'default' | 'auto' | 'legacy';
/** The file in the Circle home that keeps what programs answered. */
export const MCP_PROTOCOL_FILE = 'mcp-protocol.json';
/** How long a program's answer is kept. */
export const REMEMBER_MS = 7 * 24 * 60 * 60_000;

/** CIRCLE_MCP_PROTOCOL_NEGOTIATION as Circle reads it: `auto` or `legacy`, else the default. */
export function negotiationSetting(
  env: NodeJS.ProcessEnv = process.env,
): Negotiation {
  const value = env.CIRCLE_MCP_PROTOCOL_NEGOTIATION?.trim().toLowerCase();
  return value === 'auto' || value === 'legacy' ? value : 'default';
}

/**
 * What a program is known by: a digest of its command, arguments and environment as its entry writes them, with their
 * references (`${VAR}`) unfilled, so no value of a secret is in it, and the folder it runs in.
 */
export function programKey(program: {
  command: string;
  args: string[];
  env?: Record<string, string>;
  folder: string;
}): string {
  return createHash('sha256')
    .update(
      formatJcs([
        program.command,
        program.args,
        program.env ?? {},
        program.folder,
      ]),
    )
    .digest('hex');
}

interface Kept {
  era: Era;
  /** When it answered, in milliseconds since the epoch. */
  at: number;
}

function keptAnswers(home: string): Record<string, Kept> {
  let raw: unknown;
  try {
    raw = readJson(join(home, MCP_PROTOCOL_FILE));
  } catch {
    return {};
  }
  if (!isRecord(raw) || !isRecord(raw.programs)) return {};
  const answers: Record<string, Kept> = {};
  for (const [key, value] of Object.entries(raw.programs))
    if (
      isRecord(value) &&
      (value.era === 'modern' || value.era === 'legacy') &&
      typeof value.at === 'number' &&
      Number.isFinite(value.at)
    )
      answers[key] = { era: value.era, at: value.at };
  return answers;
}

/** What a program answered within the last 7 days, or nothing. An answer from the future is not believed. */
export function rememberedEra(
  home: string,
  key: string,
  now: number,
): Era | undefined {
  const kept = keptAnswers(home)[key];
  return kept && kept.at <= now && now - kept.at < REMEMBER_MS
    ? kept.era
    : undefined;
}

/** Keeps what a program answered, and forgets answers older than 7 days. */
export function rememberEra(
  home: string,
  key: string,
  era: Era,
  now: number,
): void {
  ensureHome(home);
  const path = join(home, MCP_PROTOCOL_FILE);
  withPrivateJsonLock(path, () => {
    const programs = Object.fromEntries(
      Object.entries(keptAnswers(home)).filter(
        ([, kept]) => kept.at <= now && now - kept.at < REMEMBER_MS,
      ),
    );
    programs[key] = { era, at: now };
    writePrivateJson(path, { programs });
  });
}
