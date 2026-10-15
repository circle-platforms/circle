import { useEffect, useRef } from 'react';
import { applyMonacoLocale } from './monaco-locale';
import { useLocale } from '../i18n';
import * as monaco from 'monaco-editor/editor/editor.api';
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
import 'monaco-editor/editor/contrib/suggest/browser/suggestController';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import 'monaco-editor/languages/definitions/typescript/register';
import 'monaco-editor/languages/definitions/javascript/register';
import { workspaceCall } from '../model/workspace-client';
import './native-editor.css';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
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
  selection?: Range;
  onChange: (value: string) => void;
  onSave: () => void;
  onNavigate: (path: string, range?: Range) => Promise<void>;
}) {
  const languageChoice = useLocale();
  const container = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onChange, onSave, onNavigate });
  callbacks.current = { onChange, onSave, onNavigate };
  useEffect(() => {
    if (!container.current) return;
    applyMonacoLocale();
    const model = retainedModel(workspaceId, path, value, language);
    const uri = model.uri.toString();
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
      const background = color('--bg'),
        foreground = color('--fg');
      if (background) colors['editor.background'] = background;
      if (foreground) colors['editor.foreground'] = foreground;
      monaco.editor.defineTheme('circle-native', {
        base: dark ? 'vs-dark' : 'vs',
        inherit: true,
        rules: [],
        colors,
      });
      monaco.editor.setTheme('circle-native');
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
      fontSize: 13,
      scrollBeyondLastLine: false,
      accessibilitySupport: 'on',
      ariaLabel: path,
      tabSize: 2,
    };
    const { model: _model, ...diffOptions } = options;
    const view = diff
      ? monaco.editor.createDiffEditor(container.current, {
          ...diffOptions,
          originalEditable: false,
          renderSideBySide: true,
        })
      : monaco.editor.create(container.current, options);
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
    editor.focus();
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
      callbacks.current.onSave(),
    );
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
    const update = () => {
      callbacks.current.onChange(model.getValue());
      if (!live) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        void request<monaco.editor.IMarkerData[]>('diagnostics')
          .then((markers) =>
            monaco.editor.setModelMarkers(model, 'circle', markers),
          )
          .catch(() => {});
      }, 250);
    };
    disposables.push(model.onDidChangeContent(update));
    if (live) {
      const selector = { language, scheme: 'file', pattern: model.uri.path };
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
          provideDefinition: (_, position) => locations('definition', position),
        }),
      );
      disposables.push(
        monaco.languages.registerReferenceProvider(selector, {
          provideReferences: (_, position) => locations('references', position),
        }),
      );
      disposables.push(
        monaco.languages.registerCompletionItemProvider(selector, {
          triggerCharacters: ['.'],
          provideCompletionItems: async (_, position) => ({
            suggestions: (
              await request<
                { label: string; insertText: string; sortText: string }[]
              >('completion', at(position))
            ).map((item) => ({
              ...item,
              kind: monaco.languages.CompletionItemKind.Text,
              range: model.getWordUntilPosition(position) && {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: model.getWordUntilPosition(position).startColumn,
                endColumn: position.column,
              },
            })),
          }),
        }),
      );
      disposables.push(
        monaco.languages.registerDocumentFormattingEditProvider(selector, {
          provideDocumentFormattingEdits: () =>
            request<{ range: Range; text: string }[]>('format'),
        }),
      );
      disposables.push(
        monaco.languages.registerRenameProvider(selector, {
          provideRenameEdits: async (_, position, newName) => {
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
      states.set(uri, editor.saveViewState());
      clearTimeout(timer);
      disposables.forEach((item) => item.dispose());
      view.dispose();
      themeWatcher.disconnect();
    };
  }, [
    workspaceId,
    sessionId,
    path,
    language,
    readOnly,
    diff,
    live,
    selection,
    languageChoice,
  ]);
  return <div className="native-code-editor" ref={container} />;
}
