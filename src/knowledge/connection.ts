import { watch, existsSync, type FSWatcher } from 'node:fs';
import {
  backgroundMcpConnection,
  buildMcpConnections,
  McpManager,
  type McpBearerConnection,
} from '../mcp_loader.js';
import { settingsPath } from '../paths.js';
import { McpLoginRequired } from '../mcp_auth.js';
import {
  saveSettingsChange,
  loadSettings,
  type CircleSettings,
} from '../settings.js';
import { KnowledgeSync } from './sync.js';
import { SyncHttp, SyncHttpError, requestJson } from './sync-http.js';
import type { ModeImpact, SyncCondition } from './sync-types.js';
import type { MemoryReader } from './session-memory.js';

/** Reuses the selected MCP grant; a rejected Bearer gets at most one shared refresh, never a login. */
export function mcpSyncHttp(port: McpBearerConnection): SyncHttp {
  const fetcher: typeof fetch = async (input, init) => {
    try {
      port.assertActive();
    } catch {
      return new Response(JSON.stringify({ code: 'SOURCE_UNAVAILABLE' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    const response = await fetch(input, init);
    try {
      port.assertActive();
    } catch {
      await response.body?.cancel();
      return new Response(JSON.stringify({ code: 'SOURCE_UNAVAILABLE' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (response.status !== 401) return response;
    const sent = new Headers(init?.headers)
      .get('authorization')
      ?.replace(/^Bearer /i, '');
    let token: string;
    try {
      token = await port.token(
        init?.signal ?? AbortSignal.timeout(30000),
        sent,
      );
    } catch {
      await response.body?.cancel();
      init?.signal?.throwIfAborted();
      return new Response(JSON.stringify({ code: 'SOURCE_UNAVAILABLE' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (token === sent) return response;
    await response.body?.cancel();
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${token}`);
    const retried = await fetch(input, { ...init, headers });
    try {
      port.assertActive();
      return retried;
    } catch {
      await retried.body?.cancel();
      return new Response(JSON.stringify({ code: 'SOURCE_UNAVAILABLE' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
  };
  return new SyncHttp(
    port.server,
    async (signal) => {
      try {
        return await port.token(signal);
      } catch {
        throw new SyncHttpError(401, 'SOURCE_UNAVAILABLE');
      }
    },
    fetcher,
  );
}
export interface KnowledgeConnectionStatus {
  condition: SyncCondition;
  lastSyncedAt: string | null;
  server: string;
}
export class KnowledgeConnection {
  private client?: KnowledgeSync;
  private watcher?: FSWatcher;
  private http?: SyncHttp;
  private selected?: { name: string; port: McpBearerConnection };
  private unavailable: SyncCondition = 'paused';
  constructor(
    readonly home: string,
    private readonly settings: () => CircleSettings,
    private readonly secrets: () => Record<string, string>,
    private readonly mcp: McpManager,
    private readonly changed: (
      authorizationChanged?: boolean,
    ) => void = () => {},
  ) {}
  status(): KnowledgeConnectionStatus {
    return {
      ...(this.client?.status ?? {
        condition: this.unavailable,
        lastSyncedAt: null,
      }),
      server: this.settings().knowledge_sync.server,
    };
  }
  connections(): { name: string; origin: string }[] {
    return buildMcpConnections(this.settings().mcp_servers)
      .connections.filter(
        (c) => !!c.url && ['streamable_http', 'sse'].includes(c.transport),
      )
      .map((c) => ({ name: c.name, origin: new URL(c.url!).origin }));
  }
  preview(name: string): { name: string; origin: string; binding: string } {
    const port = this.port(name);
    return { name, origin: new URL(port.server).origin, binding: port.binding };
  }
  private port(name: string): McpBearerConnection {
    const connection = buildMcpConnections(
      this.settings().mcp_servers,
    ).connections.find((c) => c.name === name);
    if (!connection) throw Error('selected MCP connection unavailable');
    return backgroundMcpConnection(this.home, connection, this.secrets);
  }
  private configurationCurrent(name: string, binding: string): boolean {
    if (!existsSync(settingsPath(this.home))) return true;
    const global = loadSettings(this.home);
    return (
      global.knowledge_sync.server === name &&
      global.knowledge_sync.binding === binding &&
      JSON.stringify(global.mcp_servers.find((c) => c.name === name)) ===
        JSON.stringify(this.settings().mcp_servers.find((c) => c.name === name))
    );
  }
  async configure(): Promise<void> {
    await this.close();
    const saved = this.settings().knowledge_sync;
    if (!saved.server || !saved.binding) return;
    if (!this.configurationCurrent(saved.server, saved.binding)) {
      this.unavailable = 'paused';
      this.changed();
      return;
    }
    try {
      const port = this.port(saved.server);
      if (port.binding !== saved.binding) throw new McpLoginRequired();
      this.install(saved.server, port);
      this.client!.start();
    } catch {
      this.unavailable = 'login-required';
      this.changed();
    }
  }
  private install(name: string, port: McpBearerConnection): void {
    this.selected = { name, port };
    this.http = mcpSyncHttp(port);
    this.client = new KnowledgeSync(this.home, this.http, {
      binding: port.binding,
      onStatus: () => this.changed(),
    });
    const selectedConfig = JSON.stringify(
      this.settings().mcp_servers.find((c) => c.name === name),
    );
    this.watcher = watch(this.home, (_event, file) => {
      if (
        file &&
        !['mcp-auth.json', 'secrets.json', 'settings.json'].includes(
          String(file),
        )
      )
        return;
      try {
        if (String(file) === 'settings.json') {
          const saved = loadSettings(this.home);
          if (
            saved.knowledge_sync.server !== name ||
            saved.knowledge_sync.binding !== port.binding ||
            JSON.stringify(saved.mcp_servers.find((c) => c.name === name)) !==
              selectedConfig
          )
            throw new McpLoginRequired();
        }
        port.assertActive();
      } catch {
        this.unavailable = 'login-required';
        void this.close().finally(() => this.changed());
      }
    });
    this.watcher.unref();
  }
  /** Called only after the person reviews the selected server and retained local content. */
  async select(name: string, approvedBinding: string): Promise<void> {
    if (
      existsSync(settingsPath(this.home)) &&
      JSON.stringify(
        loadSettings(this.home).mcp_servers.find((c) => c.name === name),
      ) !==
        JSON.stringify(this.settings().mcp_servers.find((c) => c.name === name))
    )
      throw Error('MCP settings changed; reload before selecting');
    const port = this.port(name);
    if (!approvedBinding || port.binding !== approvedBinding)
      throw Error('MCP authorization changed; select the connection again');
    await this.close();
    this.install(name, port);
    try {
      await this.client!.confirmBinding(true);
    } catch (error) {
      await this.close();
      throw error;
    }
    saveSettingsChange(this.home, (s) => {
      s.knowledge_sync = { server: name, binding: port.binding };
    });
    this.settings().knowledge_sync = { server: name, binding: port.binding };
    this.client!.start();
    this.changed();
  }
  async disconnect(): Promise<void> {
    await this.close();
    saveSettingsChange(this.home, (s) => {
      s.knowledge_sync = { server: '', binding: '' };
    });
    this.settings().knowledge_sync = { server: '', binding: '' };
    this.unavailable = 'paused';
    this.changed();
  }
  async synchronize(): Promise<void> {
    if (!this.client) throw Error('select an authorized MCP connection first');
    if (this.client.status.condition === 'login-required')
      await this.client.resumeAuthorization();
    await this.client.runOnce(true);
  }
  async checkMode(
    mode: 'hub' | 'local',
    signal: AbortSignal,
  ): Promise<ModeImpact> {
    if (!this.http) throw Error('select an authorized MCP connection first');
    return this.http.request('modeCheck', {
      body: { mode },
      schema: 'personal-sync-mode-impact@1',
      signal,
    });
  }
  async changeMode(
    mode: 'hub' | 'local',
    preview: ModeImpact,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!this.client) throw Error('select an authorized MCP connection first');
    return this.client.changeMode(
      mode,
      async (current) => requestJson(current) === requestJson(preview),
      signal,
    );
  }
  reader(): MemoryReader | undefined {
    const saved = this.settings().knowledge_sync;
    if (!saved.server) return undefined;
    const read: MemoryReader = async (args, signal) => {
      if (!this.client) throw new McpLoginRequired();
      const port = this.port(saved.server);
      if (port.binding !== saved.binding) throw new McpLoginRequired();
      const result = await this.mcp.readOnly(
        saved.server,
        'get_nodes',
        args,
        signal,
      );
      port.assertActive();
      if (!this.client) throw new McpLoginRequired();
      return result;
    };
    read.inspectText = (text) =>
      this.mcp.assertNoCredentials(saved.server, text);
    return read;
  }
  /** Recheck the selected grant at a model boundary too, without waiting for filesystem event delivery. */
  checkAuthorization(): void {
    if (!this.selected || !this.client) return;
    try {
      this.selected.port.assertActive();
      if (
        !this.configurationCurrent(
          this.selected.name,
          this.selected.port.binding,
        )
      )
        throw new McpLoginRequired();
    } catch {
      this.unavailable = 'login-required';
      void this.close().finally(() => this.changed());
    }
  }
  notify(): void {
    this.client?.notify();
  }
  async close(): Promise<void> {
    const client = this.client;
    this.watcher?.close();
    this.watcher = undefined;
    this.client = undefined;
    this.http = undefined;
    this.selected = undefined;
    if (client) this.changed(true);
    await client?.close();
  }
}
