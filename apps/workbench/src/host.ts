import type {
  DesktopBridge,
  NativeFile,
  NativeWorkspace,
} from '../../desktop/src/contracts';
import type { Attachment, RuntimePort } from './model/types';
import { currentSession } from './model/state';
import { t } from './i18n';
declare global {
  interface Window {
    circleDesktop?: DesktopBridge;
  }
}
/** A failed folder open, in the interface language when the cause is the chooser. */
export function folderOpenMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (
    !message ||
    message === 'folder could not be opened' ||
    message === 'workspace is not a folder'
  )
    return t('folder could not be opened');
  return message;
}
export function desktopHost() {
  return typeof window !== 'undefined' ? window.circleDesktop : undefined;
}
export async function copyText(text: string) {
  const host = desktopHost();
  if (host) await host.copyText(text);
  else await navigator.clipboard.writeText(text);
}
/** The clipboard takes PNG and JPEG pictures: another kind is drawn again as a PNG. */
async function clipboardPicture(dataUrl: string): Promise<string> {
  if (/^data:image\/(png|jpeg);/i.test(dataUrl)) return dataUrl;
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext('2d')!.drawImage(image, 0, 0);
  return canvas.toDataURL('image/png');
}
/** A picture to the clipboard, as the system takes it. */
export async function copyImage(dataUrl: string) {
  const picture = await clipboardPicture(dataUrl);
  const host = desktopHost();
  if (host) {
    await host.copyImage(picture);
    return;
  }
  const blob = await (await fetch(picture)).blob();
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
}
/** A picture to a file the person chooses; false when they chose none. */
export async function saveImage(
  name: string,
  dataUrl: string,
): Promise<boolean> {
  const host = desktopHost();
  if (host) return (await host.saveImage({ name, dataUrl })).saved;
  const anchor = document.createElement('a');
  anchor.href = dataUrl;
  anchor.download = name;
  anchor.click();
  return true;
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
// Where tasks with no project get their folders. Same native dialog and grant
// indirection as the default workspace: the window never names a path.
export async function setTaskFolder(
  runtime: RuntimePort,
): Promise<NativeWorkspace | null> {
  const host = desktopHost();
  if (!host || runtime.mode !== 'live') return null;
  const selected = await host.chooseWorkspace();
  if (!selected) return null;
  await runtime.request('set-task-folder', {
    workspaceGrant: selected.id,
  });
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
