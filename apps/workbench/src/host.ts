import type {
  DesktopBridge,
  NativeFile,
  NativeWorkspace,
} from '../../desktop/src/contracts';
import type { Attachment, RuntimePort } from './model/types';
import { currentSession } from './model/state';
declare global {
  interface Window {
    circleDesktop?: DesktopBridge;
  }
}
export function desktopHost() {
  return typeof window !== 'undefined' ? window.circleDesktop : undefined;
}
export async function copyText(text: string) {
  const host = desktopHost();
  if (host) await host.copyText(text);
  else await navigator.clipboard.writeText(text);
}
export async function saveExport(
  name: string,
  content: string,
  mime = 'text/plain',
): Promise<boolean> {
  const host = desktopHost();
  if (host) return (await host.saveFile({ name, content, mime })).saved;
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
export function nativeAttachment(file: NativeFile): Attachment {
  return {
    id: file.id,
    name: file.name,
    kind: file.kind,
    content: file.content,
    mime: file.mime,
    size: file.size,
    truncated: file.truncated,
  };
}
// Seed the file list with a native selection's granted handles, replacing the
// files of that workspace: reads still go through the grant, one file at a time.
function adoptSelectedFiles(
  runtime: RuntimePort,
  selected: NativeWorkspace,
  workspaceId: string,
) {
  runtime.change((state) => {
    state.files = state.files.filter(
      (file) => file.workspaceId !== workspaceId,
    );
    state.files.push(
      ...selected.files.map((file) => ({
        id: file.id,
        workspaceId,
        path: file.path,
        content: '',
        language: file.language,
        nativeGrant: { workspaceId: selected.id, fileId: file.id },
      })),
    );
  });
}
/** Opens a folder and returns its workspace id. Does not create a session. */
export async function openNativeWorkspace(
  runtime: RuntimePort,
): Promise<string | null> {
  const host = desktopHost();
  if (!host) return null;
  const selected = await host.chooseWorkspace();
  if (!selected) return null;
  if (runtime.mode === 'live') {
    const result = (await runtime.request('open-workspace', {
      workspaceGrant: selected.id,
    })) as { workspaceId: string };
    adoptSelectedFiles(runtime, selected, result.workspaceId);
    return result.workspaceId;
  }
  const existing = runtime
    .getSnapshot()
    .workspaces.find((item) => item.path === selected.path);
  const id = existing?.id ?? crypto.randomUUID();
  runtime.change((state) => {
    if (!existing)
      state.workspaces.push({
        id,
        name: selected.name,
        path: selected.path,
        branch: 'local workspace',
        trusted: false,
        kind: 'project',
        instructions: [],
        origin: 'native',
      });
    state.files = state.files.filter((file) => file.workspaceId !== id);
    state.files.push(
      ...selected.files.map((file) => ({
        id: file.id,
        workspaceId: id,
        path: file.path,
        content: '',
        language: file.language,
        nativeGrant: { workspaceId: selected.id, fileId: file.id },
      })),
    );
  });
  return id;
}
// Change where the default workspace lives. The folder comes from the same native
// dialog and grant indirection as openNativeWorkspace: the window never names a
// path, and the runtime keeps and validates the chosen one.
export async function setDefaultWorkspace(
  runtime: RuntimePort,
): Promise<NativeWorkspace | null> {
  const host = desktopHost();
  if (!host || runtime.mode !== 'live') return null;
  const selected = await host.chooseWorkspace();
  if (!selected) return null;
  const result = (await runtime.request('set-default-workspace', {
    workspaceGrant: selected.id,
  })) as { workspaceId: string };
  adoptSelectedFiles(runtime, selected, result.workspaceId);
  return selected;
}
export async function readNativeFile(runtime: RuntimePort, path: string) {
  const session = currentSession(runtime.getSnapshot());
  const file = runtime
    .getSnapshot()
    .files.find(
      (file) => file.workspaceId === session.workspaceId && file.path === path,
    );
  if (!file?.nativeGrant) return;
  const host = desktopHost();
  if (!host) throw Error('this file requires the desktop host');
  const value = await host.readWorkspaceFile(
    file.nativeGrant.workspaceId,
    file.nativeGrant.fileId,
  );
  runtime.change((state) => {
    const target = state.files.find((item) => item.id === file.id);
    if (target) {
      target.content = value.content;
      target.truncated = value.truncated;
      target.source = 'native selection';
    }
  });
}
