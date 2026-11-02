import { basename, relative, sep, extname } from 'node:path';
import { readFileBytes } from '../file_access.js';
import { secretLookingName } from '../sandbox.js';
import { protectedWorkspaceName } from '../file_patterns.js';
import { syncObjectId, sha256 } from '../knowledge/canonical.js';
import { randomUUID } from 'node:crypto';
import { terminalText } from '../ink/components/markdown_renderer.js';
import type { CommandHost } from './slash_handlers.js';
import {
  KnowledgeService,
  type PreparedKnowledgeChange,
} from '../knowledge/service.js';
import type { SyncItem, SyncObject } from '../knowledge/types.js';
import { forgetAuthorization } from '../mcp_auth.js';
import { buildMcpConnections } from '../mcp_loader.js';

const afterAddress = (args: string): string =>
  /^\S+\s+\S+\s+([\s\S]*)$/.exec(args.trimStart())?.[1] ?? '';
const notice = (host: CommandHost, text: string) =>
  host.notice(terminalText(text));
const service = (host: CommandHost) =>
  new KnowledgeService(host.home, host.runtime.options.knowledgeAccess);
export async function personKnowledgeAction(
  host: CommandHost,
  change: unknown,
  name = 'knowledge_write',
): Promise<boolean> {
  if (host.runtime.busy || host.runtime.viewOnly)
    throw Error('finish the turn in an editable session first');
  host.closePicker();
  const approve = host.runtime.options.approve;
  if (!approve) throw Error('person confirmation is unavailable');
  return (
    (await approve(
      { id: randomUUID(), name, args: { change } },
      host.runtime.knowledgeSignal,
    )) === 'approve'
  );
}
async function apply(
  host: CommandHost,
  prepared: PreparedKnowledgeChange,
  memory = false,
): Promise<void> {
  if (
    !(await personKnowledgeAction(
      host,
      {
        items: prepared.preview.objects.map(({ object }) => {
          const { item_id, parents, directory_id, parent_directory, ...body } =
            object.body as any;
          return { kind: object.kind, ...body };
        }),
      },
      memory ? 'memory_write' : 'knowledge_write',
    ))
  )
    return;
  prepared.commit(host.runtime.knowledgeSignal);
  host.runtime.knowledge.notify();
  notice(
    host,
    'saved locally · session memory changes apply to a new session or /memory refresh',
  );
}
const rawLabel = (object: SyncObject): string =>
  object.kind === 'entry_revision'
    ? object.body.content.statement
    : object.kind === 'memory_revision'
      ? object.body.title
      : object.kind === 'directory_revision'
        ? object.body.name || '/'
        : object.kind === 'source_revision'
          ? (object.body.name ?? 'source')
          : object.kind === 'pack_manifest'
            ? object.body.manifest.title
            : object.kind === 'deletion'
              ? 'deleted'
              : object.kind;
const label = (object: SyncObject) =>
  terminalText(rawLabel(object)).replace(/\s+/g, ' ');
function rows(
  host: CommandHost,
  snapshot?: string,
): {
  snapshot: string | null;
  items: SyncItem[];
  objects: Map<string, SyncObject>;
  conflicts: Set<string>;
  paths: Map<string, string | null>;
} {
  return service(host).withStore((store) => {
    const head = snapshot ?? store.head;
    if (!head)
      return {
        snapshot: null,
        items: [],
        objects: new Map(),
        conflicts: new Set(),
        paths: new Map(),
      };
    const graph = store.graph(head),
      objects = new Map<string, SyncObject>();
    for (const row of graph.items)
      for (const id of row.heads) objects.set(id, graph.objects.get(id)!);
    return {
      snapshot: head,
      items: graph.items,
      objects,
      conflicts: new Set(graph.conflicts.map((c) => c.item_id)),
      paths: graph.paths,
    };
  });
}
function rowText(row: SyncItem, objects: Map<string, SyncObject>): string {
  return row.heads.map((id) => label(objects.get(id)!)).join(' / ');
}
function show(host: CommandHost, item: SyncItem, snapshot: string): void {
  service(host).withStore((store) => {
    const blocks = item.heads.map((id, index) => {
      const object = store.read(id);
      let body: string;
      if (object.kind === 'source_revision') {
        try {
          body = new TextDecoder('utf-8', { fatal: true })
            .decode(store.sourceBytes(id))
            .slice(0, 16000);
        } catch {
          body = 'source bytes cannot be displayed as text';
        }
      } else if (object.kind === 'entry_revision')
        body =
          object.body.content.statement +
          '\n' +
          JSON.stringify(
            {
              data: object.body.content.data,
              applicability: object.body.content.applicability,
              grounds: object.body.grounds,
            },
            null,
            2,
          );
      else if (object.kind === 'memory_revision') body = object.body.markdown;
      else body = JSON.stringify(object.body, null, 2);
      const observation = store
        .observations(snapshot)
        .find((v) => v.object === id);
      return `${item.heads.length > 1 ? `candidate ${index + 1} · ` : ''}${label(object)}\n${observation ? observation.status + ' · ' + observation.reasons.map((r) => r.code).join(', ') + '\n' : ''}${body.slice(0, 16000)}${body.length > 16000 ? '\n[remaining content omitted]' : ''}`;
    });
    notice(host, blocks.join('\n\n'));
  });
}
function list(host: CommandHost, onlyConflicts = false): void {
  const current = rows(host);
  const items = current.items
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => !onlyConflicts || current.conflicts.has(row.item_id));
  host.picker(
    onlyConflicts ? 'knowledge conflicts' : 'local knowledge',
    items.slice(0, 100).map(({ row, index }) => ({
      key: String(index + 1),
      label: `${index + 1}. ${rowText(row, current.objects)}`,
      meta: current.conflicts.has(row.item_id)
        ? 'conflicted'
        : row.kind.replace('_revision', ''),
    })),
    (item) => {
      host.closePicker();
      show(host, current.items[Number(item.key) - 1]!, current.snapshot!);
    },
    {
      empty: onlyConflicts
        ? 'no knowledge conflicts'
        : 'no local knowledge yet',
    },
  );
}
export async function knowledgeCommand(
  host: CommandHost,
  args: string,
): Promise<void> {
  const [verb = '', ...parts] = args.trim().split(/\s+/),
    rest = args.trimStart().slice(verb.length).trim(),
    connection = host.runtime.knowledge;
  if (!verb || verb === 'status') {
    const state = connection.status();
    notice(
      host,
      `knowledge · ${state.server || 'local only'} · ${state.condition}${state.lastSyncedAt ? ' · last synced ' + state.lastSyncedAt : ''}`,
    );
    if (!verb) list(host);
    return;
  }
  if (verb === 'list' || verb === 'conflicts') {
    list(host, verb === 'conflicts');
    return;
  }
  if (verb === 'search') {
    const result = service(host).search(rest);
    host.picker(
      'knowledge search',
      result.items.map((hit, index) => ({
        key: String(index),
        label: hit.statement,
        meta: `${hit.path} · ${hit.status}`,
      })),
      (item) => {
        const hit = result.items[Number(item.key)]!;
        host.closePicker();
        const current = rows(host, result.snapshot!);
        show(
          host,
          current.items.find((i) => i.item_id === hit.itemId)!,
          result.snapshot!,
        );
      },
      { empty: 'no local matches' },
    );
    return;
  }
  if (verb === 'connect') {
    const all = connection.connections();
    const choose = async (name: string) => {
      const selected = connection.preview(name);
      if (!selected.binding)
        throw Error('sign in to this MCP server first: /mcp reload');
      const count = rows(host).items.length;
      if (
        !(await personKnowledgeAction(host, {
          action: 'select sync connection',
          server: name,
          origin: selected.origin,
          retained_local_items: count,
          consequence:
            'use this account for retained personal knowledge; local files remain',
        }))
      )
        return;
      await connection.select(name, selected.binding);
      notice(host, 'knowledge sync connection selected');
    };
    if (rest) {
      await choose(rest);
      return;
    }
    host.picker(
      'knowledge connection',
      all.map((c) => ({ key: c.name, label: c.name, meta: c.origin })),
      (item) => choose(item.key),
      { empty: 'no HTTP MCP connections configured' },
    );
    return;
  }
  if (verb === 'disconnect') {
    await connection.disconnect();
    notice(host, 'knowledge sync disconnected · local content retained');
    return;
  }
  if (verb === 'sync') {
    await connection.synchronize();
    notice(host, `knowledge · ${connection.status().condition}`);
    return;
  }
  if (verb === 'mode') {
    if (rest !== 'hub' && rest !== 'local')
      throw Error('usage: /knowledge mode hub|local');
    const preview = await connection.checkMode(
      rest,
      host.runtime.knowledgeSignal,
    );
    if (
      !(await personKnowledgeAction(host, {
        action: 'change sync mode',
        mode: preview.mode,
        personal_bytes: preview.personal_bytes,
        directory_grants: preview.directory_grants,
        pending_shares: preview.pending_shares ?? 'unknown',
        team_copies_preserved: preview.team_copies_preserved,
        local_copy: 'retained',
        team_copies: 'preserved',
        ...(rest === 'local'
          ? {
              purge:
                'personal Hub copies and grants are removed; this does not erase local copies',
            }
          : {}),
      }))
    )
      return;
    if (
      !(await connection.changeMode(
        rest,
        preview,
        host.runtime.knowledgeSignal,
      ))
    )
      throw Error('sync impact changed; preview and confirm again');
    notice(host, `knowledge mode · ${rest} · ${connection.status().condition}`);
    return;
  }
  if (verb === 'login') {
    const name = connection.status().server,
      configured = buildMcpConnections(
        host.runtime.options.settings.mcp_servers,
      ).connections.find((c) => c.name === name);
    if (!configured?.url) throw Error('select an HTTP MCP connection first');
    if (
      Object.keys(configured.headers ?? {}).some(
        (name) =>
          /^(?:proxy-)?authorization$/i.test(name) || secretLookingName(name),
      )
    )
      throw Error(
        'this MCP connection uses a configured credential; update its secret or header, then select the connection again',
      );
    if (
      !(await personKnowledgeAction(host, {
        action: 'sign in again',
        server: name,
        consequence:
          'the old authorization is forgotten; select the new account again before syncing local content',
      }))
    )
      return;
    await connection.close();
    forgetAuthorization(host.home, new URL(configured.url).href);
    await host.runtime.reloadIntegrations();
    notice(host, 'MCP sign-in requested · /knowledge connect after sign-in');
    return;
  }
  if (verb === 'import') {
    if (!rest) throw Error('usage: /knowledge import <workspace text file>');
    const sandbox = host.runtime.sandbox,
      path = sandbox.resolvePath(rest);
    if (
      !sandbox.isInside(path) ||
      relative(sandbox.workspace, path)
        .split(sep)
        .some((name) =>
          protectedWorkspaceName(
            name,
            sandbox.credentialFiles,
            process.platform,
          ),
        )
    )
      throw Error('select an available text file inside this workspace');
    const { bytes } = await readFileBytes(
      sandbox,
      undefined,
      path,
      {
        signal: host.runtime.knowledgeSignal,
        sessionId: host.runtime.session.id,
      },
      1 << 20,
    );
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const current = rows(host),
      objects: SyncObject[] = [],
      add = (object: SyncObject) => {
        objects.push(object);
        return syncObjectId(object);
      };
    const root = current.items.find(
      (i) =>
        i.kind === 'directory_revision' &&
        i.heads.length === 1 &&
        current.paths.get(i.item_id) === '/',
    );
    let directory = root?.item_id;
    if (!directory) {
      if (current.items.some((i) => i.kind === 'directory_revision'))
        throw Error('resolve the root directory conflict before importing');
      directory = randomUUID();
      add({
        schema: 'personal-sync-object@1',
        kind: 'directory_revision',
        body: {
          item_id: directory,
          parents: [],
          name: '',
          parent_directory: null,
        },
      });
    }
    const chunk = add({
      schema: 'personal-sync-object@1',
      kind: 'bytes',
      body: { bytes_base64: bytes.toString('base64') },
    });
    add({
      schema: 'personal-sync-object@1',
      kind: 'source_revision',
      body: {
        item_id: randomUUID(),
        parents: [],
        directory_id: directory,
        name: basename(path),
        media_type:
          extname(path) === '.json'
            ? 'application/json'
            : extname(path) === '.md'
              ? 'text/markdown'
              : 'text/plain',
        raw_sha256: sha256(bytes),
        size: bytes.length,
        chunks: [chunk],
      },
    });
    await apply(
      host,
      service(host).prepare({ expected_head: current.snapshot, objects }),
    );
    return;
  }
  if (verb === 'history') {
    service(host).withStore((store) =>
      notice(
        host,
        store
          .history()
          .map(
            (id, index) =>
              `${index + 1}. ${store.graph(id).items.length} items${id === store.head ? ' · current' : ''}`,
          )
          .join('\n') || 'no knowledge history',
      ),
    );
    return;
  }
  const current = rows(host),
    number = Number(parts[0]),
    item = current.items[number - 1];
  if (!Number.isInteger(number) || !item || !current.snapshot)
    throw Error('choose an item number from /knowledge list');
  if (verb === 'read') {
    show(host, item, current.snapshot);
    return;
  }
  const selected = verb === 'resolve' ? Number(parts[1]) : 1,
    old = current.objects.get(item.heads[selected - 1]!);
  if (!old || !('item_id' in old.body))
    throw Error('choose a candidate number from /knowledge read');
  const object = structuredClone(old) as SyncObject & { body: any };
  object.body.parents = item.heads;
  if (verb === 'delete') {
    await apply(
      host,
      service(host).prepare({
        expected_head: current.snapshot,
        objects: [
          {
            schema: 'personal-sync-object@1',
            kind: 'deletion',
            body: {
              item_id: item.item_id,
              parents: item.heads,
              target_kind: item.kind,
            },
          },
        ],
      }),
    );
    return;
  }
  if (verb === 'edit') {
    if (object.kind !== 'entry_revision' || !afterAddress(args))
      throw Error('usage: /knowledge edit <item> <statement>');
    object.body.content.statement = afterAddress(args);
  } else if (verb === 'rename') {
    const name = afterAddress(args);
    if (
      !name ||
      !['directory_revision', 'source_revision'].includes(object.kind)
    )
      throw Error('select a directory or source and give its name');
    object.body.name = name;
  } else if (verb === 'move') {
    const directory = current.items[Number(parts[1]) - 1];
    if (!directory || directory.kind !== 'directory_revision')
      throw Error('select a destination directory number');
    if (object.kind === 'directory_revision')
      object.body.parent_directory = directory.item_id;
    else if ('directory_id' in object.body)
      object.body.directory_id = directory.item_id;
    else throw Error('this item cannot be moved');
  } else if (verb !== 'resolve')
    throw Error(
      'usage: /knowledge [list|search|read|import|conflicts|resolve|edit|delete|rename|move|history|connect|disconnect|sync|mode|login]',
    );
  await apply(
    host,
    service(host).prepare({
      expected_head: current.snapshot,
      objects: [object],
    }),
  );
}
export async function structuredMemoryCommand(
  host: CommandHost,
  args: string,
): Promise<boolean> {
  const [verb = '', ...parts] = args.trim().split(/\s+/);
  if (verb === 'refresh') {
    await host.runtime.refreshSessionMemory();
    notice(host, 'session memory refreshed');
    return true;
  }
  if (verb === 'loaded') {
    const state = host.runtime.sessionMemoryStatus;
    notice(
      host,
      `session preferences · ${state.bytes} bytes${state.truncated ? ' · truncated' : ''}\n${host.runtime.sessionMemoryContext || 'no structured preferences loaded'}`,
    );
    return true;
  }
  if (verb === 'team') {
    const loaded = host.runtime.loadedSessionMemory;
    notice(
      host,
      !loaded
        ? 'session memory has not loaded'
        : 'team preferences available in this session · context may be truncated\n' +
            loaded.documents
              .filter((d) => d.scope === 'team')
              .map((d) => `${d.title}\n${d.markdown}`)
              .join('\n\n') +
            '\n' +
            loaded.warnings.join('\n'),
    );
    return true;
  }
  if (
    !['personal', 'write', 'edit', 'enable', 'disable', 'delete'].includes(verb)
  )
    return false;
  const current = rows(host),
    memories = current.items.filter((i) => i.kind === 'memory_revision');
  if (verb === 'personal') {
    host.picker(
      'personal memory',
      memories.map((row, index) => ({
        key: String(index),
        label: `${index + 1}. ${rowText(row, current.objects)}`,
        meta: current.conflicts.has(row.item_id)
          ? 'conflicted'
          : ((current.objects.get(row.heads[0]!) as any).body.state ??
            'deleted'),
      })),
      (item) => {
        host.closePicker();
        show(host, memories[Number(item.key)]!, current.snapshot!);
      },
      { empty: 'no personal memory yet' },
    );
    return true;
  }
  if (verb === 'write') {
    const raw = args.trim().slice(verb.length).trim(),
      split = raw.indexOf('|');
    if (split <= 0) throw Error('usage: /memory write <title> | <text>');
    await apply(
      host,
      service(host).prepareMemory({
        expected_head: current.snapshot,
        title: raw.slice(0, split).trim(),
        markdown: raw.slice(split + 1).trim(),
      }),
      true,
    );
    return true;
  }
  const item = memories[Number(parts[0]) - 1];
  if (!item) throw Error('choose a number from /memory personal');
  const changes =
    verb === 'edit'
      ? { markdown: afterAddress(args) }
      : verb === 'delete'
        ? { delete: true }
        : {
            state:
              verb === 'enable' ? ('enabled' as const) : ('disabled' as const),
          };
  if (verb === 'edit' && !changes.markdown)
    throw Error('usage: /memory edit <number> <text>');
  await apply(
    host,
    service(host).prepareMemory({
      expected_head: current.snapshot,
      item_id: item.item_id,
      ...changes,
    }),
    true,
  );
  return true;
}
