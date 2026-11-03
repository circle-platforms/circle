// Adapted unchanged test cases from pinned Circle Hub (Apache-2.0).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ParseEncodingError,
  ParseLimitError,
  ParseSyntaxError,
} from '../src/knowledge/portable/parser.js';
import {
  MAX_SELECTOR_LENGTH,
  selectorSegment,
} from '../src/knowledge/portable/reference.js';
import {
  markdownParser,
  type MarkdownModel,
} from '../src/knowledge/portable/parsers/markdown.js';
import { fixture, latin1, timed, utf8 } from './knowledge-parser-support.js';

const bytes = fixture('spec.md');
const spec = markdownParser.parse(bytes);
const model: MarkdownModel = spec.model;

function kinds(markdown: string): Array<[string, string]> {
  const document = markdownParser.parse(utf8(markdown));
  return document.model.blocks.map((block) => [block.kind, block.text]);
}

describe('markdown@1 on the pandoc-style spec fixture', () => {
  it('builds the heading tree', () => {
    const sections = model.sections.slice(1).map((section) => section.selector);
    assert.deepEqual(sections, [
      'h/概述',
      'h/概述/术语',
      'h/概述/功能说明',
      'h/概述/功能说明/会话保持',
      'h/概述/功能说明/超时',
      'h/概述/功能说明/超时[2]',
      'h/概述/配置示例[2][1]',
      'h/概述/配置命令示例',
      'h/附录',
      'h/附录/[1]',
    ]);
    assert.equal(model.sections[1]!.attributes, '{#overview}');
    assert.equal(model.sections[1]!.title, '概述');
    assert.equal(model.sections[8]!.level, 2, 'setext heading');
  });

  it('keeps tables, lists, quotes and code as verbatim blocks', async () => {
    const summary = spec.summary();
    assert.deepEqual(summary.kinds, {
      yaml_metadata_block: 1,
      paragraph: 8,
      table: 4,
      list: 2,
      code_block: 2,
      block_quote: 1,
      thematic_break: 1,
    });
    const grid = (await spec.locate('b/0/概述/术语'))!;
    assert.equal((grid.data as { kind: string }).kind, 'table');
    assert.ok(grid.text.startsWith('+--------------+'));
    assert.ok(grid.text.includes('一个池里可以有多个后端。'));
    assert.equal(
      (await spec.locate('b/0/概述/功能说明/超时'))!.text.split('\n').length,
      3,
      'pipe table',
    );
    const multiline = (await spec.locate('b/0/概述/配置示例[2][1]'))!;
    assert.equal(
      (multiline.data as { lines: number }).lines,
      8,
      'multiline table with blank lines between rows',
    );
    assert.ok(
      multiline.text.endsWith(
        '缺省为 10。\n-------------------------------------------------------------',
      ),
    );
    assert.equal(
      ((await spec.locate('b/2/概述/配置示例[2][1]'))!.data as { kind: string })
        .kind,
      'table',
      'simple table',
    );
    assert.equal(
      (await spec.locate('b/1/概述/功能说明/会话保持'))!.text,
      '- 按源地址保持\n- 按 Cookie 保持\n  - Cookie 名称可配置\n- 按请求头保持',
    );
    assert.equal(
      (await spec.locate('b/4/概述/配置示例[2][1]'))!.text,
      '> 注意：修改模式会中断现有会话。\n请在维护窗口操作。',
    );
  });

  it('does not take a # line inside a code fence for a heading', async () => {
    const code = (await spec.locate('b/2/概述/功能说明/超时'))!;
    assert.equal((code.data as { kind: string }).kind, 'code_block');
    assert.ok(code.text.includes('# 这一行不是标题'));
    assert.ok(
      !model.sections.some((section) =>
        section.title.includes('这一行不是标题'),
      ),
    );
  });

  it('locates sections with their subsections and blocks by heading path and index', async () => {
    const section = (await spec.locate('h/概述/功能说明'))!;
    assert.ok(section.text.startsWith('## 功能说明'));
    assert.ok(
      section.text.includes('第二个同名小节'),
      'a section spans its subsections',
    );
    assert.ok(!section.text.includes('配置示例'));
    assert.deepEqual((section.data as { subsections: string[] }).subsections, [
      'h/概述/功能说明/会话保持',
      'h/概述/功能说明/超时',
      'h/概述/功能说明/超时[2]',
    ]);
    assert.equal(
      (await spec.locate('b/0/概述/功能说明/超时[2]'))!.text,
      '第二个同名小节，用来检验同名标题的序号。',
    );
    assert.equal(
      (await spec.locate('h/概述/功能说明/超时[1]'))!.selector,
      'h/概述/功能说明/超时',
    );
    assert.equal(
      (await spec.locate('b/0'))!.text.split('\n')[0]!,
      '---',
      'blocks before the first heading',
    );
    assert.equal((await spec.locate('b/0/附录/[1]'))!.text, '空标题的小节。');
    const [from, to] = section.byteRange!;
    assert.ok(
      Buffer.from(bytes)
        .subarray(from, to)
        .toString('utf8')
        .startsWith('## 功能说明'),
    );
    for (const selector of [
      'h',
      'h/不存在',
      'h/概述/超时',
      'h/概述/配置示例[2]',
      'b/9/概述',
      'b/x/概述',
      'b/01/概述',
      'q/概述',
    ])
      assert.equal(await spec.locate(selector), null, selector);
  });

  it('lists every section and block in document order', async () => {
    const selectors = spec.listSelectors();
    assert.equal(
      selectors.length,
      model.sections.length - 1 + model.blocks.length,
    );
    for (const selector of selectors)
      assert.equal((await spec.locate(selector))!.selector, selector, selector);
    assert.deepEqual(spec.listSelectors('h/附录'), ['h/附录', 'h/附录/[1]']);
  });

  it('keeps full-width characters and NBSP as written', async () => {
    const last = (await spec.locate('b/2/附录/[1]'))!;
    assert.equal(
      last.text,
      '全角字符：ＡＢＣ，全角空格：前　后。不换行空格：甲 乙。',
    );
  });
});

describe('markdown@1 behaviour', () => {
  it('removes NUL from texts but keeps byte ranges on the original bytes', async () => {
    const text = '# 标题\u0000一\n\n段落\u0000\u0000文字\n';
    const document = markdownParser.parse(utf8(text));
    assert.equal(document.model.nulRemoved, 3);
    assert.equal((await document.locate('h/标题一'))!.selector, 'h/标题一');
    const block = (await document.locate('b/0/标题一'))!;
    assert.equal(block.text, '段落文字');
    const [from, to] = block.byteRange!;
    assert.equal(
      Buffer.from(utf8(text)).subarray(from, to).toString('utf8'),
      '段落\u0000\u0000文字',
    );
  });

  it('handles CRLF, CR and a byte order mark', async () => {
    const document = markdownParser.parse(
      new Uint8Array([
        0xef,
        0xbb,
        0xbf,
        ...utf8('# A\r\n\r\npara\r\nmore\r# B\r\rtext'),
      ]),
    );
    assert.deepEqual(document.listSelectors(), [
      'h/A',
      'b/0/A',
      'h/B',
      'b/0/B',
    ]);
    assert.equal((await document.locate('b/0/A'))!.text, 'para\r\nmore');
    const [from] = (await document.locate('h/A'))!.byteRange!;
    assert.equal(from, 3);
  });

  it('collapses white space in heading keys', () => {
    const document = markdownParser.parse(
      utf8('#   2.1  安装   步骤 ##\n\ntext\n'),
    );
    assert.deepEqual(document.listSelectors(), [
      'h/2.1%20安装%20步骤',
      'b/0/2.1%20安装%20步骤',
    ]);
    assert.equal(document.model.sections[1]!.title, '2.1  安装   步骤');
  });

  it('recognizes the CommonMark block structure', () => {
    assert.deepEqual(
      kinds(
        'para one\nstill one\n\n***\n\n> quote\n\n    code\n\n<div>\nhtml\n</div>\n\n1. a\n2. b\n',
      ),
      [
        ['paragraph', 'para one\nstill one'],
        ['thematic_break', '***'],
        ['block_quote', '> quote'],
        ['code_block', '    code'],
        ['html_block', '<div>\nhtml\n</div>'],
        ['list', '1. a\n2. b'],
      ],
    );
    assert.deepEqual(kinds('text\n- item\n'), [
      ['paragraph', 'text'],
      ['list', '- item'],
    ]);
    assert.deepEqual(kinds('text\n2. not a list start\n'), [
      ['paragraph', 'text\n2. not a list start'],
    ]);
    assert.deepEqual(kinds('~~~\nunclosed fence\n# not a heading'), [
      ['code_block', '~~~\nunclosed fence\n# not a heading'],
    ]);
  });

  it('reads setext headings and does not mistake table rules for them', () => {
    const document = markdownParser.parse(
      utf8('Title\n=====\n\nSub\n---\n\n  a    b\n  ---  ---\n  1    2\n'),
    );
    assert.deepEqual(
      document.model.sections.slice(1).map((s) => [s.level, s.title]),
      [
        [1, 'Title'],
        [2, 'Sub'],
      ],
    );
    assert.equal(document.model.blocks[0]!.kind, 'table');
  });

  it('decodes a declared single-byte charset and refuses others', () => {
    const document = markdownParser.parse(latin1('# Café\n'), {
      mediaType: 'text/markdown; charset=ISO-8859-1',
    });
    assert.equal(document.model.sections[1]!.title, 'Café');
    assert.throws(
      () => markdownParser.parse(latin1('# Café\n')),
      ParseEncodingError,
    );
    assert.throws(
      () =>
        markdownParser.parse(utf8('# x'), {
          mediaType: 'text/markdown; charset=koi8-r',
        }),
      ParseEncodingError,
    );
  });

  it('enforces its limits', () => {
    assert.throws(
      () => markdownParser.parse(utf8('a\n'.repeat(100)), { maxNodes: 50 }),
      (e: unknown) => e instanceof ParseLimitError && e.limit === 'maxNodes',
    );
    assert.throws(
      () => markdownParser.parse(utf8('# a\n## b\n### c\n'), { maxDepth: 2 }),
      (e: unknown) => e instanceof ParseLimitError && e.limit === 'maxDepth',
    );
    assert.throws(
      () => markdownParser.parse(utf8('x'.repeat(100)), { maxBytes: 99 }),
      (e: unknown) => e instanceof ParseLimitError && e.limit === 'maxBytes',
    );
  });
});

describe('markdown@1 on hostile headings', () => {
  const BOUND_MS = 1_500;
  function parsed(
    markdown: string,
    options = {},
  ): ReturnType<typeof markdownParser.parse> {
    const outcome = timed(() => markdownParser.parse(utf8(markdown), options));
    assert.ok(
      outcome.ms < BOUND_MS,
      `${markdown.slice(0, 30)}... took ${outcome.ms.toFixed(0)} ms`,
    );
    if (outcome.error !== null) throw outcome.error;
    return outcome.value!;
  }

  it('cleans headings with long runs of spaces or tabs in linear time', () => {
    const run = ' '.repeat(200_000);
    assert.equal(parsed(`# a${run}b`).model.sections[1]!.title, `a${run}b`);
    assert.equal(
      parsed(`# a${run}b${run}`).model.sections[1]!.title,
      `a${run}b`,
    );
    assert.equal(
      parsed(`# a${run}b${run}##${run}`).model.sections[1]!.title,
      `a${run}b`,
      'the closing sequence goes',
    );
    assert.equal(
      parsed(`a${'\t'.repeat(200_000)}b\n===\n`).model.sections[1]!.title,
      `a${'\t'.repeat(200_000)}b`,
    );
    assert.equal(parsed(`# {#${run}x`).model.sections[1]!.attributes, null);
    const attributed = parsed(`# Title${run}{#id .x}${run}`).model.sections[1]!;
    assert.deepEqual(
      [attributed.title, attributed.attributes],
      ['Title', '{#id .x}'],
    );
  });

  it('reads closing sequences and attribute blocks as CommonMark and pandoc do', () => {
    const titles = (markdown: string): Array<[string, string | null]> =>
      parsed(markdown)
        .model.sections.slice(1)
        .map((s) => [s.title, s.attributes]);
    assert.deepEqual(
      titles(
        '# foo #\n## bar ###   \n### baz#\n#### qux \\#\n##### ##\n###### #x {#a}\n',
      ),
      [
        ['foo', null],
        ['bar', null],
        ['baz#', null],
        ['qux \\#', null],
        ['', null],
        ['#x', '{#a}'],
      ],
    );
    assert.deepEqual(
      titles('# a {.b}\n# c {}\n# d { #e}\n# f {#g}x\n# h {-}\n'),
      [
        ['a', '{.b}'],
        ['c {}', null],
        ['d { #e}', null],
        ['f {#g}x', null],
        ['h', '{-}'],
      ],
    );
    assert.equal(
      parsed('####### seven\n').model.sections.length,
      1,
      'seven # are not a heading',
    );
    assert.equal(parsed('    # code\n').model.blocks[0]!.kind, 'code_block');
  });

  it('gives no selector to a section or block whose heading path is too long, and stays linear', async () => {
    const document = parsed(
      `# ${'h'.repeat(20_000)}\n\n${'p\n\n'.repeat(40_000)}# short\n\ntext\n`,
    );
    const { sections, blocks } = document.model;
    assert.equal(sections[1]!.selector, null);
    assert.equal(blocks.length, 40_001);
    assert.ok(
      blocks.slice(0, 40_000).every((block) => block.selector === null),
    );
    assert.deepEqual(document.listSelectors(), ['h/short', 'b/0/short']);
    assert.equal(await document.locate(`h/${'h'.repeat(4_100)}`), null);
    assert.equal((await document.locate('b/0/short'))!.text, 'text');
    // The 20000-character path is no longer repeated in each of 40000 blocks (800 M characters of model).
    const json = timed(() => JSON.stringify(document.model).length);
    assert.ok(
      json.ms < BOUND_MS && (json.value as number) < 10_000_000,
      `model JSON is ${String(json.value)} characters`,
    );
  });

  it('maps texts without NUL in linear time, however few the NULs', async () => {
    const document = parsed(`${'p\n\n'.repeat(300_000)}tail\u0000end\n`);
    assert.equal(document.model.nulRemoved, 1);
    assert.equal(document.model.blocks.at(-1)!.text, 'tailend');
    const many = markdownParser.parse(
      utf8('# a\u0000b\n\nx\u0000\u0000y\n\n\u0000z\n'),
    );
    assert.deepEqual(
      many.model.blocks.map((block) => block.text),
      ['xy', 'z'],
    );
    assert.equal((await many.locate('h/ab'))!.text, '# ab\n\nxy\n\nz');
  });

  it('refuses headings just under the budget repeated over many blocks', () => {
    const heading = 'h'.repeat(4_000);
    const markdown = `# ${heading}\n\n${'p\n\n'.repeat(20_000)}`;
    const outcome = timed(() => markdownParser.parse(utf8(markdown)));
    assert.ok(outcome.ms < BOUND_MS, `took ${outcome.ms.toFixed(0)} ms`);
    assert.ok(
      outcome.error instanceof ParseLimitError &&
        outcome.error.limit === 'maxSelectorChars',
      String(outcome.error),
    );
    const fewer = parsed(`# ${heading}\n\n${'p\n\n'.repeat(1_000)}`);
    assert.equal(fewer.model.blocks[999]!.selector, `b/999/${heading}`);
  });
});

describe('markdown@1 block section paths', () => {
  it('gives every block the heading path of its section, decoded', () => {
    const bySelector = new Map(
      model.blocks.map((block) => [block.selector, block.path]),
    );
    assert.deepEqual(
      bySelector.get('b/0'),
      [],
      'the metadata block before the first heading',
    );
    assert.deepEqual(bySelector.get('b/0/概述'), ['概述']);
    assert.deepEqual(bySelector.get('b/1/概述'), ['概述']);
    assert.deepEqual(bySelector.get('b/0/概述/术语'), ['概述', '术语']);
    assert.deepEqual(bySelector.get('b/1/概述/功能说明/会话保持'), [
      '概述',
      '功能说明',
      '会话保持',
    ]);
    assert.deepEqual(bySelector.get('b/2/概述/功能说明/超时'), [
      '概述',
      '功能说明',
      '超时',
    ]);
    assert.deepEqual(
      bySelector.get('b/0/概述/功能说明/超时[2]'),
      ['概述', '功能说明', '超时[2]'],
      'the second same-named section carries its ordinal',
    );
    assert.deepEqual(
      bySelector.get('b/4/概述/配置示例[2][1]'),
      ['概述', '配置示例[2][1]'],
      'a title that ends in [digits] always carries an ordinal',
    );
    assert.deepEqual(bySelector.get('b/0/概述/配置命令示例'), [
      '概述',
      '配置命令示例',
    ]);
    assert.deepEqual(
      bySelector.get('b/2/附录/[1]'),
      ['附录', '[1]'],
      'an empty heading key carries its ordinal',
    );
  });

  it('spells a path so it maps back to the section selector of its section', () => {
    for (const block of model.blocks) {
      if (block.path === undefined || block.path === null) continue;
      const selector =
        block.path.length === 0
          ? null
          : `h/${block.path.map(selectorSegment).join('/')}`;
      assert.equal(
        selector,
        model.sections[block.section]!.selector,
        block.selector ?? '',
      );
    }
  });

  it('nests a skipped level under the nearest lower heading without a synthetic segment', async () => {
    const document = markdownParser.parse(utf8('# A\n\n### B\n\n正文\n'));
    assert.deepEqual(document.model.sections[2]!.level, 3);
    assert.deepEqual(document.model.blocks[0]!.path, ['A', 'B']);
    assert.equal((await document.locate('h/A/B'))!.text, '### B\n\n正文');
  });

  it('keeps duplicated sibling titles apart by their ordinal', () => {
    const document = markdownParser.parse(
      utf8('# 重复\n\n甲\n\n# 重复\n\n乙\n'),
    );
    assert.deepEqual(
      document.model.blocks.map((block) => [block.text, block.path]),
      [
        ['甲', ['重复']],
        ['乙', ['重复[2]']],
      ],
    );
  });

  it('gives a null path exactly when the section has no selector', () => {
    const document = markdownParser.parse(
      utf8(`# ${'h'.repeat(20_000)}\n\n正文\n\n# short\n\nx\n`),
    );
    assert.equal(document.model.sections[1]!.selector, null);
    assert.equal(document.model.blocks[0]!.path, null);
    assert.deepEqual(document.model.blocks[1]!.path, ['short']);
  });
});
