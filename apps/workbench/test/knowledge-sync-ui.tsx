// Settings → sync with a synthetic runtime whose sync server refused a change, holds a purge for the account holder's
// confirmation, and publishes no discovery document.
import { createRoot } from 'react-dom/client';
import { CircleWorkbench } from '../src/workbench';
import { LiveRuntime } from '../src/model/live';
import { circlePlugins } from '../src/plugins/builtins';
import { createFixtures } from '../src/preview/fixtures';
import { setLanguage } from '../src/i18n';
import type { KnowledgeSyncView } from '../../../src/knowledge/desktop-contract';
import type { DesktopBridge } from '../../desktop/src/contracts';
import type {
  RuntimeCommand,
  RuntimeUpdate,
} from '../../desktop/src/runtime-protocol';
const query = new URLSearchParams(location.search);
setLanguage(query.get('language') === 'zh-CN' ? 'zh-CN' : 'en');
const snapshot = createFixtures();
snapshot.runtime = { connected: true, configured: true };
snapshot.settings.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
snapshot.interactions = [];
snapshot.requests = [];
export const DETAIL =
  '合成的说明：删除本人副本需要账户持有人确认。到确认页面确认后重试。';
export const PAGE = 'https://sync.example.test/console/sync?confirm=purge';
const sync: KnowledgeSyncView = {
  condition: 'paused',
  mode: 'hub',
  clearing: false,
  server: 'team-server',
  lastSyncedAt: '2026-11-12T08:00:00Z',
  detail: DETAIL,
  confirmation: { url: PAGE, expiresAt: '2026-11-12T08:10:00Z' },
  discovery: 'fallback',
};
let update: RuntimeUpdate = { seq: 0, connected: true, snapshot };
const commands: RuntimeCommand[] = [];
const opened: string[] = [];
const host = {
  runtimeState: async () => structuredClone(update),
  onRuntime: () => () => {},
  onTerminalEvent: () => () => {},
  onBrowserEvent: () => () => {},
  onAction: () => () => {},
  setTheme: async () => {},
  browserState: async () => ({ sessionId: 'none' }),
  openExternal: async (url: string) => {
    opened.push(url);
  },
  copyText: async () => {},
  runtimeCommand: async (command: RuntimeCommand) => {
    if (command.name !== 'workspace-service') commands.push(command);
    if (command.name !== 'knowledge') return { id: command.id, ok: true };
    const op = (command.payload as { op?: string }).op;
    if (op === 'settings')
      return {
        id: command.id,
        ok: true,
        data: { sync, connections: [{ name: 'team-server' }] },
      };
    // Connecting an account that has never synced on this device
    if (op === 'prepare')
      return {
        id: command.id,
        ok: true,
        data: {
          ticket: 'synthetic-ticket',
          action: 'connect',
          title: 'team-server',
          firstSync: true,
        },
      };
    // The server refused: the window says so by kind; its words are in the status
    if (op === 'sync')
      return { id: command.id, ok: false, error: 'knowledge-sync-refused' };
    return { id: command.id, ok: true, data: {} };
  },
} as unknown as DesktopBridge;
window.circleDesktop = host;
const runtime = new LiveRuntime(host, update);
Object.assign(window, { knowledgeSyncFixture: { commands, opened } });
location.hash = '/page/sync';
createRoot(document.getElementById('root')!).render(
  <CircleWorkbench runtime={runtime} plugins={circlePlugins} />,
);
