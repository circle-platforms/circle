// Adapted from Circle Hub (Apache-2.0); see provenance.json.
// markdown@1: Markdown as written by pandoc and CommonMark tools. A heading tree (ATX and setext headings) over raw text
// blocks: paragraphs, lists, block quotes, code, HTML blocks, thematic breaks and tables (pipe tables and pandoc grid,
// multiline and simple tables), each kept verbatim. U+0000 is removed from texts but not from byte ranges.
// Selectors: `h/<heading>/<heading>...` is a section (the heading path from the top), `b/<k>[/<heading>...]` is block k
// (0-based) directly inside that section, or before the first heading when no path is given. A heading segment is the
// heading text with white space collapsed; `[k]` (from 1) is appended when the text repeats among siblings, when the
// text itself ends in `[digits]`, or when it is empty. A section or block whose selector would be longer than
// MAX_SELECTOR_LENGTH has none (selector null): it cannot be cited.
// Every block also carries `path`: the decoded heading segments of its section, spelled exactly as in its `h/` selector
// (`[]` before the first heading, null when the section has no selector), so a reader sees the section path without
// decoding the selector.
import {
  QUOTATION_UNITS,
  checkSize,
  depthError,
  effectiveLimits,
  nodesError,
  selectorCharsError,
  type ByteRange,
  type Fragment,
  type JsonObject,
  type ParsedDocument,
  type Parser,
  type ParseLimits,
  type ParseOptions,
  type QuotationSource,
  type QuotationUnit,
} from '../parser.js';
import {
  MAX_SELECTOR_LENGTH,
  selectorSegment,
  trySelectorSegments,
} from '../reference.js';
import {
  countNul,
  decodeDeclared,
  removeNul,
  splitLines,
} from '../text-decoding.js';

const KEY = 'markdown@1';
// Nodes are lines (the finest unit); depth is the heading nesting depth.
const LIMITS: Readonly<ParseLimits> = {
  maxBytes: 16 * 1024 * 1024,
  maxDepth: 6,
  maxNodes: 1_000_000,
};
const INDEX = /^(?:0|[1-9][0-9]{0,8})$/;
const STEP = /^(.*)\[([1-9][0-9]{0,8})\]$/s;
const ENDS_IN_ORDINAL = /\[[0-9]+\]$/;

export type MarkdownSection = {
  /** 0 for the document itself (index 0), 1-6 for headings. */
  level: number;
  /** Heading text as written, NUL removed. */
  title: string;
  /** Heading text with white space collapsed: the selector key. */
  key: string;
  ordinal: number;
  parent: number | null;
  children: number[];
  blocks: number[];
  /** Line index (0-based) of the heading. */
  line: number;
  /** Last line index of the section, subsections included. */
  end: number;
  /** Null for the document itself, and for a section whose heading path is too long to cite. */
  selector: string | null;
  /** A trailing pandoc attribute block such as `{#id .class}`, or null. */
  attributes: string | null;
};

export type MarkdownBlock = {
  /** CommonMark or pandoc block type. */
  kind: string;
  section: number;
  /** Position among the blocks directly inside the section. */
  index: number;
  /** First line index (0-based). */
  line: number;
  lines: number;
  text: string;
  /** Null when the block's section has no selector or the block selector would be too long to cite. */
  selector: string | null;
  /**
   * The heading path of the block's section: the decoded segments of its `h/` selector (`[]` for blocks before the
   * first heading), null when the section has no selector. Optional so models written by hand still type-check.
   */
  path?: string[] | null;
};

export type MarkdownModel = {
  charset: string;
  lines: number;
  sections: MarkdownSection[];
  blocks: MarkdownBlock[];
  nulRemoved: number;
};

type Item =
  | { heading: true; level: number; title: string; start: number; end: number }
  | { heading: false; kind: string; start: number; end: number };

const BLOCK_HTML = new Set(
  (
    'address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset ' +
    'figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem ' +
    'nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul'
  ).split(' '),
);

function isBlank(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 0x20 && c !== 0x09) return false;
  }
  return true;
}

/** Indentation in columns, tabs to the next multiple of 4. */
function indentOf(line: string): number {
  let columns = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 0x20) columns++;
    else if (c === 0x09) columns += 4 - (columns % 4);
    else break;
  }
  return columns;
}

function isSpaceOrTab(code: number): boolean {
  return code === 0x20 || code === 0x09;
}

/** The text without leading and trailing spaces and tabs (loops: a regular expression backtracks on long runs). */
function trimSpacesAndTabs(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isSpaceOrTab(text.charCodeAt(start))) start++;
  while (end > start && isSpaceOrTab(text.charCodeAt(end - 1))) end--;
  return text.slice(start, end);
}

/** An ATX heading: up to three spaces, one to six `#`, then white space or the end; an optional closing `#` run is dropped. */
function atxHeading(line: string): { level: number; title: string } | null {
  let i = 0;
  while (i < 3 && line.charCodeAt(i) === 0x20) i++;
  let level = 0;
  while (line.charCodeAt(i + level) === 0x23) level++;
  if (level < 1 || level > 6) return null;
  const rest = i + level;
  if (rest < line.length && !isSpaceOrTab(line.charCodeAt(rest))) return null;
  // The closing sequence: a run of `#` at the end (before trailing spaces or tabs), at the start or after a space or tab.
  let end = line.length;
  while (end > rest && isSpaceOrTab(line.charCodeAt(end - 1))) end--;
  let hashes = end;
  while (hashes > rest && line.charCodeAt(hashes - 1) === 0x23) hashes--;
  const closed =
    hashes < end &&
    (hashes === rest || isSpaceOrTab(line.charCodeAt(hashes - 1)));
  return {
    level,
    title: trimSpacesAndTabs(line.slice(rest, closed ? hashes : end)),
  };
}

/** A trailing pandoc attribute block such as `{#id .class}` (no braces inside), split from the text before it. */
function attributeBlock(
  raw: string,
): { title: string; attributes: string } | null {
  let end = raw.length;
  while (end > 0 && isSpaceOrTab(raw.charCodeAt(end - 1))) end--;
  if (end < 3 || raw.charCodeAt(end - 1) !== 0x7d) return null;
  let open = end - 2;
  while (
    open >= 0 &&
    raw.charCodeAt(open) !== 0x7b &&
    raw.charCodeAt(open) !== 0x7d
  )
    open--;
  if (open < 0 || raw.charCodeAt(open) !== 0x7b) return null;
  const marker = raw.charCodeAt(open + 1);
  if (marker !== 0x23 && marker !== 0x2e && marker !== 0x2d) return null;
  let start = open;
  while (start > 0 && isSpaceOrTab(raw.charCodeAt(start - 1))) start--;
  return { title: raw.slice(0, start), attributes: raw.slice(open, end) };
}

type Fence = { char: string; length: number };

function fenceOpen(line: string): Fence | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  if (match[1]![0]! === '`' && match[2]!.includes('`')) return null;
  return { char: match[1]![0]!, length: match[1]!.length };
}

function fenceCloses(line: string, fence: Fence): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return (
    match !== null &&
    match[1]![0]! === fence.char &&
    match[1]!.length >= fence.length
  );
}

function thematicBreak(line: string): boolean {
  return /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(
    line,
  );
}

function setextLevel(line: string): number {
  const match = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
  return match ? (match[1]![0]! === '=' ? 1 : 2) : 0;
}

function listItem(
  line: string,
): { ordered: boolean; start: number; empty: boolean } | null {
  const match = /^ {0,3}([-+*]|([0-9]{1,9})[.)])([ \t]|$)/.exec(line);
  if (!match) return null;
  return {
    ordered: match[2]! !== undefined,
    start: match[2]! === undefined ? 0 : Number(match[2]!),
    empty: isBlank(line.slice(match[0]!.length)),
  };
}

function blockQuote(line: string): boolean {
  return /^ {0,3}>/.test(line);
}

/** CommonMark HTML block type 1-7 starting at this line, or 0. */
function htmlBlockType(line: string): number {
  if (!/^ {0,3}</.test(line)) return 0;
  if (/^ {0,3}<(?:script|pre|style|textarea)(?:[ \t>]|$)/i.test(line)) return 1;
  if (/^ {0,3}<!--/.test(line)) return 2;
  if (/^ {0,3}<\?/.test(line)) return 3;
  if (/^ {0,3}<![A-Za-z]/.test(line)) return 4;
  if (/^ {0,3}<!\[CDATA\[/.test(line)) return 5;
  const tag = /^ {0,3}<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t]|\/?>|$)/.exec(line);
  if (tag && BLOCK_HTML.has(tag[1]!.toLowerCase())) return 6;
  if (/^ {0,3}<\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t][^<>]*)?\/?>[ \t]*$/.test(line))
    return 7;
  return 0;
}

const HTML_END: { [type: number]: RegExp } = {
  1: /<\/(?:script|pre|style|textarea)>/i,
  2: /-->/,
  3: /\?>/,
  4: />/,
  5: /\]\]>/,
};

function gridBorder(line: string): boolean {
  return /^ {0,3}\+(?:[-=:]+\+)+[ \t]*$/.test(line);
}

function gridRow(line: string): boolean {
  return /^ {0,3}[+|]/.test(line);
}

function fullDash(line: string): boolean {
  return /^[ \t]*-{3,}[ \t]*$/.test(line);
}

/** Two or more runs of '-' separated by spaces (pandoc simple and multiline table rules). */
function dashGroups(line: string): boolean {
  let groups = 0;
  let inGroup = false;
  let i = 0;
  while (i < line.length && (line[i]! === ' ' || line[i]! === '\t')) i++;
  let end = line.length;
  while (end > i && (line[end - 1]! === ' ' || line[end - 1]! === '\t')) end--;
  if (i >= end) return false;
  for (; i < end; i++) {
    const c = line[i]!;
    if (c === '-') {
      if (!inGroup) groups++;
      inGroup = true;
    } else if (c === ' ') inGroup = false;
    else return false;
  }
  return groups >= 2;
}

function hasPipe(line: string): boolean {
  for (let i = line.indexOf('|'); i >= 0; i = line.indexOf('|', i + 1))
    if (i === 0 || line[i - 1]! !== '\\') return true;
  return false;
}

function delimiterRow(line: string): boolean {
  if (!line.includes('|')) return false;
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|')) body = body.slice(0, -1);
  const cells = body.split('|');
  return (
    cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell.trim()))
  );
}

function segmentFor(key: string, ordinal: number): string {
  return ordinal > 1 || key === '' || ENDS_IN_ORDINAL.test(key)
    ? `${key}[${ordinal}]`
    : key;
}

function parse(
  bytes: Uint8Array,
  options: ParseOptions = {},
): ParsedDocument<MarkdownModel> {
  const limits = effectiveLimits(LIMITS, options);
  checkSize(KEY, bytes, limits);
  const decoded = decodeDeclared(KEY, bytes, options.mediaType);
  const { text, offsets } = decoded;
  const split = splitLines(text, limits.maxNodes);
  if (split === null) throw nodesError(KEY, limits.maxNodes);
  const { starts, ends } = split;
  const n = starts.length;
  const lines = starts.map((start, i) => text.slice(start, ends[i]!));
  // Fragment texts are slices of the text without U+0000; NULs never sit in a line terminator, so counting them per
  // line is enough to map line starts and ends into it.
  const nulRemoved = countNul(text);
  const clean = nulRemoved === 0 ? text : text.replaceAll('\u0000', '');
  const nulBefore = nulRemoved === 0 ? null : new Int32Array(n);
  const nulThrough = nulRemoved === 0 ? null : new Int32Array(n);
  if (nulBefore !== null && nulThrough !== null) {
    // One forward pass over the NUL positions: each is visited once, whatever the number of lines.
    let seen = 0;
    let at = text.indexOf('\u0000');
    for (let i = 0; i < n; i++) {
      while (at >= 0 && at < starts[i]!) {
        seen++;
        at = text.indexOf('\u0000', at + 1);
      }
      nulBefore[i]! = seen;
      while (at >= 0 && at < ends[i]!) {
        seen++;
        at = text.indexOf('\u0000', at + 1);
      }
      nulThrough[i]! = seen;
    }
  }
  const cleanStart = (line: number): number =>
    starts[line]! - (nulBefore === null ? 0 : nulBefore[line]!);
  const cleanEnd = (line: number): number =>
    ends[line]! - (nulThrough === null ? 0 : nulThrough[line]!);

  // Ends of pandoc multiline and headerless tables, built on demand from right to left, so each start is checked in constant time.
  const INF = 0x7fffffff;
  let nextClose: Int32Array | null = null;
  let nextDoubleBlank: Int32Array | null = null;
  let nextGroups: Int32Array | null = null;
  const multilineEnd = (i: number): number => {
    if (i + 2 >= n || isBlank(lines[i + 1]!)) return -1;
    if (nextClose === null) {
      nextClose = new Int32Array(n + 2).fill(INF);
      nextDoubleBlank = new Int32Array(n + 2).fill(INF);
      nextGroups = new Int32Array(n + 2).fill(INF);
      for (let k = n - 1; k >= 0; k--) {
        const line = lines[k]!;
        const groups = dashGroups(line);
        const dash = groups || fullDash(line);
        const blank = !dash && isBlank(line);
        nextClose[k] =
          dash && (k + 1 >= n || isBlank(lines[k + 1]!))
            ? k
            : nextClose[k + 1]!;
        nextDoubleBlank[k] =
          blank && k + 1 < n && isBlank(lines[k + 1]!)
            ? k
            : nextDoubleBlank[k + 1]!;
        nextGroups[k] = groups ? k : nextGroups[k + 1]!;
      }
    }
    const j = nextClose[i + 2]!;
    if (j === INF || nextDoubleBlank![i + 1]! < j) return -1;
    return dashGroups(lines[i]!) || nextGroups![i + 1]! <= j ? j : -1;
  };
  const htmlInterrupts = (line: string): boolean => {
    const type = htmlBlockType(line);
    return type >= 1 && type <= 6;
  };
  const startsBlock = (line: string): boolean =>
    atxHeading(line) !== null ||
    fenceOpen(line) !== null ||
    thematicBreak(line) ||
    listItem(line) !== null ||
    blockQuote(line) ||
    htmlInterrupts(line);
  const interruptsParagraph = (line: string): boolean => {
    if (
      atxHeading(line) ||
      fenceOpen(line) ||
      thematicBreak(line) ||
      blockQuote(line) ||
      gridBorder(line)
    )
      return true;
    const item = listItem(line);
    if (item && !item.empty && (!item.ordered || item.start === 1)) return true;
    return htmlInterrupts(line);
  };

  const items: Item[] = [];
  const block = (kind: string, start: number, end: number): void => {
    items.push({ heading: false, kind, start, end });
  };
  let i = 0;
  if (n > 1 && /^---[ \t]*$/.test(lines[0]!) && !isBlank(lines[1]!)) {
    for (let j = 1; j < n; j++) {
      if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[j]!)) {
        block('yaml_metadata_block', 0, j);
        i = j + 1;
        break;
      }
    }
  }
  outer: while (i < n) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fence = fenceOpen(line);
    if (fence) {
      let j = i + 1;
      while (j < n && !fenceCloses(lines[j]!, fence)) j++;
      const end = j < n ? j : n - 1;
      block('code_block', i, end);
      i = end + 1;
      continue;
    }
    const atx = atxHeading(line);
    if (atx) {
      items.push({
        heading: true,
        level: atx.level,
        title: atx.title,
        start: i,
        end: i,
      });
      i++;
      continue;
    }
    if (gridBorder(line)) {
      let j = i + 1;
      while (j < n && gridRow(lines[j]!)) j++;
      block('table', i, j - 1);
      i = j;
      continue;
    }
    if (fullDash(line) || dashGroups(line)) {
      const end = multilineEnd(i);
      if (end >= 0) {
        block('table', i, end);
        i = end + 1;
        continue;
      }
    }
    const html = htmlBlockType(line);
    if (html > 0) {
      let end = i;
      if (html <= 5) {
        while (end < n - 1 && !HTML_END[html]!.test(lines[end]!)) end++;
      } else {
        while (end + 1 < n && !isBlank(lines[end + 1]!)) end++;
      }
      block('html_block', i, end);
      i = end + 1;
      continue;
    }
    if (thematicBreak(line)) {
      block('thematic_break', i, i);
      i++;
      continue;
    }
    if (blockQuote(line)) {
      let j = i + 1;
      while (
        j < n &&
        !isBlank(lines[j]!) &&
        (blockQuote(lines[j]!) || !startsBlock(lines[j]!))
      )
        j++;
      block('block_quote', i, j - 1);
      i = j;
      continue;
    }
    if (listItem(line)) {
      const base = indentOf(line);
      let end = i;
      let j = i + 1;
      while (j < n) {
        const next = lines[j]!;
        if (isBlank(next)) {
          let k = j;
          while (k < n && isBlank(lines[k]!)) k++;
          if (
            k < n &&
            (listItem(lines[k]!) !== null || indentOf(lines[k]!) > base) &&
            !thematicBreak(lines[k]!)
          ) {
            j = k;
            continue;
          }
          break;
        }
        if (
          atxHeading(next) ||
          thematicBreak(next) ||
          (indentOf(next) <= base &&
            (fenceOpen(next) !== null || htmlInterrupts(next)))
        )
          break;
        end = j;
        j++;
      }
      block('list', i, end);
      i = end + 1;
      continue;
    }
    if (indentOf(line) >= 4) {
      let last = i;
      let j = i + 1;
      while (j < n && (isBlank(lines[j]!) || indentOf(lines[j]!) >= 4)) {
        if (!isBlank(lines[j]!)) last = j;
        j++;
      }
      block('code_block', i, last);
      i = last + 1;
      continue;
    }
    if (i + 1 < n && hasPipe(line) && delimiterRow(lines[i + 1]!)) {
      let j = i + 2;
      while (j < n && !isBlank(lines[j]!) && !startsBlock(lines[j]!)) j++;
      block('table', i, j - 1);
      i = j;
      continue;
    }
    if (i + 1 < n && dashGroups(lines[i + 1]!)) {
      let j = i + 2;
      while (j < n && !isBlank(lines[j]!)) j++;
      block('table', i, j - 1);
      i = j;
      continue;
    }
    let j = i + 1;
    while (j < n) {
      const next = lines[j]!;
      if (isBlank(next)) break;
      const level = setextLevel(next);
      if (level > 0) {
        const title = lines.slice(i, j).map(trimSpacesAndTabs).join('\n');
        items.push({ heading: true, level, title, start: i, end: j });
        i = j + 1;
        continue outer;
      }
      if (interruptsParagraph(next)) break;
      j++;
    }
    block('paragraph', i, j - 1);
    i = j;
  }

  // Heading tree.
  const sections: MarkdownSection[] = [
    {
      level: 0,
      title: '',
      key: '',
      ordinal: 1,
      parent: null,
      children: [],
      blocks: [],
      line: 0,
      end: n - 1,
      selector: null,
      attributes: null,
    },
  ];
  const blocks: MarkdownBlock[] = [];
  // Encoded heading path of each section (segments joined with `/`), built once from the parent's; null when too long.
  const paths: Array<string | null> = [''];
  // The same paths decoded (the segments as written, before selector encoding), shared by the blocks of each section.
  const decodedPaths: Array<string[] | null> = [[]];
  const childKeys: Array<Map<string, number[]>> = [new Map()];
  const order: Array<[boolean, number]> = [];
  const open: number[] = [0];
  let selectorChars = 0;
  const counted = (selector: string | null): string | null => {
    if (
      selector !== null &&
      (selectorChars += selector.length) > limits.maxSelectorChars
    )
      throw selectorCharsError(KEY, limits.maxSelectorChars);
    return selector;
  };
  const close = (index: number, next: number): void => {
    let end = next - 1;
    while (end > sections[index]!.line && isBlank(lines[end]!)) end--;
    sections[index]!.end = end;
  };
  for (const item of items) {
    if (item.heading) {
      while (
        open.length > 1 &&
        sections[open[open.length - 1]!]!.level >= item.level
      )
        close(open.pop()!, item.start);
      const parent = open[open.length - 1]!;
      if (open.length > limits.maxDepth)
        throw depthError(KEY, limits.maxDepth, offsets.at(starts[item.start]!));
      const raw = removeNul(item.title);
      const attribute = attributeBlock(raw);
      const title = attribute ? attribute.title : raw;
      // Heading keys are stable parser identities; quotation whitespace must not change their grammar.
      const key = title
        .replace(/\p{White_Space}+/gu, ' ')
        .replace(/^ | $/g, '');
      const siblings = childKeys[parent]!.get(key) ?? [];
      const ordinal = siblings.length + 1;
      const index = sections.length;
      siblings.push(index);
      childKeys[parent]!.set(key, siblings);
      const above = paths[parent]!;
      const segment = selectorSegment(segmentFor(key, ordinal));
      const length =
        above === null
          ? Infinity
          : 2 + (above === '' ? 0 : above.length + 1) + segment.length;
      const path =
        above === null || length > MAX_SELECTOR_LENGTH
          ? null
          : above === ''
            ? segment
            : `${above}/${segment}`;
      paths.push(path);
      decodedPaths.push(
        path === null
          ? null
          : [...(decodedPaths[parent]! as string[]), segmentFor(key, ordinal)],
      );
      childKeys.push(new Map());
      sections.push({
        level: item.level,
        title,
        key,
        ordinal,
        parent,
        children: [],
        blocks: [],
        line: item.start,
        end: n - 1,
        selector: counted(path === null ? null : `h/${path}`),
        attributes: attribute ? attribute.attributes : null,
      });
      sections[parent]!.children.push(index);
      open.push(index);
      order.push([true, index]);
    } else {
      const owner = open[open.length - 1]!;
      const index = blocks.length;
      const position = sections[owner]!.blocks.length;
      sections[owner]!.blocks.push(index);
      const path = paths[owner]!;
      const head = `b/${position}`;
      const selector =
        path === null
          ? null
          : path === ''
            ? head
            : head.length + 1 + path.length > MAX_SELECTOR_LENGTH
              ? null
              : `${head}/${path}`;
      blocks.push({
        kind: item.kind,
        section: owner,
        index: position,
        line: item.start,
        lines: item.end - item.start + 1,
        text: clean.slice(cleanStart(item.start), cleanEnd(item.end)),
        selector: counted(selector),
        path: decodedPaths[owner]!,
      });
      order.push([false, index]);
    }
  }
  while (open.length > 1) close(open.pop()!, n);
  const model: MarkdownModel = {
    charset: decoded.charset,
    lines: n,
    sections,
    blocks,
    nulRemoved,
  };

  const range = (start: number, end: number): ByteRange => [
    offsets.at(starts[start]!),
    offsets.at(ends[end]!),
  ];
  const sectionFragment = (index: number, selector: string): Fragment => {
    const section = sections[index]!;
    const titles: string[] = [];
    for (
      let at: number | null = index;
      at !== null && at > 0;
      at = sections[at]!.parent
    )
      titles.push(sections[at]!.title);
    return {
      selector,
      text: clean.slice(cleanStart(section.line), cleanEnd(section.end)),
      byteRange: range(section.line, section.end),
      data: {
        level: section.level,
        title: section.title,
        path: titles.reverse(),
        blocks: section.blocks.length,
        subsections: section.children.map((child) => sections[child]!.selector),
        line: section.line + 1,
        attributes: section.attributes,
      },
    };
  };
  const blockFragment = (index: number, selector: string): Fragment => {
    const item = blocks[index]!;
    return {
      selector,
      text: item.text,
      byteRange: range(item.line, item.line + item.lines - 1),
      data: {
        kind: item.kind,
        section: sections[item.section]!.selector,
        line: item.line + 1,
        lines: item.lines,
      },
    };
  };
  const findSection = (path: string[]): number | null => {
    let current = 0;
    for (const step of path) {
      const match = STEP.exec(step);
      const key = match ? match[1]! : step;
      const ordinal = match ? Number(match[2]!) : 1;
      const found = childKeys[current]!.get(key);
      if (!found || ordinal > found.length) return null;
      current = found[ordinal - 1]!;
    }
    return current;
  };

  const document: ParsedDocument<MarkdownModel> & QuotationSource = {
    parser: KEY,
    model,
    locate(selector) {
      const segments = trySelectorSegments(selector);
      if (!segments || segments.length < 2) return null;
      if (segments[0]! === 'h') {
        const index = findSection(segments.slice(1));
        const canonical =
          index === null || index === 0 ? null : sections[index]!.selector;
        return canonical === null ? null : sectionFragment(index!, canonical);
      }
      if (segments[0]! === 'b' && INDEX.test(segments[1]!)) {
        const owner = findSection(segments.slice(2));
        if (owner === null) return null;
        const index = sections[owner]!.blocks[Number(segments[1]!)]!;
        const canonical = index === undefined ? null : blocks[index]!.selector;
        return canonical === null ? null : blockFragment(index, canonical);
      }
      return null;
    },
    listSelectors(prefix = '', options = {}) {
      const limit = options.limit ?? Number.POSITIVE_INFINITY;
      const out: string[] = [];
      for (const [isSection, index] of order) {
        if (out.length >= limit) break;
        const selector = isSection
          ? sections[index]!.selector
          : blocks[index]!.selector;
        if (selector !== null && selector.startsWith(prefix))
          out.push(selector);
      }
      return out;
    },
    [QUOTATION_UNITS]() {
      // Sections and blocks in document order, each a slice of the text without NUL; a section encloses its blocks
      // and subsections, so a sentence across two blocks resolves to the section around them.
      const units: QuotationUnit[] = [];
      const sectionUnit = new Int32Array(sections.length).fill(-1);
      for (const [isSection, index] of order) {
        if (isSection) {
          const section = sections[index]!;
          if (section.selector === null) continue;
          const start = cleanStart(section.line);
          const end = cleanEnd(section.end);
          sectionUnit[index]! = units.length;
          units.push({
            selector: section.selector,
            text: clean.slice(start, end),
            byteRange: range(section.line, section.end),
            parent: sectionUnit[section.parent ?? 0]!,
            start,
            end,
          });
        } else {
          const item = blocks[index]!;
          if (item.selector === null) continue;
          const start = cleanStart(item.line);
          const end = cleanEnd(item.line + item.lines - 1);
          units.push({
            selector: item.selector,
            text: item.text,
            byteRange: range(item.line, item.line + item.lines - 1),
            parent: sectionUnit[item.section]!,
            start,
            end,
          });
        }
      }
      return { stream: clean, units };
    },
    summary() {
      const kinds: JsonObject = {};
      for (const item of blocks)
        kinds[item.kind]! =
          ((kinds[item.kind]! as number | undefined) ?? 0) + 1;
      const levels: JsonObject = {};
      const depths = new Int32Array(sections.length);
      let depth = 0;
      for (let index = 1; index < sections.length; index++) {
        const section = sections[index]!;
        levels[String(section.level)]! =
          ((levels[String(section.level)]! as number | undefined) ?? 0) + 1;
        depths[index]! = depths[section.parent ?? 0]! + 1;
        if (depths[index]! > depth) depth = depths[index]!;
      }
      return {
        parser: KEY,
        charset: decoded.charset,
        lines: n,
        sections: sections.length - 1,
        blocks: blocks.length,
        kinds,
        levels,
        depth,
        nulRemoved: model.nulRemoved,
      };
    },
  };
  return document;
}

export const markdownParser: Parser<MarkdownModel> = {
  id: 'markdown',
  version: 1,
  mediaTypes: ['text/markdown', 'text/x-markdown'],
  limits: LIMITS,
  parse,
};
