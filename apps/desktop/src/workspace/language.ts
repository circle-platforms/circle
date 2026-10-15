import type ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire as createLanguageRequire } from 'node:module';

let typescript: typeof ts | undefined;
function loadTypescript(): typeof ts {
  const requireLanguage = createLanguageRequire(
    typeof __filename === 'string' ? __filename : import.meta.url,
  );
  return (typescript ??= requireLanguage('typescript') as typeof ts);
}
const sourceFile = (file: string) => /\.[cm]?[jt]sx?$/i.test(file);

/** Project-scoped semantic service. Overlays never write project files. */
export class LanguageService {
  private overlays = new Map<string, { content: string; version: number }>();
  private opened = new Set<string>();
  private service!: ts.LanguageService;
  private root: string;
  private libraryRoot: string;
  private options: ts.CompilerOptions = {};
  private files: string[] = [];
  private configPath?: string;
  private configErrors: readonly ts.Diagnostic[] = [];
  private observed = new Map<string, string>();
  private invalidated = true;
  private projectVersion = 0;
  private disposed = false;
  constructor(root: string) {
    const ts = loadTypescript();
    this.root = fs.realpathSync(root);
    this.libraryRoot = fs.realpathSync(
      path.dirname(ts.getDefaultLibFilePath({})),
    );
    this.ensureProject();
  }
  /** Filesystem watchers mark a project stale without touching in-flight drafts. */
  invalidate(paths?: readonly string[]): void {
    if (
      !paths ||
      paths.some((file) =>
        /(?:\.[cm]?[jt]sx?|\.json|(?:^|[/\\])(?:tsconfig|jsconfig|package|pnpm-lock|yarn\.lock|bun\.lock)|(?:^|[/\\])node_modules(?:[/\\]|$))/.test(
          file,
        ),
      )
    )
      this.invalidated = true;
  }
  private fingerprint(file: string): string {
    try {
      const stat = fs.lstatSync(file, { bigint: true });
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch {
      return 'missing';
    }
  }
  private insideRoot(file: string): boolean {
    const local = path.relative(this.root, path.resolve(file));
    return (
      local !== '..' &&
      !local.startsWith('..' + path.sep) &&
      !path.isAbsolute(local)
    );
  }
  private observe(file: string): void {
    file = path.normalize(file);
    if (this.insideRoot(file) && !this.observed.has(file))
      this.observed.set(file, this.fingerprint(file));
  }
  private observeParent(file: string): void {
    let directory = path.dirname(file);
    while (
      this.insideRoot(directory) &&
      !fs.existsSync(directory) &&
      directory !== this.root
    )
      directory = path.dirname(directory);
    if (this.insideRoot(directory)) this.observe(directory);
  }
  private ensureProject(): void {
    const ts = loadTypescript();
    if (this.disposed) throw Error('language service is closed');
    if (
      !this.invalidated &&
      ![...this.observed].some(
        ([file, stamp]) => this.fingerprint(file) !== stamp,
      )
    )
      return;
    this.invalidated = false;
    this.observed.clear();
    for (const name of [
      'tsconfig.json',
      'jsconfig.json',
      'package.json',
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lock',
      'bun.lockb',
      'node_modules',
      'node_modules/@types',
      'node_modules/.package-lock.json',
    ])
      this.observe(path.join(this.root, name));
    this.observe(this.root);
    const fileExists = (file: string) => {
      this.observeParent(file);
      return (
        this.overlays.has(path.normalize(file)) ||
        (this.allowed(file) && ts.sys.fileExists(file))
      );
    };
    const readFile = (file: string) => {
      this.observe(file);
      this.observeParent(file);
      return this.allowed(file) ? ts.sys.readFile(file) : undefined;
    };
    const readDirectory: typeof ts.sys.readDirectory = (...args) => {
      this.observe(args[0]);
      const files = ts.sys
        .readDirectory(...args)
        .filter((file) => this.allowed(file));
      for (const file of files) this.observeParent(file);
      return files;
    };
    const config = ['tsconfig.json', 'jsconfig.json']
      .map((name) => path.join(this.root, name))
      .find(fileExists);
    this.configPath = config;
    const defaults: ts.CompilerOptions = {
      allowJs: true,
      checkJs: true,
      target: ts.ScriptTarget.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
    };
    this.configErrors = [];
    if (config) {
      const read = ts.readConfigFile(config, readFile);
      if (read.error) {
        this.configErrors = [read.error];
        this.options = defaults;
        this.files = [];
      } else {
        const parsed = ts.parseJsonConfigFileContent(
          read.config,
          {
            useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
            fileExists,
            readFile,
            readDirectory,
          },
          path.dirname(config),
          undefined,
          config,
        );
        this.options = { ...defaults, ...parsed.options };
        this.files = parsed.fileNames
          .map((file) => path.normalize(file))
          .filter((file) => this.allowed(file));
        this.configErrors = parsed.errors;
      }
    } else {
      // Inferred editor projects analyze sources without emitting over JS inputs.
      // Configured projects retain their actual emit settings and diagnostics.
      this.options = { ...defaults, noEmit: true };
      this.files = readDirectory(
        this.root,
        ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
        ['**/node_modules/**', '**/.git/**', '**/dist/**'],
      );
    }
    this.projectVersion++;
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () =>
        [
          ...new Set([
            ...this.files,
            ...[...this.opened, ...this.overlays.keys()].filter(sourceFile),
          ]),
        ].filter(fileExists),
      getProjectVersion: () => String(this.projectVersion),
      getScriptVersion: (file) =>
        String(
          this.overlays.get(path.normalize(file))?.version ??
            (this.allowed(file) ? this.fingerprint(file) : 'missing'),
        ),
      getScriptSnapshot: (file) => {
        const text =
          this.overlays.get(path.normalize(file))?.content ?? readFile(file);
        return text === undefined
          ? undefined
          : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => this.root,
      getCompilationSettings: () => this.options,
      getDefaultLibFileName: ts.getDefaultLibFilePath,
      fileExists,
      readFile,
      readDirectory,
      directoryExists: (directory) => {
        this.observe(directory);
        return this.allowed(directory) && !!ts.sys.directoryExists?.(directory);
      },
      realpath: (file) =>
        this.allowed(file) ? (ts.sys.realpath?.(file) ?? file) : file,
    };
    this.service?.dispose();
    this.service = ts.createLanguageService(host);
  }
  private configDiagnostics() {
    const ts = loadTypescript();
    const diagnostics = [
      ...this.configErrors,
      ...this.service.getCompilerOptionsDiagnostics(),
    ];
    const seen = new Set<string>();
    return diagnostics.flatMap((item) => {
      const file =
        item.file?.fileName ??
        this.configPath ??
        path.join(this.root, 'tsconfig.json');
      const message = ts.flattenDiagnosticMessageText(item.messageText, '\n');
      const key = `${file}:${item.start}:${item.code}:${message}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [
        {
          ...this.range(file, {
            start: item.start ?? 0,
            length: item.length ?? 0,
          }),
          path: path.relative(this.root, file).split(path.sep).join('/'),
          source: 'configuration',
          message,
          severity: item.category === ts.DiagnosticCategory.Error ? 8 : 4,
          code: String(item.code),
        },
      ];
    });
  }
  /** Resolution can read only granted project files and the bundled standard libs. */
  private allowed(file: string): boolean {
    try {
      const real = fs.realpathSync(file);
      return [this.root, this.libraryRoot].some((root) => {
        const relative = path.relative(root, real);
        return (
          relative !== '..' &&
          !relative.startsWith('..' + path.sep) &&
          !path.isAbsolute(relative)
        );
      });
    } catch {
      return false;
    }
  }
  private resolve(input: unknown): string {
    if (typeof input !== 'string') throw Error('file path required');
    const target = path.resolve(this.root, input);
    if (target !== this.root && !target.startsWith(this.root + path.sep))
      throw Error('file is outside workspace');
    let probe = target;
    while (!fs.existsSync(probe) && probe !== this.root)
      probe = path.dirname(probe);
    const real = fs.realpathSync(probe);
    if (real !== this.root && !real.startsWith(this.root + path.sep))
      throw Error('file is outside workspace');
    return target;
  }
  private range(file: string, span: ts.TextSpan) {
    const ts = loadTypescript();
    const text =
      this.overlays.get(path.normalize(file))?.content ??
      (this.allowed(file) ? ts.sys.readFile(file) : undefined) ??
      '';
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
    const a = source.getLineAndCharacterOfPosition(
        Math.min(span.start, text.length),
      ),
      b = source.getLineAndCharacterOfPosition(
        Math.min(span.start + span.length, text.length),
      );
    return {
      startLineNumber: a.line + 1,
      startColumn: a.character + 1,
      endLineNumber: b.line + 1,
      endColumn: b.character + 1,
    };
  }
  call(method: string, params: Record<string, unknown>): unknown {
    const ts = loadTypescript();
    if (method === 'request') {
      if (
        typeof params.method !== 'string' ||
        ['request', 'open', 'change'].includes(params.method)
      )
        throw Error('invalid language request');
      return this.call(params.method, params);
    }
    if (method === 'refresh') this.invalidated = true;
    this.ensureProject();
    if (method === 'project' || method === 'refresh')
      return {
        version: this.projectVersion,
        configPath: this.configPath
          ? path.relative(this.root, this.configPath).split(path.sep).join('/')
          : null,
        files: this.files.map((file) =>
          path.relative(this.root, file).split(path.sep).join('/'),
        ),
        diagnostics: this.configDiagnostics(),
      };
    if (method === 'open' || method === 'change') method = 'sync';
    if (Array.isArray(params.documents))
      for (const document of params.documents) {
        if (
          !document ||
          typeof document !== 'object' ||
          typeof document.content !== 'string'
        )
          throw Error('invalid document overlay');
        const name = this.resolve(document.path),
          old = this.overlays.get(name);
        if (old?.content !== document.content) {
          this.projectVersion++;
          this.overlays.set(name, {
            content: document.content,
            version: (old?.version ?? 0) + 1,
          });
        }
      }
    const file = this.resolve(params.path);
    if (!this.opened.has(file)) {
      this.opened.add(file);
      this.projectVersion++;
    }
    if (typeof params.content === 'string') {
      const old = this.overlays.get(file);
      if (old?.content !== params.content) {
        this.projectVersion++;
        this.overlays.set(file, {
          content: params.content,
          version: (old?.version ?? 0) + 1,
        });
      }
    }
    if (method === 'close') {
      this.overlays.delete(file);
      this.opened.delete(file);
      this.projectVersion++;
      return {};
    }
    const content =
      this.overlays.get(path.normalize(file))?.content ??
      (this.allowed(file) ? ts.sys.readFile(file) : undefined) ??
      '';
    const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest);
    const line = Math.max(0, Number(params.line ?? 1) - 1),
      column = Math.max(0, Number(params.column ?? 1) - 1);
    const position = source.getPositionOfLineAndCharacter(
      Math.min(line, source.getLineStarts().length - 1),
      Math.min(
        column,
        (source.getLineStarts()[
          Math.min(line + 1, source.getLineStarts().length)
        ] ?? content.length) -
          source.getLineStarts()[
            Math.min(line, source.getLineStarts().length - 1)
          ]!,
      ),
    );
    const inside = (item: ts.DocumentSpan) => {
      const relative = path.relative(this.root, path.normalize(item.fileName));
      return (
        relative !== '..' &&
        !relative.startsWith('..' + path.sep) &&
        !path.isAbsolute(relative)
      );
    };
    const location = (item: ts.DocumentSpan) => ({
      path: path
        .relative(this.root, path.normalize(item.fileName))
        .split(path.sep)
        .join('/'),
      range: this.range(item.fileName, item.textSpan),
    });
    if (method === 'definition')
      return (this.service.getDefinitionAtPosition(file, position) ?? [])
        .filter(inside)
        .map(location);
    if (method === 'references')
      return (this.service.getReferencesAtPosition(file, position) ?? [])
        .filter(inside)
        .map(location);
    if (method === 'rename') {
      const info = this.service.getRenameInfo(file, position);
      if (!info.canRename) throw Error(info.localizedErrorMessage);
      if (
        typeof params.newName !== 'string' ||
        !/^[$\p{ID_Start}][\u200c\u200d$\p{ID_Continue}]*$/u.test(
          params.newName,
        )
      )
        throw Error('invalid symbol name');
      return (
        this.service.findRenameLocations(file, position, false, false, true) ??
        []
      )
        .filter(inside)
        .map((item) => ({
          ...location(item),
          text: `${item.prefixText ?? ''}${params.newName}${item.suffixText ?? ''}`,
        }));
    }
    if (method === 'completion')
      return (
        this.service
          .getCompletionsAtPosition(file, position, {})
          ?.entries.map((item) => ({
            label: item.name,
            insertText: item.insertText ?? item.name,
            kind: item.kind,
            sortText: item.sortText,
          })) ?? []
      );
    if (method === 'format')
      return this.service
        .getFormattingEditsForDocument(file, {
          tabSize: 2,
          indentSize: 2,
          convertTabsToSpaces: true,
          newLineCharacter: '\n',
          insertSpaceAfterCommaDelimiter: true,
          insertSpaceBeforeAndAfterBinaryOperators: true,
        })
        .map((item) => ({
          range: this.range(file, item.span),
          text: item.newText,
        }));
    if (method === 'diagnostics' && file.endsWith('.json')) {
      const error = ts.parseConfigFileTextToJson(file, content).error;
      return [
        ...this.configDiagnostics(),
        ...(error
          ? [
              {
                ...this.range(file, {
                  start: error.start ?? 0,
                  length: error.length ?? 0,
                }),
                path: path.relative(this.root, file).split(path.sep).join('/'),
                source: 'configuration',
                message: ts.flattenDiagnosticMessageText(
                  error.messageText,
                  '\n',
                ),
                severity: 8,
                code: String(error.code),
              },
            ]
          : []),
      ];
    }
    if (method === 'diagnostics' && !sourceFile(file))
      return this.configDiagnostics();
    if (method === 'diagnostics')
      return [
        ...this.configDiagnostics(),
        ...[
          ...this.service.getSyntacticDiagnostics(file),
          ...this.service.getSemanticDiagnostics(file),
        ].map((item) => ({
          path: path.relative(this.root, file).split(path.sep).join('/'),
          source: 'typescript',
          ...this.range(file, {
            start: item.start ?? 0,
            length: item.length ?? 0,
          }),
          message: ts.flattenDiagnosticMessageText(item.messageText, '\n'),
          severity: item.category === ts.DiagnosticCategory.Error ? 8 : 4,
          code: String(item.code),
        })),
      ];
    if (method === 'sync')
      return { version: this.overlays.get(path.normalize(file))?.version ?? 0 };
    throw Error(`unknown language method: ${method}`);
  }
  dispose() {
    this.disposed = true;
    this.service.dispose();
    this.overlays.clear();
    this.opened.clear();
    this.observed.clear();
  }
}
