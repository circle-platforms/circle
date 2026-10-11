import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ESC = '\x1b';
const BEL = '\x07';
const ST = ESC + '\\';

/** Runs a program with `input` on its stdin. Resolves to its exit code, -1 when it was
 * stopped or ran past `timeout` milliseconds, and null when it could not be started. */
export type CommandRunner = (
  command: string,
  args: string[],
  input: Buffer,
  timeout: number,
) => Promise<number | null>;

export const runCommand: CommandRunner = (command, args, input, timeout) =>
  new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (value: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
      });
    } catch {
      finish(null);
      return;
    }
    timer = setTimeout(() => {
      child.kill();
      finish(-1);
    }, timeout);
    child.once('error', () => finish(null));
    // xclip and wl-copy stay behind to serve the selection: their exit is enough
    child.once('exit', (code) => finish(code ?? -1));
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });

/** Runs a program and collects what it prints, up to `limit` bytes. `code` is null when it
 * could not be started and -1 when it was stopped, ran past `timeout` or printed too much. */
export type OutputRunner = (
  command: string,
  args: string[],
  options: { timeout: number; env?: NodeJS.ProcessEnv; limit?: number },
) => Promise<{ code: number | null; stdout: Buffer }>;

export const runOutput: OutputRunner = (command, args, options) =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(chunks) });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        env: options.env,
      });
    } catch {
      finish(null);
      return;
    }
    timer = setTimeout(() => {
      child.kill();
      finish(-1);
    }, options.timeout);
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > (options.limit ?? 1 << 20)) {
        child.kill();
        finish(-1);
      } else chunks.push(chunk);
    });
    child.once('error', () => finish(null));
    child.once('close', (code) => finish(code ?? -1));
  });

/** What the clipboard holds that can go to the model: a picture, written as a PNG to the
 * path `readImage` was given, or files copied in the file manager. */
export type ClipboardImage = { png: string } | { files: string[] };

// The clipboard as a PNG at the path given; files copied in Finder come first, since Finder
// also puts their icons on the clipboard as a picture.
const MAC_IMAGE = [
  'on run argv',
  'try',
  'set copied to the clipboard as «class furl»',
  'return "file:" & POSIX path of copied',
  'end try',
  'try',
  'set png to the clipboard as «class PNGf»',
  'on error',
  'return "none"',
  'end try',
  'set target to open for access (POSIX file (item 1 of argv)) with write permission',
  'try',
  'set eof target to 0',
  'write png to target',
  'end try',
  'close access target',
  'return "png"',
  'end run',
];
const WINDOWS_IMAGE = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
  '$files = [Windows.Forms.Clipboard]::GetFileDropList()',
  "if ($files.Count) { foreach ($file in $files) { 'file:' + $file }; exit }",
  '$image = [Windows.Forms.Clipboard]::GetImage()',
  "if (-not $image) { 'none'; exit }",
  '$image.Save($env:CIRCLE_CLIPBOARD_IMAGE, [Drawing.Imaging.ImageFormat]::Png)',
  "'png'",
].join('; ');
const MAX_IMAGE = 64 << 20;

/** OSC 52: the terminal puts the text on the system clipboard, also over ssh. */
export function osc52(text: string): string {
  return `${ESC}]52;c;${Buffer.from(text, 'utf8').toString('base64')}${BEL}`;
}

/** tmux's DCS passthrough. Inner ESCs are doubled. tmux drops it unless
 * `set -g allow-passthrough on`. */
export function tmuxPassthrough(sequence: string): string {
  return `${ESC}Ptmux;${sequence.replaceAll(ESC, ESC + ESC)}${ST}`;
}

const LINUX_TOOLS: [string, string[]][] = [
  ['wl-copy', []],
  ['xclip', ['-selection', 'clipboard']],
  ['xsel', ['--clipboard', '--input']],
];
const COPY_TOOLS: [string, string[]][] = [
  ['pbcopy', []],
  ['wl-copy', []],
  ['xclip', ['-selection', 'clipboard']],
];

/** clip.exe reads its input in the OEM code page unless it starts with a UTF-16 mark. */
function windowsText(text: string): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'utf16le'),
  ]);
}

export interface ClipboardOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  run?: CommandRunner;
  output?: OutputRunner;
  /** Writes to the terminal. */
  write?: (sequence: string) => void;
}

export class Clipboard {
  private env: NodeJS.ProcessEnv;
  private platform: NodeJS.Platform;
  private run: CommandRunner;
  private output: OutputRunner;
  private write: (sequence: string) => void;
  /** The Linux tool that started last time; '' when none did. */
  private linuxTool?: string;
  /** The local tool started by the last copySelection, for tests to wait on. */
  pending: Promise<void> = Promise.resolve();
  constructor(options: ClipboardOptions = {}) {
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.run = options.run ?? runCommand;
    this.output = options.output ?? runOutput;
    this.write = options.write ?? ((text) => process.stdout.write(text));
  }
  /** A mouse selection: a local tool when this is not an ssh session, tmux's buffer inside
   * tmux, and always OSC 52 to the terminal (through tmux when its buffer took the text).
   * Resolves to the sequence written; '' for empty text. */
  async copySelection(text: string): Promise<string> {
    if (!text) return '';
    const raw = osc52(text);
    if (!this.env.SSH_CONNECTION) this.pending = this.copyLocal(text);
    const sequence = (await this.tmuxLoadBuffer(text))
      ? tmuxPassthrough(raw)
      : raw;
    this.write(sequence);
    return sequence;
  }
  /** `/copy`: the first local tool that takes the text. False when none did. */
  async copyNative(text: string): Promise<boolean> {
    if (this.platform === 'win32')
      return (await this.run('clip', [], windowsText(text), 2000)) === 0;
    const input = Buffer.from(text, 'utf8');
    for (const [command, args] of COPY_TOOLS)
      if ((await this.run(command, args, input, 2000)) === 0) return true;
    return false;
  }
  /** A picture or copied image files on the system clipboard (`ctrl+v`); a picture is
   * written to `target` as a PNG. Undefined when it holds neither or cannot be read. */
  async readImage(target: string): Promise<ClipboardImage | undefined> {
    const lines = (stdout: Buffer) =>
      stdout
        .toString('utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    const answer = (stdout: Buffer): ClipboardImage | undefined => {
      const said = lines(stdout);
      if (said[0] === 'png') return { png: target };
      const files = said
        .filter((line) => line.startsWith('file:'))
        .map((line) => line.slice(5));
      return files.length ? { files } : undefined;
    };
    if (this.platform === 'darwin') {
      const { code, stdout } = await this.output(
        'osascript',
        [...MAC_IMAGE.flatMap((line) => ['-e', line]), target],
        { timeout: 5000 },
      );
      return code === 0 ? answer(stdout) : undefined;
    }
    if (this.platform === 'win32') {
      const { code, stdout } = await this.output(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-STA', '-Command', WINDOWS_IMAGE],
        {
          timeout: 10000,
          env: { ...this.env, CIRCLE_CLIPBOARD_IMAGE: target },
        },
      );
      return code === 0 ? answer(stdout) : undefined;
    }
    // Wayland's wl-paste, else X11's xclip: the types on offer, then the one wanted
    const tool: [string, (type: string) => string[]] = this.env.WAYLAND_DISPLAY
      ? ['wl-paste', (type) => (type ? ['--type', type] : ['--list-types'])]
      : [
          'xclip',
          (type) => ['-selection', 'clipboard', '-t', type || 'TARGETS', '-o'],
        ];
    const read = (type: string, limit = 1 << 20) =>
      this.output(tool[0], tool[1](type), { timeout: 5000, limit });
    const types = await read('');
    if (types.code !== 0) return undefined;
    const offered = lines(types.stdout);
    if (offered.includes('text/uri-list')) {
      const { code, stdout } = await read('text/uri-list');
      const files = lines(stdout).flatMap((line) => {
        try {
          return line.startsWith('file://') ? [fileURLToPath(line)] : [];
        } catch {
          return [];
        }
      });
      if (code === 0 && files.length) return { files };
    }
    if (!offered.includes('image/png')) return undefined;
    const { code, stdout } = await read('image/png', MAX_IMAGE);
    if (code !== 0 || !stdout.length) return undefined;
    writeFileSync(target, stdout, { mode: 0o600 });
    return { png: target };
  }
  private async copyLocal(text: string): Promise<void> {
    if (this.platform === 'darwin') {
      await this.run('pbcopy', [], Buffer.from(text, 'utf8'), 2000);
      return;
    }
    if (this.platform === 'win32') {
      await this.run('clip', [], windowsText(text), 2000);
      return;
    }
    if (this.platform !== 'linux' || this.linuxTool === '') return;
    const input = Buffer.from(text, 'utf8');
    const known = LINUX_TOOLS.find(([command]) => command === this.linuxTool);
    if (known) {
      await this.run(known[0], known[1], input, 2000);
      return;
    }
    for (const [command, args] of LINUX_TOOLS)
      if ((await this.run(command, args, input, 2000)) !== null) {
        this.linuxTool = command;
        return;
      }
    this.linuxTool = '';
  }
  private async tmuxLoadBuffer(text: string): Promise<boolean> {
    if (!this.env.TMUX) return false;
    // -w passes the buffer on to the outer terminal; 0.5.0 left it out under iTerm2
    const args =
      this.env.LC_TERMINAL === 'iTerm2'
        ? ['load-buffer', '-']
        : ['load-buffer', '-w', '-'];
    return (
      (await this.run('tmux', args, Buffer.from(text, 'utf8'), 2000)) === 0
    );
  }
}
