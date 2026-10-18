import { useLayoutEffect, useRef } from 'react';
import { applyMonacoLocale } from './monaco-locale';
import * as monaco from 'monaco-editor/editor/editor.api';
// Monaco 0.57 exposes this runtime service entry without TypeScript declarations.
// @ts-expect-error The pinned standalone module has no declaration file.
import { StandaloneServices } from 'monaco-editor/editor/standalone/browser/standaloneServices';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard';
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu';
import 'monaco-editor/editor/contrib/folding/browser/folding';
import 'monaco-editor/editor/contrib/format/browser/formatActions';
import 'monaco-editor/editor/contrib/gotoError/browser/gotoError';
import 'monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition';
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution';
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor';
import 'monaco-editor/editor/contrib/rename/browser/rename';
import 'monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter';
import 'monaco-editor/editor/contrib/find/browser/findController';
import 'monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands';
import 'monaco-editor/editor/standalone/browser/referenceSearch/standaloneReferenceSearch';
import 'monaco-editor/editor/contrib/suggest/browser/suggestController';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import 'monaco-editor/languages/definitions/typescript/register';
import 'monaco-editor/languages/definitions/javascript/register';
import { workspaceCall, subscribeWorkspace } from '../model/workspace-client';
import {
  breakpointsForPath,
  toggleBreakpointLine,
  type BreakpointRow,
} from './breakpoints';
import './native-editor.css';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
const editorWorkspaceIds = new Set<string>();
// Labels are presentation only: model URIs keep their stable workspace identity.
StandaloneServices.initialize({
  labelService: {
    getUriLabel(resource: monaco.Uri) {
      const firstSlash = resource.path.indexOf('/', 1);
      const workspace = resource.path.slice(
        1,
        firstSlash < 0 ? undefined : firstSlash,
      );
      if (editorWorkspaceIds.has(workspace))
        return firstSlash < 0
          ? '.'
          : resource.path.slice(firstSlash + 1) || '.';
      return resource.scheme === 'file' ? resource.fsPath : resource.path;
    },
    getUriBasenameLabel(resource: monaco.Uri) {
      return (
        resource.path.slice(resource.path.lastIndexOf('/') + 1) ||
        resource.authority
      );
    },
  },
});
export type EditorDocument = {
  path: string;
  content: string;
  revision: string;
};
export const editorDocuments = new Map<string, EditorDocument>();
export function setEditorDocument(workspace: string, document: EditorDocument) {
  const uri = editorUri(workspace, document.path).toString();
  editorDocuments.set(uri, document);
  persistBuffer(workspace, document.path);
}
/** External writes update clean models only; dirty buffers retain their CAS baseline. */
export function refreshEditorDocument(
  workspace: string,
  document: EditorDocument,
): 'updated' | 'conflict' | 'unchanged' {
  const uri = editorUri(workspace, document.path),
    previous = editorDocuments.get(uri.toString());
  const model = monaco.editor.getModel(uri);
  if (!model || !previous || previous.revision === document.revision)
    return 'unchanged';
  // Metadata-only changes advance CAS without replacing the human draft or Undo stack.
  if (previous.content === document.content) {
    setEditorDocument(workspace, document);
    return 'updated';
  }
  if (model.getValue() !== previous.content) return 'conflict';
  setEditorDocument(workspace, document);
  model.pushStackElement();
  model.pushEditOperations(
    [],
    [{ range: model.getFullModelRange(), text: document.content }],
    () => null,
  );
  model.pushStackElement();
  return 'updated';
}
function bufferKey(workspace: string, path: string) {
  return `circle.editor.buffer.v1:${workspace}:${path}`;
}
export function persistBuffer(workspace: string, path: string): boolean {
  const uri = editorUri(workspace, path).toString();
  const document = editorDocuments.get(uri),
    model = monaco.editor.getModel(monaco.Uri.parse(uri));
  if (!document || !model) return false;
  try {
    if (model.getValue() === document.content)
      localStorage.removeItem(bufferKey(workspace, path));
    else
      localStorage.setItem(
        bufferKey(workspace, path),
        JSON.stringify({ document, content: model.getValue() }),
      );
    return true;
  } catch {
    window.dispatchEvent(new CustomEvent('circle-editor-persistence-error'));
    return false;
  }
}
export function editorBuffer(workspace: string, path: string) {
  const uri = editorUri(workspace, path),
    model = monaco.editor.getModel(uri);
  return model
    ? {
        uri: uri.toString(),
        path,
        content: model.getValue(),
        version: model.getVersionId(),
      }
    : null;
}
export function pendingEditorDocuments(workspace: string) {
  return [...editorDocuments.entries()].flatMap(([uri, document]) => {
    const model = monaco.editor.getModel(monaco.Uri.parse(uri));
    return model &&
      model.uri.path.startsWith(`/${workspace}/`) &&
      model.getValue() !== document.content
      ? [
          {
            ...document,
            content: model.getValue(),
            expectedRevision: document.revision,
          },
        ]
      : [];
  });
}
const states = new Map<string, monaco.editor.ICodeEditorViewState | null>();
export const editorUri = (workspace: string, path: string) =>
  monaco.Uri.from({ scheme: 'file', path: `/${workspace}/${path}` });
export function retainedModel(
  workspace: string,
  path: string,
  content: string,
  language: string,
) {
  editorWorkspaceIds.add(workspace);
  const uri = editorUri(workspace, path);
  const existing = monaco.editor.getModel(uri);
  if (existing) return existing;
  try {
    const saved = JSON.parse(
      localStorage.getItem(bufferKey(workspace, path)) ?? 'null',
    );
    if (
      saved?.document?.path === path &&
      typeof saved.document.revision === 'string' &&
      typeof saved.document.content === 'string' &&
      typeof saved.content === 'string'
    ) {
      editorDocuments.set(uri.toString(), saved.document);
      content = saved.content;
    }
  } catch {
    /* Invalid stored drafts never replace the current disk read. */
  }
  const model = monaco.editor.createModel(content, language, uri);
  model.onDidChangeContent(() => {
    persistBuffer(workspace, path);
    window.dispatchEvent(
      new CustomEvent('circle-editor-change', { detail: { workspace, path } }),
    );
  });
  return model;
}
type Range = monaco.IRange;
type Location = { path: string; range: Range };
export function NativeCodeEditor({
  workspaceId,
  sessionId,
  path,
  value,
  original,
  language,
  readOnly,
  diff,
  selection,
  onChange,
  onSave,
  onNavigate,
  live,
  visible = true,
}: {
  workspaceId: string;
  sessionId: string;
  path: string;
  value: string;
  original?: string;
  language: string;
  readOnly: boolean;
  diff: boolean;
  live: boolean;
  visible?: boolean;
  selection?: Range;
  onChange: (value: string) => void;
  onSave: () => void;
  onNavigate: (path: string, range?: Range) => Promise<void>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const visibility = useRef(visible);
  visibility.current = visible;
  const owner = JSON.stringify([workspaceId, sessionId, path]);
  const selectionIdentity = selection
    ? JSON.stringify([
        selection.startLineNumber,
        selection.startColumn,
        selection.endLineNumber,
        selection.endColumn,
      ])
    : '';
  const activeEditor = useRef<{
    owner: string;
    editor: monaco.editor.IStandaloneCodeEditor;
    selectionIdentity: string;
  } | null>(null);
  const callbacks = useRef({ owner, onChange, onSave, onNavigate });
  callbacks.current = { owner, onChange, onSave, onNavigate };
  useLayoutEffect(() => {
    if (!container.current) return;
    applyMonacoLocale();
    const model = retainedModel(workspaceId, path, value, language);
    const uri = model.uri.toString();
    let updateTypography: (() => void) | undefined;
    const typography = () => {
      const style = getComputedStyle(document.documentElement);
      const fontSize =
        Number.parseFloat(style.getPropertyValue('--code-size')) ||
        Number.parseFloat(style.fontSize);
      return {
        fontSize,
        fontFamily: style.getPropertyValue('--mono').trim(),
        lineHeight: Math.round(fontSize * 1.8),
      };
    };
    const applyTheme = () => {
      const root = getComputedStyle(document.documentElement);
      const dark = document.documentElement.dataset.theme !== 'light';
      const color = (name: string) => {
        const raw = root.getPropertyValue(name).trim();
        if (raw.startsWith('#')) return raw;
        const channels = raw.match(/\d+(?:\.\d+)?/g)?.slice(0, 3);
        return channels?.length === 3
          ? '#' +
              channels
                .map((item) =>
                  Math.round(Number(item)).toString(16).padStart(2, '0'),
                )
                .join('')
          : undefined;
      };
      const colors: Record<string, string> = {};
      const tokens: Record<string, string> = {
        'editor.background': '--subtle',
        'editor.foreground': '--fg',
        'editorLineNumber.foreground': '--muted',
        'editorLineNumber.activeForeground': '--fg',
        'editor.selectionBackground': '--active',
        'editor.inactiveSelectionBackground': '--hover',
        'editor.lineHighlightBackground': '--surface',
        'editorCursor.foreground': '--fg',
        'editorWidget.background': '--surface',
        'editorWidget.foreground': '--fg',
        'editorWidget.border': '--border',
        'editorHoverWidget.background': '--surface',
        'editorHoverWidget.foreground': '--fg',
        'editorHoverWidget.border': '--border',
        'editorSuggestWidget.background': '--surface',
        'editorSuggestWidget.foreground': '--fg',
        'editorSuggestWidget.border': '--border',
        'editorSuggestWidget.selectedBackground': '--active',
        'editorSuggestWidget.selectedForeground': '--fg',
        'editorSuggestWidget.highlightForeground': '--accent',
        focusBorder: '--accent',
        'menu.background': '--surface',
        'menu.foreground': '--fg',
        'menu.border': '--border',
        'menu.selectionBackground': '--active',
        'menu.selectionForeground': '--fg',
        'menu.separatorBackground': '--border',
        'input.background': '--bg',
        'input.foreground': '--fg',
        'input.border': '--border',
        'inputOption.activeBackground': '--active',
        'inputOption.activeBorder': '--accent',
        'list.hoverBackground': '--hover',
        'list.activeSelectionBackground': '--active',
        'list.activeSelectionForeground': '--fg',
        'list.focusBackground': '--active',
        'list.focusForeground': '--fg',
        'editorError.foreground': '--negative',
        'editorWarning.foreground': '--attention',
        'editorInfo.foreground': '--accent',
        'diffEditor.insertedTextBackground': '--added-bg',
        'diffEditor.removedTextBackground': '--removed-bg',
        'diffEditor.insertedLineBackground': '--write-bg',
        'diffEditor.removedLineBackground': '--think-bg',
      };
      for (const [target, source] of Object.entries(tokens)) {
        const value = color(source);
        if (value) colors[target] = value;
      }
      monaco.editor.defineTheme('circle-native', {
        base: dark ? 'vs-dark' : 'vs',
        inherit: true,
        rules: [
          { token: 'comment', foreground: color('--muted')?.slice(1) },
          { token: 'keyword', foreground: color('--accent')?.slice(1) },
          { token: 'string', foreground: color('--secondary')?.slice(1) },
          { token: 'number', foreground: color('--secondary')?.slice(1) },
        ],
        colors,
      });
      monaco.editor.setTheme('circle-native');
      updateTypography?.();
    };
    applyTheme();
    const themeWatcher = new MutationObserver(applyTheme);
    themeWatcher.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'style'],
    });
    const options: monaco.editor.IStandaloneEditorConstructionOptions = {
      model,
      theme: 'circle-native',
      readOnly,
      automaticLayout: true,
      minimap: { enabled: false },
      padding: { top: readOnly ? 15 : 18, bottom: readOnly ? 15 : 18 },
      ...typography(),
      scrollBeyondLastLine: false,
      accessibilitySupport: 'on',
      ariaLabel: path,
      tabSize: 2,
      glyphMargin:
        live && (language === 'typescript' || language === 'javascript'),
    };
    const { model: _model, ...diffOptions } = options;
    const view = diff
      ? monaco.editor.createDiffEditor(container.current, {
          ...diffOptions,
          originalEditable: false,
          renderSideBySide: true,
        })
      : monaco.editor.create(container.current, options);
    updateTypography = () => view.updateOptions(typography());
    let originalModel: monaco.editor.ITextModel | undefined;
    const editor = diff
      ? (view as monaco.editor.IStandaloneDiffEditor).getModifiedEditor()
      : (view as monaco.editor.IStandaloneCodeEditor);
    if (diff) {
      const originalUri = model.uri.with({ scheme: 'circle-original' });
      originalModel =
        monaco.editor.getModel(originalUri) ??
        monaco.editor.createModel(original ?? '', language, originalUri);
      if (originalModel.getValue() !== (original ?? ''))
        originalModel.setValue(original ?? '');
      (view as monaco.editor.IStandaloneDiffEditor).setModel({
        original: originalModel,
        modified: model,
      });
    }
    const prior = states.get(uri);
    if (prior) editor.restoreViewState(prior);
    if (selection) {
      editor.setSelection(selection);
      editor.revealRangeInCenter(selection);
    }
    activeEditor.current = { owner, editor, selectionIdentity };
    if (visibility.current) editor.focus();
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => callbacks.current.owner === owner && callbacks.current.onSave(),
    );
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const request = <T,>(
      method: string,
      params: Record<string, unknown> = {},
    ) =>
      workspaceCall<T>(sessionId, 'language', 'request', {
        method,
        path,
        content: model.getValue(),
        documents: [...editorDocuments.entries()]
          .filter(([uri]) =>
            monaco.Uri.parse(uri).path.startsWith(`/${workspaceId}/`),
          )
          .map(([uri, document]) => ({
            path: document.path,
            content:
              monaco.editor.getModel(monaco.Uri.parse(uri))?.getValue() ??
              document.content,
          })),
        ...params,
      });
    const disposables: monaco.IDisposable[] = [];
    if (live && (language === 'typescript' || language === 'javascript')) {
      let lines: number[] = [];
      let edited = false;
      const decorations = editor.createDecorationsCollection();
      const paint = (next: number[]) => {
        lines = next;
        decorations.set(
          next.map((line) => ({
            range: new monaco.Range(line, 1, line, 1),
            options: { glyphMarginClassName: 'circle-breakpoint-glyph' },
          })),
        );
      };
      const fromSnapshot = (
        breakpoints: Record<string, readonly BreakpointRow[]>,
      ) => paint(breakpointsForPath(breakpoints, path));
      disposables.push(
        editor.onMouseDown((event) => {
          const type = event.target.type;
          if (
            type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN &&
            type !== monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS &&
            type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS
          )
            return;
          const line = event.target.position?.lineNumber;
          if (!line || !active) return;
          event.event.preventDefault();
          event.event.stopPropagation();
          edited = true;
          const previous = lines;
          paint(toggleBreakpointLine(lines, line));
          void workspaceCall(sessionId, 'debug', 'setBreakpoints', {
            path,
            lines,
          }).catch(() => {
            if (active) paint(previous);
          });
        }),
      );
      disposables.push({
        dispose: subscribeWorkspace((event) => {
          const snapshot = event.data.snapshot as
            | { breakpoints?: Record<string, readonly BreakpointRow[]> }
            | undefined;
          if (
            event.sessionId !== sessionId ||
            event.service !== 'debug' ||
            !snapshot?.breakpoints
          )
            return;
          fromSnapshot(snapshot.breakpoints);
        }),
      });
      void workspaceCall<{
        breakpoints?: Record<string, readonly BreakpointRow[]>;
      }>(sessionId, 'debug', 'snapshot')
        .then((snapshot) => {
          if (active && !edited) fromSnapshot(snapshot.breakpoints ?? {});
        })
        .catch(() => {});
      disposables.push({ dispose: () => decorations.clear() });
    }
    const update = () => {
      if (callbacks.current.owner !== owner) return;
      callbacks.current.onChange(model.getValue());
      if (!live) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const version = model.getVersionId();
        void request<(monaco.editor.IMarkerData & { path?: string })[]>(
          'diagnostics',
        )
          .then((markers) => {
            if (
              !active ||
              model.isDisposed() ||
              model.getVersionId() !== version
            )
              return;
            monaco.editor.setModelMarkers(
              model,
              'circle',
              markers.filter((marker) => !marker.path || marker.path === path),
            );
            window.dispatchEvent(
              new CustomEvent('circle-language-project', {
                detail: {
                  workspaceId,
                  diagnostics: markers.filter(
                    (marker) => marker.source === 'configuration',
                  ),
                },
              }),
            );
          })
          .catch((cause) => {
            if (!active) return;
            window.dispatchEvent(
              new CustomEvent('circle-language-project', {
                detail: {
                  workspaceId,
                  diagnostics: [
                    {
                      message: String(
                        cause instanceof Error ? cause.message : cause,
                      ),
                      path,
                      startLineNumber: 1,
                      startColumn: 1,
                    },
                  ],
                },
              }),
            );
          });
      }, 250);
    };
    disposables.push(model.onDidChangeContent(update));
    if (live)
      disposables.push({
        dispose: subscribeWorkspace((event) => {
          if (
            event.workspaceId === workspaceId &&
            event.sessionId === sessionId &&
            event.service === 'documents'
          )
            update();
        }),
      });
    if (live) {
      // A pattern is a glob: `[id]` in a route folder would never match its own file.
      // Each glob character matches any one character, and `own` keeps the answers to
      // this model alone.
      const selector = {
        language,
        scheme: 'file',
        pattern: model.uri.path.replace(/[[\]{}*?!]/g, '?'),
      };
      const own = (target: monaco.editor.ITextModel) =>
        target.uri.toString() === model.uri.toString();
      const at = (position: monaco.Position) => ({
        line: position.lineNumber,
        column: position.column,
      });
      const locations = async (method: string, position: monaco.Position) =>
        (await request<Location[]>(method, at(position))).map((item) => ({
          uri: editorUri(workspaceId, item.path),
          range: item.range,
        }));
      disposables.push(
        monaco.languages.registerDefinitionProvider(selector, {
          provideDefinition: (target, position) =>
            own(target) ? locations('definition', position) : [],
        }),
      );
      disposables.push(
        monaco.languages.registerReferenceProvider(selector, {
          provideReferences: (target, position) =>
            own(target) ? locations('references', position) : [],
        }),
      );
      disposables.push(
        monaco.languages.registerCompletionItemProvider(selector, {
          triggerCharacters: ['.'],
          provideCompletionItems: async (target, position) => ({
            suggestions: !own(target)
              ? []
              : (
                  await request<
                    { label: string; insertText: string; sortText: string }[]
                  >('completion', at(position))
                ).map((item) => ({
                  ...item,
                  kind: monaco.languages.CompletionItemKind.Text,
                  range: model.getWordUntilPosition(position) && {
                    startLineNumber: position.lineNumber,
                    endLineNumber: position.lineNumber,
                    startColumn:
                      model.getWordUntilPosition(position).startColumn,
                    endColumn: position.column,
                  },
                })),
          }),
        }),
      );
      disposables.push(
        monaco.languages.registerDocumentFormattingEditProvider(selector, {
          provideDocumentFormattingEdits: (target) =>
            own(target)
              ? request<{ range: Range; text: string }[]>('format')
              : [],
        }),
      );
      disposables.push(
        monaco.languages.registerRenameProvider(selector, {
          provideRenameEdits: async (target, position, newName) => {
            if (!own(target)) return { edits: [] };
            const edits = await request<(Location & { text: string })[]>(
              'rename',
              { ...at(position), newName },
            );
            for (const target of new Set(edits.map((item) => item.path))) {
              if (!monaco.editor.getModel(editorUri(workspaceId, target))) {
                const document = await workspaceCall<EditorDocument>(
                  sessionId,
                  'documents',
                  'read',
                  { path: target },
                );
                setEditorDocument(workspaceId, document);
                retainedModel(
                  workspaceId,
                  target,
                  document.content,
                  /\.[cm]?tsx?$/.test(target) ? 'typescript' : 'javascript',
                );
              }
            }
            return {
              edits: edits.map((item) => ({
                resource: editorUri(workspaceId, item.path),
                versionId: monaco.editor
                  .getModel(editorUri(workspaceId, item.path))
                  ?.getVersionId(),
                textEdit: { range: item.range, text: item.text },
              })),
            };
          },
        }),
      );
      disposables.push(
        monaco.editor.registerEditorOpener({
          openCodeEditor: async (_, resource, selection) => {
            if (!resource.path.startsWith(`/${workspaceId}/`)) return false;
            if (!active || callbacks.current.owner !== owner) return false;
            await callbacks.current.onNavigate(
              resource.path.slice(workspaceId.length + 2),
              selection &&
                ('startLineNumber' in selection
                  ? selection
                  : {
                      startLineNumber: selection.lineNumber,
                      startColumn: selection.column,
                      endLineNumber: selection.lineNumber,
                      endColumn: selection.column,
                    }),
            );
            return true;
          },
        }),
      );
    }
    update();
    return () => {
      active = false;
      if (activeEditor.current?.editor === editor) activeEditor.current = null;
      states.set(uri, editor.saveViewState());
      clearTimeout(timer);
      disposables.forEach((item) => item.dispose());
      view.dispose();
      themeWatcher.disconnect();
    };
  }, [workspaceId, sessionId, path, language, readOnly, diff, live]);
  // Revealing a retained source view restores focus without replacing its model.
  useLayoutEffect(() => {
    if (visible) {
      activeEditor.current?.editor.layout();
      activeEditor.current?.editor.focus();
    }
  }, [visible]);
  // Source location updates reposition the existing view. Recreating it here
  // disposes transient widgets (notably Rename) after asynchronous navigation.
  useLayoutEffect(() => {
    const current = activeEditor.current;
    if (
      !selection ||
      !current ||
      current.owner !== owner ||
      current.selectionIdentity === selectionIdentity
    )
      return;
    current.selectionIdentity = selectionIdentity;
    current.editor.setSelection(selection);
    current.editor.revealRangeInCenter(selection);
    if (visibility.current) current.editor.focus();
  }, [owner, selectionIdentity]);
  return <div className="native-code-editor" ref={container} />;
}
