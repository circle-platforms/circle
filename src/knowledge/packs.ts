import {
  lstatSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { KnowledgeStore, KnowledgeVersionConflict } from './store.js';
import { sha256 } from './canonical.js';
import { requireClean } from './verification.js';
import type { PackManifest } from './types.js';
import { privateDirectory } from './objects.js';
import { parseStrictJson } from './strict-json.js';
export interface InstalledPersonalPack {
  object: string;
  name: string;
  kind: PackManifest['kind'];
  path: string;
  manifest: PackManifest;
}
export type PackApproval = (
  change: {
    action: 'install' | 'enable' | 'disable';
    object: string;
    manifest: PackManifest;
    files: { path: string; sha256: string; size: number }[];
  },
  signal: AbortSignal,
) => Promise<'approve' | 'reject'>;
const MAX_PACK_BYTES = 32 * 1024 * 1024;
function fileAt(root: string, path: string): Buffer {
  if (lstatSync(root).isSymbolicLink())
    throw Error('pack root symlink refused');
  const directory = realpathSync(root),
    target = resolve(directory, path),
    rel = relative(directory, target);
  if (rel.startsWith('..') || isAbsolute(rel))
    throw Error('pack path escapes installation');
  let current = directory;
  for (const part of path.split('/')) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw Error('pack symlinks are not installed');
  }
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.size > MAX_PACK_BYTES)
    throw Error('pack file unavailable or oversized');
  return readFileSync(target);
}
function takeFiles(
  directory: string,
  manifest: PackManifest,
): Map<string, Buffer> {
  let total = 0;
  const files = new Map<string, Buffer>();
  const prefixes = new Map<string, string>();
  for (const file of manifest.files) {
    const parts = file.path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/'),
        key = prefix.toLowerCase();
      if (prefixes.has(key) && prefixes.get(key) !== prefix)
        throw Error('personal pack path component case collision');
      prefixes.set(key, prefix);
    }
  }
  // The manifest is data, and is checked against the exact immutable revision by the caller.
  for (const file of manifest.files) {
    total += file.size;
    if (total > MAX_PACK_BYTES) throw Error('personal pack byte limit');
    const bytes = fileAt(directory, file.path);
    if (bytes.length !== file.size || sha256(bytes) !== file.sha256)
      throw Error('personal pack size or digest mismatch');
    requireClean(bytes);
    files.set(file.path, bytes);
  }
  return files;
}
function manifestAt(
  store: KnowledgeStore,
  snapshot: string,
  object: string,
): PackManifest {
  if (store.head !== snapshot) throw new KnowledgeVersionConflict(store.head);
  const item = store
    .items()
    .find(
      (item) =>
        item.kind === 'pack_manifest' &&
        item.heads.length === 1 &&
        item.heads[0] === object,
    );
  const revision = store.read(object);
  if (!item || revision.kind !== 'pack_manifest')
    throw Error('personal pack is unavailable or conflicted');
  return revision.body.manifest;
}
/** Read a native-selected pack folder without importing code or changing its files. */
export async function inspectPersonalPackFolder(
  directory: string,
): Promise<PackManifest> {
  const manifest = parseStrictJson(
    fileAt(directory, 'pack.json').toString('utf8'),
  ) as unknown as PackManifest;
  const { encodeSyncObject, decodeSyncObject } = await import('./canonical.js');
  const bytes = encodeSyncObject({
    schema: 'personal-sync-object@1',
    kind: 'pack_manifest',
    body: {
      item_id: '00000000-0000-4000-8000-000000000000',
      parents: [],
      manifest,
    },
  });
  const object = decodeSyncObject(bytes, sha256(bytes));
  if (object.kind !== 'pack_manifest') throw Error('personal pack unavailable');
  takeFiles(directory, object.body.manifest);
  return object.body.manifest;
}
/** Native previews validate selected bytes before presenting the person confirmation; install rechecks them. */
export async function inspectPersonalPack(options: {
  home: string;
  snapshot: string;
  object: string;
  directory: string;
  workspace: string;
  userHome: string;
}): Promise<PackManifest> {
  const store = new KnowledgeStore(options.home);
  try {
    const manifest = manifestAt(store, options.snapshot, options.object);
    const { discoverSkills } = await import('../skills.js');
    if (
      discoverSkills(options.workspace, options.home, options.userHome).some(
        (s) => s.name.toLowerCase() === manifest.id.toLowerCase(),
      )
    )
      throw Error('a skill with this name already exists');
    const supplied = parseStrictJson(
      fileAt(options.directory, 'pack.json').toString('utf8'),
    );
    const { encodeSyncObject } = await import('./canonical.js');
    const wrap = (m: unknown) => ({
      schema: 'personal-sync-object@1',
      kind: 'pack_manifest',
      body: {
        item_id: '00000000-0000-4000-8000-000000000000',
        parents: [],
        manifest: m,
      },
    });
    if (
      !encodeSyncObject(wrap(supplied)).equals(encodeSyncObject(wrap(manifest)))
    )
      throw Error('personal pack manifest differs from revision');
    takeFiles(options.directory, manifest);
    return manifest;
  } finally {
    store.close();
  }
}
/** Explicit installation only. A synced manifest alone never installs executable files. */
export async function installPersonalPack(options: {
  home: string;
  snapshot: string;
  object: string;
  directory: string;
  workspace: string;
  userHome: string;
  existingNames?: readonly string[];
  approve: PackApproval;
  signal: AbortSignal;
}): Promise<void> {
  const store = new KnowledgeStore(options.home);
  let temporary: string | undefined;
  try {
    const manifest = manifestAt(store, options.snapshot, options.object);
    const { discoverSkills } = await import('../skills.js');
    const existingNames = [
      ...(options.existingNames ?? []),
      ...discoverSkills(options.workspace, options.home, options.userHome).map(
        (skill) => skill.name,
      ),
    ];
    if (
      existingNames.some(
        (name) => name.toLowerCase() === manifest.id.toLowerCase(),
      )
    )
      throw Error(
        'a skill with this name already exists; choose explicitly before replacing it',
      );
    const supplied = parseStrictJson(
      fileAt(options.directory, 'pack.json').toString('utf8'),
    );
    // Compare JSON data, using the pinned object codec rather than member insertion order.
    const { encodeSyncObject } = await import('./canonical.js');
    const wrap = (m: unknown) => ({
      schema: 'personal-sync-object@1',
      kind: 'pack_manifest',
      body: {
        item_id: '00000000-0000-4000-8000-000000000000',
        parents: [],
        manifest: m,
      },
    });
    if (
      !encodeSyncObject(wrap(supplied)).equals(encodeSyncObject(wrap(manifest)))
    )
      throw Error('personal pack manifest differs from revision');
    const files = takeFiles(options.directory, manifest);
    options.signal.throwIfAborted();
    if (
      (await options.approve(
        {
          action: 'install',
          object: options.object,
          manifest: structuredClone(manifest),
          files: manifest.files.map((file) => ({ ...file })),
        },
        options.signal,
      )) !== 'approve'
    )
      throw Error('personal pack installation rejected');
    options.signal.throwIfAborted();
    manifestAt(store, options.snapshot, options.object);
    if (
      discoverSkills(options.workspace, options.home, options.userHome).some(
        (skill) => skill.name.toLowerCase() === manifest.id.toLowerCase(),
      )
    )
      throw Error('a skill with this name appeared while awaiting approval');
    const root = join(store.directory, 'packs');
    privateDirectory(root);
    const destination = join(root, options.object);
    temporary = join(root, '.install-' + randomUUID());
    privateDirectory(temporary);
    for (const [path, bytes] of files) {
      const target = join(temporary, path);
      mkdirSync(resolve(target, '..'), { recursive: true, mode: 0o700 });
      writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' });
    }
    writeFileSync(join(temporary, 'pack.json'), JSON.stringify(manifest), {
      mode: 0o600,
      flag: 'wx',
    });
    // No hooks.json is in the protocol manifest. It is never copied from a selected skills folder.
    // The snapshot check and registration hold the database write lock during the atomic directory publication.
    store.installPack(options.snapshot, options.object, destination, () =>
      renameSync(temporary!, destination),
    );
    temporary = undefined;
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
    store.close();
  }
}
export async function setPersonalPackEnabled(options: {
  home: string;
  snapshot: string;
  object: string;
  enabled: boolean;
  approve: PackApproval;
  signal: AbortSignal;
}): Promise<void> {
  const store = new KnowledgeStore(options.home);
  try {
    const manifest = manifestAt(store, options.snapshot, options.object);
    const receipt = store
      .packInstallations()
      .find((row) => row.object === options.object);
    if (!receipt) throw Error('personal pack not installed');
    takeFiles(receipt.path, manifest);
    options.signal.throwIfAborted();
    if (
      (await options.approve(
        {
          action: options.enabled ? 'enable' : 'disable',
          object: options.object,
          manifest: structuredClone(manifest),
          files: manifest.files.map((file) => ({ ...file })),
        },
        options.signal,
      )) !== 'approve'
    )
      throw Error('personal pack change rejected');
    options.signal.throwIfAborted();
    store.installPack(
      options.snapshot,
      options.object,
      receipt.path,
      () => {},
      options.enabled,
    );
  } finally {
    store.close();
  }
}
export function installedPersonalPacks(home: string): InstalledPersonalPack[] {
  // Discovery must not create a store just to build a prompt.
  try {
    if (!lstatSync(join(home, 'knowledge', 'knowledge.sqlite')).isFile())
      return [];
  } catch {
    return [];
  }
  let store: KnowledgeStore;
  try {
    store = new KnowledgeStore(home);
  } catch {
    return [];
  }
  try {
    const head = store.head;
    if (!head) return [];
    const result: InstalledPersonalPack[] = [];
    for (const row of store.packInstallations())
      try {
        if (!row.enabled) continue;
        const manifest = manifestAt(store, head, row.object);
        takeFiles(row.path, manifest);
        if (lstatSync(row.path).isSymbolicLink()) continue;
        result.push({
          object: row.object,
          name: manifest.id,
          kind: manifest.kind,
          path: join(row.path, 'SKILL.md'),
          manifest,
        });
      } catch {
        /* Missing/changed files or conflict is unavailable, never an installed claim. */
      }
    return result;
  } finally {
    store.close();
  }
}
