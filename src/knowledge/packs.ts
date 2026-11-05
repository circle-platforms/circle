import {
  lstatSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { KnowledgeStore, KnowledgeVersionConflict } from './store.js';
import {
  decodeSyncObject,
  encodeSyncObject,
  formatJcs,
  sha256,
} from './canonical.js';
import { requireClean } from './verification.js';
import type { PackManifest } from './types.js';
import { privateDirectory } from './objects.js';
import { parseStrictJson } from './strict-json.js';
import { assertNoCaseCollisions, readSafePackFileSync } from '../pack_files.js';

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
function takeFiles(
  directory: string,
  manifest: PackManifest,
): Map<string, Buffer> {
  let total = 0;
  const files = new Map<string, Buffer>();
  assertNoCaseCollisions(manifest.files.map((file) => file.path));
  for (const file of manifest.files) {
    total += file.size;
    if (total > MAX_PACK_BYTES) throw Error('personal pack byte limit');
    const bytes = readSafePackFileSync(directory, file.path, MAX_PACK_BYTES);
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
export async function inspectPersonalPackFolder(
  directory: string,
): Promise<PackManifest> {
  const manifest = parseStrictJson(
    readSafePackFileSync(directory, 'pack.json', MAX_PACK_BYTES).toString(
      'utf8',
    ),
  ) as unknown as PackManifest;
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
async function verifyPersonalPackCandidate(
  store: KnowledgeStore,
  options: {
    home: string;
    snapshot: string;
    object: string;
    directory: string;
    workspace: string;
    userHome: string;
    existingNames?: readonly string[];
  },
) {
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
    readSafePackFileSync(
      options.directory,
      'pack.json',
      MAX_PACK_BYTES,
    ).toString('utf8'),
  );
  if (
    formatJcs(supplied, { normalizeText: true }) !==
    formatJcs(manifest, { normalizeText: true })
  )
    throw Error('personal pack manifest differs from revision');
  const files = takeFiles(options.directory, manifest);
  return { manifest, files, discoverSkills };
}
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
    return (await verifyPersonalPackCandidate(store, options)).manifest;
  } finally {
    store.close();
  }
}
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
    const { manifest, files, discoverSkills } =
      await verifyPersonalPackCandidate(store, options);
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
