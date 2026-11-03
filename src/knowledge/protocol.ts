import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AnySchema, ValidateFunction } from 'ajv';
import { knowledgeAsset } from '../knowledge_assets.js';
import type { PackManifest, SyncObject } from './types.js';
import { wellFormedText } from './unicode.js';

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export const SYNC_PROTOCOL = freeze(knowledgeAsset('protocol.json')) as {
  limits: {
    objectBytes: number;
    chunkBytes: number;
    batchObjects: number;
    pageItems: number;
    sessionSeconds: number;
  };
  defaultMode: 'hub';
  routes: Record<string, { method: string; path: string }>;
  kinds: string[];
  modes: string[];
  statuses: string[];
  entryKinds: string[];
  codes: string[];
  packPaths: string[];
  schemas: string[];
};
export const SYNC_LIMITS = Object.freeze(SYNC_PROTOCOL.limits);
export const isObjectId = (value: string): boolean =>
  /^[0-9a-f]{64}$/.test(value);
const sortedUnique = (values: string[]): boolean =>
  values.every((value, i) => i === 0 || values[i - 1]! < value);
const unique = (values: string[]): boolean =>
  new Set(values).size === values.length;
function requireRule(condition: boolean, rule: string): asserts condition {
  if (!condition) throw new TypeError(`invalid personal sync: ${rule}`);
}
export function decodeBase64(value: string): Buffer {
  requireRule(
    value.length <= 12 * 1024 * 1024 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        value,
      ),
    'base64',
  );
  const bytes = Buffer.from(value, 'base64');
  requireRule(bytes.toString('base64') === value, 'base64 padding');
  return bytes;
}
const ajv = new Ajv2020({
  strict: false,
  allErrors: false,
  coerceTypes: false,
  useDefaults: false,
});
ajv.addFormat(
  'uuid',
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i,
);
ajv.addFormat('date-time', (value: string) => {
  if (
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?Z$/.test(
      value,
    )
  )
    return false;
  const time = Date.parse(value);
  return (
    Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 10) === value.slice(0, 10)
  );
});
const validators = new Map<string, ValidateFunction>();
const schemas = new Map<string, AnySchema>();

/** Zod uses UTF-16 string lengths; JSON Schema uses Unicode code points. */
function stringLengths(schema: any, value: any): void {
  if (typeof value === 'string') {
    requireRule(
      schema.minLength === undefined || value.length >= schema.minLength,
      'string minimum',
    );
    requireRule(
      schema.maxLength === undefined || value.length <= schema.maxLength,
      'string maximum',
    );
  }
  if (schema.oneOf || schema.anyOf) {
    const choices = (schema.oneOf ?? schema.anyOf) as any[];
    // Select the structurally matching branch before its length refinements.
    const choice = choices.find((s) => ajv.validate(s, value));
    if (choice) stringLengths(choice, value);
  }
  if (Array.isArray(value) && schema.items)
    for (const item of value) stringLengths(schema.items, item);
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const child = schema.properties?.[key] ?? schema.additionalProperties;
      if (child && typeof child === 'object') stringLengths(child, item);
    }
  }
}
function packRules(manifest: PackManifest): void {
  const roots = new Set(
    SYNC_PROTOCOL.packPaths.map((path) => path.split('/')[0]),
  );
  const dirs = new Set(
    SYNC_PROTOCOL.packPaths
      .filter((path) => path.endsWith('/'))
      .map((path) => path.split('/')[0]),
  );
  const paths = manifest.files.map((file) => file.path);
  requireRule(
    unique(paths.map((path) => path.toLowerCase())),
    'pack paths unique without case',
  );
  requireRule(
    paths.every((path, i) => i === 0 || paths[i - 1]! <= path),
    'pack files ordered',
  );
  for (const path of paths) {
    const segments = path.split('/');
    requireRule(
      path.length > 0 &&
        path.length <= 200 &&
        segments.every(
          (s) => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(s) && !s.endsWith('.'),
        ),
      'pack path',
    );
    requireRule(
      segments.length > 1
        ? dirs.has(segments[0]!)
        : roots.has(path) && !dirs.has(path),
      'pack root',
    );
    requireRule(path !== 'pack.json', 'manifest excludes itself');
  }
  const required =
    manifest.kind === 'workflow'
      ? [
          'workflow.json',
          'requirements.json',
          'checks.json',
          'slots.schema.json',
          'SKILL.md',
        ]
      : ['skill.json', 'SKILL.md'];
  requireRule(
    required.every((path) =>
      paths.some((file) => file.toLowerCase() === path.toLowerCase()),
    ),
    'required pack files',
  );
  requireRule(
    unique(
      (manifest.dependencies ?? []).map(
        (d) => `${d.space ?? 'team'}/${d.pack}`,
      ),
    ),
    'unique pack dependencies',
  );
}
function objectRules(object: SyncObject): void {
  const body = object.body;
  if ('parents' in body)
    requireRule(sortedUnique(body.parents), 'ordered unique parents');
  switch (object.kind) {
    case 'bytes':
      requireRule(
        decodeBase64(object.body.bytes_base64).length <= SYNC_LIMITS.chunkBytes,
        'byte chunk limit',
      );
      break;
    case 'source_revision':
      requireRule(
        object.body.name === null || wellFormedText(object.body.name),
        'source name Unicode',
      );
      break;
    case 'entry_revision':
      requireRule(
        object.body.grounds.every(
          (ground) => !('source' in ground) || wellFormedText(ground.selector),
        ),
        'selector Unicode',
      );
      break;
    case 'directory_revision':
      requireRule(wellFormedText(object.body.name), 'directory Unicode');
      break;
    case 'memory_revision':
      requireRule(
        wellFormedText(object.body.title) &&
          wellFormedText(object.body.markdown),
        'memory Unicode',
      );
      break;
    case 'inventory_page':
      requireRule(
        sortedUnique(
          object.body.items.map((item) => `${item.kind}:${item.item_id}`),
        ),
        'ordered unique inventory',
      );
      for (const item of object.body.items)
        requireRule(
          sortedUnique(item.heads) && item.heads.length > 0,
          'ordered nonempty heads',
        );
      break;
    case 'snapshot':
      requireRule(sortedUnique(object.body.pages), 'ordered unique pages');
      break;
    case 'deletion':
      requireRule(object.body.parents.length > 0, 'deletion parents');
      break;
    case 'pack_manifest':
      packRules(object.body.manifest);
      break;
  }
}
/** No coercion, defaults, stripping or repair of a received protocol value. */
export function validateSync(schemaName: string, value: unknown): void {
  const file = `${schemaName.replace('@', '.v')}.schema.json`;
  requireRule(SYNC_PROTOCOL.schemas.includes(file), 'known schema');
  let validate = validators.get(schemaName);
  let schema = schemas.get(schemaName);
  if (!schema) {
    schema = knowledgeAsset(file) as AnySchema;
    schemas.set(schemaName, schema);
  }
  if (!validate) {
    validate = ajv.compile(schema);
    validators.set(schemaName, validate);
  }
  requireRule(validate(value), `schema ${schemaName}`);
  stringLengths(schema, value);
  const v = value as any;
  if (
    [
      'personal-sync-client@1',
      'personal-sync-inventory@1',
      'personal-sync-result@1',
      'personal-sync-session-reply@1',
    ].includes(schemaName)
  ) {
    for (const key of ['name', 'next', 'inventory_cursor'])
      if (typeof v[key] === 'string')
        requireRule(wellFormedText(v[key]), 'text Unicode');
  }
  if (schemaName === 'personal-sync-object@1') objectRules(v);
  if (
    schemaName === 'personal-sync-missing@1' ||
    schemaName === 'personal-sync-download@1'
  )
    requireRule(unique(v.objects), 'unique batch');
  if (
    schemaName === 'personal-sync-upload@1' ||
    schemaName === 'personal-sync-transfer@1'
  ) {
    if (schemaName.includes('upload'))
      requireRule(
        unique(v.objects.map((o: any) => o.id)),
        'unique upload objects',
      );
    for (const o of v.objects) decodeBase64(o.bytes_base64);
    if (v.missing) requireRule(unique(v.missing), 'unique missing objects');
  }
  if (schemaName === 'personal-sync-mode-change@1' && v.mode === 'local')
    requireRule(v.confirm_purge && v.check !== null, 'checked purge');
  if (schemaName === 'personal-sync-error@1')
    requireRule(SYNC_PROTOCOL.codes.includes(v.code), 'registered error');
  if (
    schemaName === 'personal-sync-verification@1' ||
    schemaName === 'personal-sync-result@1'
  ) {
    for (const observation of schemaName.includes('result')
      ? v.verification
      : [v])
      requireRule(
        observation.codes.every((c: string) => SYNC_PROTOCOL.codes.includes(c)),
        'registered verification codes',
      );
    if (v.conflicts)
      for (const conflict of v.conflicts)
        requireRule(
          (conflict.heads.length > 1 || conflict.structural === true) &&
            conflict.heads.length > 0 &&
            sortedUnique(conflict.heads),
          'conflict heads',
        );
  }
}
