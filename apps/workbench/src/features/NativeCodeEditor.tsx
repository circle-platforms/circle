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
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor';
import 'monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter';
import 'monaco-editor/editor/contrib/find/browser/findController';
import 'monaco-editor/editor/contrib/suggest/browser/suggestController';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import 'monaco-editor/languages/definitions/typescript/register';
import 'monaco-editor/languages/definitions/javascript/register';
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
  visible?: boolean;
  selection?: Range;
  onChange: (value: string) => void;
  onSave: () => void;
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
  const callbacks = useRef({ owner, onChange, onSave });
  callbacks.current = { owner, onChange, onSave };
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
      glyphMargin: false,
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
    const disposables: monaco.IDisposable[] = [];
    const update = () => {
      if (callbacks.current.owner !== owner) return;
      callbacks.current.onChange(model.getValue());
    };
    disposables.push(model.onDidChangeContent(update));
    update();
    return () => {
      if (activeEditor.current?.editor === editor) activeEditor.current = null;
      states.set(uri, editor.saveViewState());
      disposables.forEach((item) => item.dispose());
      view.dispose();
      themeWatcher.disconnect();
    };
  }, [workspaceId, sessionId, path, language, readOnly, diff]);
  // Revealing a retained source view restores focus without replacing its model.
  useLayoutEffect(() => {
    if (visible) {
      activeEditor.current?.editor.layout();
      activeEditor.current?.editor.focus();
    }
  }, [visible]);
  // Source location updates reposition the existing view. Recreating it here
  // would dispose transient widgets, such as find, after asynchronous navigation.
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
