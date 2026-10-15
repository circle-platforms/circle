import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

/** Project-scoped semantic service. Overlays never write project files. */
export class LanguageService {
  private overlays = new Map<string, { content: string; version: number }>();
  private service: ts.LanguageService;
  private root: string;
  private libraryRoot: string;
  constructor(root: string) {
    this.root = fs.realpathSync(root);

    let options: ts.CompilerOptions = {
      allowJs: true,
      checkJs: true,
      target: ts.ScriptTarget.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
    };
    this.libraryRoot = fs.realpathSync(
      path.dirname(ts.getDefaultLibFilePath(options)),
    );
    const fileExists = (file: string) =>
      this.overlays.has(path.normalize(file)) ||
      (this.allowed(file) && ts.sys.fileExists(file));
    const readFile = (file: string) =>
      this.allowed(file) ? ts.sys.readFile(file) : undefined;
    const readDirectory: typeof ts.sys.readDirectory = (...args) =>
      ts.sys.readDirectory(...args).filter((file) => this.allowed(file));
    const configPath = path.join(this.root, 'tsconfig.json');
    const config = fileExists(configPath) ? configPath : undefined;
    let files: string[] = [];
    if (config) {
      const read = ts.readConfigFile(config, readFile);
      if (!read.error) {
        const parsed = ts.parseJsonConfigFileContent(
          read.config,
          {
            useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
            fileExists,
            readFile,
            readDirectory,
          },
          path.dirname(config),
        );
        options = { ...options, ...parsed.options };
        files = parsed.fileNames;
      }
    }
    if (!files.length)
      files = readDirectory(
        this.root,
        ['.ts', '.tsx', '.js', '.jsx', '.json'],
        ['**/node_modules/**', '**/.git/**', '**/dist/**'],
      );
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => [
        ...new Set([
          ...files.map((file) => path.normalize(file)),
          ...this.overlays.keys(),
        ]),
      ],
      getScriptVersion: (file) =>
        String(
          this.overlays.get(path.normalize(file))?.version ??
            (this.allowed(file)
              ? fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs
              : 0) ??
            0,
        ),
      getScriptSnapshot: (file) => {
        const text =
          this.overlays.get(path.normalize(file))?.content ?? readFile(file);
        return text === undefined
          ? undefined
          : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => this.root,
      getCompilationSettings: () => options,
      getDefaultLibFileName: ts.getDefaultLibFilePath,
      fileExists,
      readFile,
      readDirectory,
      directoryExists: (directory) =>
        this.allowed(directory) && !!ts.sys.directoryExists?.(directory),
      realpath: (file) =>
        this.allowed(file) ? (ts.sys.realpath?.(file) ?? file) : file,
    };
    this.service = ts.createLanguageService(host);
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
    const text =
      this.overlays.get(path.normalize(file))?.content ??
      (this.allowed(file) ? ts.sys.readFile(file) : undefined) ??
      '';
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
    const a = source.getLineAndCharacterOfPosition(span.start),
      b = source.getLineAndCharacterOfPosition(span.start + span.length);
    return {
      startLineNumber: a.line + 1,
      startColumn: a.character + 1,
      endLineNumber: b.line + 1,
      endColumn: b.character + 1,
    };
  }
  call(method: string, params: Record<string, unknown>): unknown {
    if (method === 'request') {
      if (
        typeof params.method !== 'string' ||
        ['request', 'open', 'change'].includes(params.method)
      )
        throw Error('invalid language request');
      return this.call(params.method, params);
    }
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
        if (old?.content !== document.content)
          this.overlays.set(name, {
            content: document.content,
            version: (old?.version ?? 0) + 1,
          });
      }
    const file = this.resolve(params.path);
    if (typeof params.content === 'string') {
      const old = this.overlays.get(file);
      if (old?.content !== params.content)
        this.overlays.set(file, {
          content: params.content,
          version: (old?.version ?? 0) + 1,
        });
    }
    if (method === 'close') {
      this.overlays.delete(file);
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
    if (method === 'diagnostics')
      return [
        ...this.service.getSyntacticDiagnostics(file),
        ...this.service.getSemanticDiagnostics(file),
      ].map((item) => ({
        ...this.range(file, {
          start: item.start ?? 0,
          length: item.length ?? 0,
        }),
        message: ts.flattenDiagnosticMessageText(item.messageText, '\n'),
        severity: item.category === ts.DiagnosticCategory.Error ? 8 : 4,
        code: String(item.code),
      }));
    if (method === 'sync')
      return { version: this.overlays.get(path.normalize(file))?.version ?? 0 };
    throw Error(`unknown language method: ${method}`);
  }
  dispose() {
    this.service.dispose();
    this.overlays.clear();
  }
}
