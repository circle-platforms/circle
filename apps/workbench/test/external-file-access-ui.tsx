import { createRoot } from 'react-dom/client';
import { Tooltip } from 'radix-ui';
import { MemoryRouter } from 'react-router-dom';
import { RuntimeProvider } from '../src/app/context';
import { DialogHost } from '../src/features/Dialogs';
import { LiveRuntime } from '../src/model/live';
import { createFixtures } from '../src/preview/fixtures';
import { setLanguage } from '../src/i18n';
import { applyTheme } from '../src/theme';
import type {
  DesktopBridge,
  NativeExternalFileGrant,
} from '../../desktop/src/contracts';
import type {
  RuntimeCommand,
  RuntimeUpdate,
} from '../../desktop/src/runtime-protocol';
import '../src/styles/app.css';
const params = new URLSearchParams(location.search);
setLanguage(params.get('language') === 'zh-CN' ? 'zh-CN' : 'en');
applyTheme(params.get('theme') === 'dark' ? 'dark' : 'light');
const snapshot = createFixtures();
snapshot.sessions = snapshot.sessions.slice(0, 2);
for (const [index, session] of snapshot.sessions.entries()) {
  session.id = `file-owner-${index ? 'b' : 'a'}`;
  session.title = `Synthetic file owner ${index ? 'B' : 'A'}`;
  session.readOnly = params.has('readonly');
  session.archivedAt = undefined;
  session.occupied = false;
  session.lifecycle = 'open';
}
snapshot.activeSessionId = 'file-owner-a';
snapshot.runtime = { connected: true, configured: true };
let update: RuntimeUpdate = { seq: 0, connected: true, snapshot };
let listener: ((value: RuntimeUpdate) => void) | undefined;
let serial = 0;
const grants: NativeExternalFileGrant[] = [];
const calls: RuntimeCommand[] = [];
const pickers: { sessionId: string; access: 'read' | 'readwrite' }[] = [];
let pickerResolve: ((receipt: NativeExternalFileGrant) => void) | undefined;
let revokeResolve: ((ok: boolean) => void) | undefined;
const pendingLists: (() => void)[] = [];
const fixture = {
  grants,
  calls,
  pickers,
  pickerMode: 'grant',
  revokeMode: 'ok',
  holdList: false,
  foreignList: false,
  switchSession(id: string) {
    update = {
      seq: update.seq + 1,
      connected: true,
      snapshot: { ...structuredClone(update.snapshot), activeSessionId: id },
    };
    listener?.(structuredClone(update));
  },
  resolvePicker() {
    const request = pickers.at(-1)!;
    const receipt = {
      id: `os-token-${++serial}`,
      sessionId: request.sessionId,
      access: request.access,
      path: '/synthetic/outside/项目 report exact-file.txt',
    };
    grants.push(receipt);
    pickerResolve?.(receipt);
    pickerResolve = undefined;
  },
  resolveRevoke(ok = true) {
    revokeResolve?.(ok);
    revokeResolve = undefined;
  },
  releaseLists() {
    fixture.holdList = false;
    for (const resolve of pendingLists.splice(0)) resolve();
  },
};
const host = {
  runtimeCommand: async (command: RuntimeCommand) => {
    calls.push(command);
    if (command.name === 'list-external-file-grants') {
      if (fixture.holdList)
        await new Promise<void>((resolve) => pendingLists.push(resolve));
      return {
        id: command.id,
        ok: true,
        data: fixture.foreignList
          ? [
              {
                id: 'foreign',
                sessionId: 'not-this-session',
                path: '/synthetic/foreign',
                access: 'read',
              },
            ]
          : grants
              .filter((grant) => grant.sessionId === command.sessionId)
              .map((grant) => ({ ...grant })),
      };
    }
    if (command.name === 'revoke-external-file-grant') {
      if (fixture.revokeMode === 'error')
        return { id: command.id, ok: false, error: 'synthetic revoke failure' };
      const ok =
        fixture.revokeMode === 'hold'
          ? await new Promise<boolean>((resolve) => {
              revokeResolve = resolve;
            })
          : fixture.revokeMode !== 'false';
      const index = grants.findIndex(
        (grant) =>
          grant.id === command.payload.id &&
          grant.sessionId === command.sessionId,
      );
      if (ok && index >= 0) grants.splice(index, 1);
      return { id: command.id, ok: true, data: { revoked: ok && index >= 0 } };
    }
    return { id: command.id, ok: true };
  },
  runtimeState: async () => structuredClone(update),
  onRuntime: (callback: (value: RuntimeUpdate) => void) => {
    listener = callback;
    return () => {
      listener = undefined;
    };
  },
  requestExternalFileGrant: params.has('unavailable')
    ? undefined
    : async (sessionId: string, access: 'read' | 'readwrite') => {
        pickers.push({ sessionId, access });
        if (fixture.pickerMode === 'cancel') return null;
        if (fixture.pickerMode === 'error')
          throw Error('synthetic picker failure');
        if (fixture.pickerMode === 'hold')
          return await new Promise<NativeExternalFileGrant>((resolve) => {
            pickerResolve = resolve;
          });
        const receipt = {
          id: `os-token-${++serial}`,
          sessionId,
          access,
          path: '/synthetic/outside/项目 report exact-file.txt',
        };
        grants.push(receipt);
        return receipt;
      },
} as unknown as DesktopBridge;
window.circleDesktop = host;
const runtime = new LiveRuntime(host, update);
Object.assign(window, { externalFilesFixture: fixture });
createRoot(document.getElementById('root')!).render(
  <Tooltip.Provider>
    <MemoryRouter>
      <RuntimeProvider runtime={runtime}>
        <DialogHost
          dialog="external-files"
          selection=""
          onClose={() => {}}
          onSession={() => {}}
        />
      </RuntimeProvider>
    </MemoryRouter>
  </Tooltip.Provider>,
);
