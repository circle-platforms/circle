import type { Message } from './types';
import { locale, t, tn } from '../i18n/index.ts';

const READS = ['read_file'];
const EDITS = ['write_file', 'edit_file', 'apply_patch', 'delete'];
const WEB = ['webfetch', 'websearch'];
const name = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/**
 * What a run of tool calls did, in one line: `ran 2 commands, edited calc.py +1 −1`.
 * Lowercase, as the interface words are. A directory listing is not a search.
 */
export function toolSummary(rows: Message[]): {
  text: string;
  added: number;
  removed: number;
} {
  const tools = rows.flatMap((row) => (row.tool ? [row.tool] : []));
  const count = (names: string[]) =>
    tools.filter((tool) => names.includes(tool.name));
  const parts: string[] = [];
  const commands = count(['execute']).length;
  if (commands) parts.push(tn(commands, 'ran a command', 'ran {n} commands'));
  const reads = count(READS);
  if (reads.length === 1 && reads[0]!.filePath)
    parts.push(t('read {file}', { file: name(reads[0]!.filePath) }));
  else if (reads.length)
    parts.push(tn(reads.length, 'read a file', 'read {n} files'));
  const listed = count(['ls']).length;
  if (listed)
    parts.push(tn(listed, 'listed a directory', 'listed {n} directories'));
  const globs = count(['glob']).length;
  if (globs)
    parts.push(tn(globs, 'searched files once', 'searched files {n} times'));
  const greps = count(['grep']).length;
  if (greps) parts.push(tn(greps, 'searched once', 'searched {n} times'));
  const symbols = count(['lsp']).length;
  if (symbols)
    parts.push(tn(symbols, 'looked up a symbol', 'looked up {n} symbols'));
  const edits = count(EDITS);
  const files = [
    ...new Set(edits.map((tool) => tool.filePath).filter(Boolean)),
  ] as string[];
  if (files.length === 1)
    parts.push(t('edited {file}', { file: name(files[0]!) }));
  else if (edits.length)
    parts.push(
      tn(files.length || edits.length, 'edited a file', 'edited {n} files'),
    );
  const agents = count(['task']).length;
  if (agents) parts.push(tn(agents, 'ran a subagent', 'ran {n} subagents'));
  const web = count(WEB).length;
  if (web) parts.push(tn(web, 'used the web once', 'used the web {n} times'));
  const known = [
    'execute',
    'task',
    'ls',
    'glob',
    'grep',
    'lsp',
    ...READS,
    ...EDITS,
    ...WEB,
  ];
  const other = tools.filter((tool) => !known.includes(tool.name));
  const names = [...new Set(other.map((tool) => tool.name))];
  if (names.length && names.length <= 2)
    parts.push(t('used {tools}', { tools: names.join(', ') }));
  else if (other.length)
    parts.push(tn(other.length, 'used a tool', 'used {n} tools'));
  if (!parts.length && rows.some((row) => row.thinking))
    parts.push(t('thinking'));
  let added = 0;
  let removed = 0;
  for (const tool of edits)
    if (tool.diff && tool.status === 'success')
      for (const row of tool.diff.rows) {
        if (row.tone === 'added') added++;
        if (row.tone === 'removed') removed++;
      }
  return {
    text: parts.join(locale() === 'zh-CN' ? '，' : ', '),
    added,
    removed,
  };
}
