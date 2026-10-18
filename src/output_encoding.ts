import { spawnSync } from 'node:child_process';

/**
 * How command output becomes text.
 *
 * A command writes bytes. On Windows, `cmd.exe`, PowerShell 5.1 and most console
 * programs write them in the console's code page (936 on Simplified Chinese, 437 on US
 * English), not in UTF-8, and `chcp 65001` does not make every built-in follow it
 * (`ver` still answers in 936). So Circle does not try to force UTF-8 on the command; it
 * reads the console's code page once and decodes with it. Programs that write UTF-8 there
 * anyway (git, node, Python in UTF-8 mode, a ConPTY) are still read as UTF-8: output that
 * is valid UTF-8 stays UTF-8, and in mixed output each line is judged by itself.
 */

export const UTF8_CODE_PAGE = 65001;

/** Runs a probe and gives back its standard output, or undefined when it failed. */
export type CodePageProbe = (
  command: string,
  args: string[],
) => Buffer | undefined;

const probe: CodePageProbe = (command, args) => {
  const result = spawnSync(command, args, {
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout : undefined;
};

/** The number in `chcp`'s answer: `Active code page: 936`, `Aktive Codepage: 850.`. */
export function parseChcp(output: string): number | undefined {
  const found = output.match(/\d+/g)?.at(-1);
  const page = found ? Number(found) : NaN;
  return Number.isSafeInteger(page) && page > 0 ? page : undefined;
}

/**
 * The code page commands write in. `chcp`, run the way commands run, reports the console
 * they share (the terminal Circle runs in, or the new console a windowless Circle gives
 * them), including a terminal that was switched with `chcp`; the registry's OEM code page,
 * the default of every new console, is the fallback. Elsewhere it is UTF-8.
 */
export function detectConsoleCodePage(
  platform: NodeJS.Platform = process.platform,
  run: CodePageProbe = probe,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (platform !== 'win32') return UTF8_CODE_PAGE;
  const answered = (command: string, args: string[]) => {
    try {
      return run(command, args)?.toString('latin1');
    } catch {
      return undefined;
    }
  };
  const chcp = answered(env.ComSpec || 'cmd.exe', ['/d', '/c', 'chcp']);
  const fromChcp = chcp === undefined ? undefined : parseChcp(chcp);
  if (fromChcp) return fromChcp;
  const registry = answered('reg', [
    'query',
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage',
    '/v',
    'OEMCP',
  ]);
  const oem = registry?.match(/OEMCP\s+REG_SZ\s+(\d+)/)?.[1];
  return oem ? Number(oem) : UTF8_CODE_PAGE;
}

let current: number | undefined;
/** The code page this process decodes command output in, found once. */
export function consoleCodePage(): number {
  return (current ??= detectConsoleCodePage());
}
/** Sets the code page instead of finding it; undefined finds it again. Tests stand in a
 * Windows console with it. */
export function useConsoleCodePage(codePage: number | undefined): void {
  current = codePage;
}

// Code pages the WHATWG decoders in Node's full ICU know.
const LABELS: Record<number, string> = {
  866: 'ibm866',
  874: 'windows-874',
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
  10000: 'macintosh',
  20866: 'koi8-r',
  20932: 'euc-jp',
  21866: 'koi8-u',
  28592: 'iso-8859-2',
  28593: 'iso-8859-3',
  28594: 'iso-8859-4',
  28595: 'iso-8859-5',
  28596: 'iso-8859-6',
  28597: 'iso-8859-7',
  28598: 'iso-8859-8',
  28603: 'iso-8859-13',
  28605: 'iso-8859-15',
  51932: 'euc-jp',
  54936: 'gb18030',
};
// The DOS code pages Windows consoles use by default, which WHATWG has no decoder for:
// bytes 0x80-0xff of each.
const DOS: Record<number, string> = {
  437: 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0',
  720: '\u0080\u0081éâ\u0084à\u0086çêëèïî\u008d\u008e\u008f\u0090\u0651\u0652ô¤ـûùءآأؤ£إئابةتثجحخدذرزسشص«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀ضطظعغفµقكلمنهوىي≡\u064b\u064c\u064d\u064e\u064f\u0650≈°∙·√ⁿ²■\u00a0',
  737: 'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρσςτυφχψ░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀ωάέήϊίόύϋώΆΈΉΊΌΎΏ±≥≤ΪΫ÷≈°∙·√ⁿ²■\u00a0',
  775: 'ĆüéāäģåćłēŖŗīŹÄÅÉæÆōöĢ¢ŚśÖÜø£Ø×¤ĀĪóŻżź”¦©®¬½¼Ł«»░▒▓│┤ĄČĘĖ╣║╗╝ĮŠ┐└┴┬├─┼ŲŪ╚╔╩╦╠═╬Žąčęėįšųūž┘┌█▄▌▐▀ÓßŌŃõÕµńĶķĻļņĒŅ’\u00ad±“¾¶§÷„°∙·¹³²■\u00a0',
  850: 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´\u00ad±‗¾¶§÷¸°¨·¹³²■\u00a0',
  852: 'ÇüéâäůćçłëŐőîŹÄĆÉĹĺôöĽľŚśÖÜŤťŁ×čáíóúĄąŽžĘę¬źČş«»░▒▓│┤ÁÂĚŞ╣║╗╝Żż┐└┴┬├─┼Ăă╚╔╩╦╠═╬¤đĐĎËďŇÍÎě┘┌█▄ŢŮ▀ÓßÔŃńňŠšŔÚŕŰýÝţ´\u00ad˝˛ˇ˘§÷¸°¨˙űŘř■\u00a0',
  857: 'ÇüéâäàåçêëèïîıÄÅÉæÆôöòûùİÖÜø£ØŞşáíóúñÑĞğ¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ºªÊËÈ\ufffdÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµ\ufffd×ÚÛÙìÿ¯´\u00ad±\ufffd¾¶§÷¸°¨·¹³²■\u00a0',
  858: 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈ€ÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´\u00ad±‗¾¶§÷¸°¨·¹³²■\u00a0',
  862: 'אבגדהוזחטיךכלםמןנסעףפץצקרשת¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0',
};

type Decode = (bytes: Uint8Array, stream: boolean) => string;
const decoders = new Map<number, Decode | undefined>();
function decoderFor(codePage: number): Decode | undefined {
  if (decoders.has(codePage)) return decoders.get(codePage);
  let decode: Decode | undefined;
  const table = DOS[codePage];
  if (table)
    decode = (bytes) => {
      let text = '';
      for (const byte of bytes)
        text += byte < 0x80 ? String.fromCharCode(byte) : table[byte - 0x80];
      return text;
    };
  else if (LABELS[codePage])
    try {
      const label = LABELS[codePage];
      new TextDecoder(label);
      decode = (bytes, stream) =>
        new TextDecoder(label).decode(bytes, { stream });
    } catch {
      /* A Node without full ICU reads it as UTF-8. */
    }
  decoders.set(codePage, decode);
  return decode;
}
/** Whether a code page other than UTF-8 can be decoded here. */
export function decodesCodePage(codePage: number): boolean {
  return codePage !== UTF8_CODE_PAGE && decoderFor(codePage) !== undefined;
}

function strictUtf8(bytes: Uint8Array, stream: boolean): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
      { stream },
    );
  } catch {
    return undefined;
  }
}
const lenientUtf8 = (bytes: Uint8Array, stream: boolean): string =>
  new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes, { stream });

export interface DecodeOptions {
  /** Defaults to the console's code page. */
  codePage?: number;
  /** The bytes start at a cut, maybe inside a character: what comes before the first
   * whole UTF-8 character is left out. */
  cutStart?: boolean;
  /** The bytes end at a cut: a character the cut split is left out, not shown as �. */
  cutEnd?: boolean;
}

/**
 * Command output bytes as text, without splitting a character at either cut. Output that
 * is valid UTF-8 is read as UTF-8. Otherwise, in a code page other than UTF-8, each line
 * that is valid UTF-8 and has a character of three or more bytes (as CJK text and
 * symbols do) is read as UTF-8 and every other line in the code page.
 */
export function decodeOutput(
  bytes: Uint8Array,
  options: DecodeOptions = {},
): string {
  const codePage = options.codePage ?? consoleCodePage();
  let start = 0;
  if (options.cutStart)
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  const data = bytes.subarray(start);
  const cutEnd = Boolean(options.cutEnd);
  const decode = codePage === UTF8_CODE_PAGE ? undefined : decoderFor(codePage);
  if (!decode) return lenientUtf8(data, cutEnd);
  const whole = strictUtf8(data, cutEnd);
  if (whole !== undefined) return whole;
  let text = '';
  for (let from = 0; from < data.length;) {
    // A line feed is never part of a multi-byte character in these code pages.
    const newline = data.indexOf(0x0a, from);
    const end = newline < 0 ? data.length : newline + 1;
    const line = data.subarray(from, end);
    const last = end === data.length && cutEnd;
    const utf8 = line.some((byte) => byte >= 0xe0)
      ? strictUtf8(line, last)
      : undefined;
    text += utf8 ?? decode(line, last);
    from = end;
  }
  return text;
}
