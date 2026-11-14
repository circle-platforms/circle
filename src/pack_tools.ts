import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Ajv, type ValidateFunction } from 'ajv';
import { LIMITS, runTool, verifyInstalled } from './local_skills.js';
import { mcpToolName } from './mcp_loader.js';
import { isSafePackPath } from './pack_files.js';
import { identityEnvironment } from './sandbox.js';
import { expandVariables } from './secrets.js';
import type { Tool } from './types.js';

/**
 * Typed tools a pack declares for its scripts (#544). The pack lists `tools.json` in its manifest, so the file is
 * covered by the pack's digest like every other file. Each entry names a script under `tools/`, the JSON Schema of
 * its input, how the input becomes the script's arguments, and the environment Circle fills from variables and
 * secrets, which the model never sees.
 */
export const PACK_TOOLS_FILE = 'tools.json';

/** An argument the template takes from the input: `{ "flag": "--title", "param": "title" }`. */
export interface PackToolFlag {
  flag: string;
  param: string;
}

export interface PackToolDeclaration {
  name: string;
  description: string;
  /** A path under `tools/`, as `skill_run` takes it. */
  script: string;
  input_schema: Record<string, unknown>;
  /** The script's arguments: literal strings, `"{param}"` for a required parameter, or a flag for an optional one. */
  args: Array<string | PackToolFlag>;
  /** `json`: the whole input, as JSON, on standard input. */
  stdin?: 'json';
  /** Environment the script also gets. `%NAME%` takes a variable's or a secret's value when the script starts. */
  env: Record<string, string>;
}

const MAX_TOOLS = 32;
const NAME = '^[A-Za-z_][A-Za-z0-9_]{0,63}$';
const PARAM = /^\{([A-Za-z_][A-Za-z0-9_]{0,63})\}$/;
/** What Circle itself gives every script, which a declaration cannot replace. */
const RESERVED_ENV = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'NODE_OPTIONS',
  'CIRCLE_SESSION_ID',
  'CIRCLE_AGENT_ID',
]);

const SCALAR = { type: ['string', 'number', 'boolean'] };
const PROPERTY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { enum: ['string', 'number', 'integer', 'boolean', 'array'] },
    description: { type: 'string', maxLength: 1000 },
    enum: { type: 'array', minItems: 1, maxItems: 100, items: SCALAR },
    default: SCALAR,
    minimum: { type: 'number' },
    maximum: { type: 'number' },
    minLength: { type: 'integer', minimum: 0 },
    maxLength: { type: 'integer', minimum: 0 },
    pattern: { type: 'string', maxLength: 500 },
    minItems: { type: 'integer', minimum: 0 },
    maxItems: { type: 'integer', minimum: 0 },
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['type'],
      properties: {
        type: { const: 'string' },
        enum: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: { type: 'string' },
        },
        description: { type: 'string', maxLength: 1000 },
      },
    },
  },
  anyOf: [{ required: ['type'] }, { required: ['enum'] }],
};
const DECLARATION = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'tools'],
  properties: {
    version: { const: 1 },
    tools: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_TOOLS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description', 'script', 'input_schema'],
        properties: {
          name: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,47}$' },
          description: { type: 'string', minLength: 1, maxLength: 2000 },
          script: { type: 'string', minLength: 1, maxLength: 300 },
          input_schema: {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'properties'],
            properties: {
              type: { const: 'object' },
              properties: {
                type: 'object',
                maxProperties: 50,
                propertyNames: { pattern: NAME },
                additionalProperties: PROPERTY,
              },
              required: {
                type: 'array',
                uniqueItems: true,
                items: { type: 'string' },
              },
              additionalProperties: { const: false },
            },
          },
          args: {
            type: 'array',
            maxItems: 100,
            items: {
              anyOf: [
                { type: 'string', maxLength: 1000 },
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['flag', 'param'],
                  properties: {
                    flag: { type: 'string', pattern: '^-', maxLength: 100 },
                    param: { type: 'string', pattern: NAME },
                  },
                },
              ],
            },
          },
          stdin: { const: 'json' },
          env: {
            type: 'object',
            maxProperties: 50,
            propertyNames: { pattern: NAME },
            additionalProperties: { type: 'string', maxLength: 4000 },
          },
        },
      },
    },
  },
};
// Compiled on first use, not when Circle starts. Not strict, as for tool calls: strict mode prints its notes on
// union types to standard error, which a CLI run must keep clean.
let declarationCheck: ValidateFunction | undefined;
const validateDeclaration = (value: unknown): boolean =>
  (declarationCheck ??= new Ajv({ strict: false }).compile(DECLARATION))(value);

/**
 * The tools a declaration file names, or why it cannot be used. `files` are the paths the pack's manifest lists:
 * a script must be one of them.
 */
export function parsePackTools(
  text: string,
  files: readonly string[],
): PackToolDeclaration[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${PACK_TOOLS_FILE} is not JSON`);
  }
  if (!validateDeclaration(value)) {
    const error = declarationCheck?.errors?.[0];
    throw new Error(
      `${PACK_TOOLS_FILE}${error?.instancePath ? ` ${error.instancePath}` : ''} ${error?.message ?? 'is not valid'}`,
    );
  }
  const declared = (value as { tools: PackToolDeclaration[] }).tools;
  const names = new Set<string>();
  const listed = new Set(files);
  return declared.map((tool) => {
    const where = `${PACK_TOOLS_FILE} tool ${tool.name}`;
    if (names.has(tool.name)) throw new Error(`${where} is declared twice`);
    names.add(tool.name);
    if (
      !isSafePackPath(tool.script, LIMITS.maxDepth) ||
      !tool.script.startsWith('tools/') ||
      !/\.(?:ts|mts|js|mjs)$/.test(tool.script) ||
      !listed.has(tool.script)
    )
      throw new Error(
        `${where}: the script must be a .js or .ts file under tools/ that the pack lists`,
      );
    const properties = tool.input_schema.properties as Record<string, unknown>;
    const required = new Set(
      (tool.input_schema.required as string[] | undefined) ?? [],
    );
    for (const name of required)
      if (!Object.hasOwn(properties, name))
        throw new Error(`${where}: required ${name} is not a property`);
    for (const item of tool.args ?? []) {
      const param =
        typeof item === 'string' ? PARAM.exec(item)?.[1] : item.param;
      if (param === undefined) continue;
      if (!Object.hasOwn(properties, param))
        throw new Error(
          `${where}: args name ${param}, which is not a property`,
        );
      // A bare "{param}" always has a value to put there; an optional one goes with its flag or not at all
      if (typeof item === 'string' && !required.has(param))
        throw new Error(
          `${where}: optional ${param} needs the form { "flag": …, "param": "${param}" }`,
        );
    }
    for (const name of Object.keys(tool.env ?? {}))
      if (RESERVED_ENV.has(name))
        throw new Error(`${where}: env cannot set ${name}`);
    return {
      name: tool.name,
      description: tool.description,
      script: tool.script,
      input_schema: {
        type: 'object',
        properties,
        ...(required.size ? { required: [...required] } : {}),
        // Only what the declaration names reaches the script
        additionalProperties: false,
      },
      args: tool.args ?? [],
      ...(tool.stdin ? { stdin: tool.stdin } : {}),
      env: tool.env ?? {},
    };
  });
}

/** The tools an installed pack declares, read after the pack verifies against its manifest. */
export async function readPackTools(
  root: string,
  pack: string,
): Promise<PackToolDeclaration[]> {
  const directory = join(root, pack);
  await verifyInstalled(directory);
  // Every file the manifest lists was just checked against its digest
  const listed = (
    JSON.parse(await readFile(join(directory, 'pack.json'), 'utf8')) as {
      files: { path: string }[];
    }
  ).files.map((file) => file.path);
  if (!listed.includes(PACK_TOOLS_FILE)) return [];
  return parsePackTools(
    await readFile(join(directory, PACK_TOOLS_FILE), 'utf8'),
    listed,
  );
}

function argumentValues(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

/**
 * The script's arguments from the template and the call's input. A literal takes plain variables' values, never a
 * secret's: arguments are visible to other processes. A flag with no value given is left out; `true` is the flag
 * alone, `false` nothing, and each item of a list repeats the flag.
 */
export function packToolArgv(
  template: PackToolDeclaration['args'],
  input: Record<string, unknown>,
  variables: Record<string, string>,
): string[] {
  const argv: string[] = [];
  for (const item of template) {
    if (typeof item === 'string') {
      const param = PARAM.exec(item)?.[1];
      if (param === undefined) argv.push(expandVariables(item, variables));
      else argv.push(...argumentValues(input[param]));
      continue;
    }
    const value = input[item.param];
    if (value === undefined || value === null || value === false) continue;
    if (value === true) {
      argv.push(item.flag);
      continue;
    }
    for (const one of argumentValues(value)) argv.push(item.flag, one);
  }
  return argv;
}

/** The model's tool for one declared script of an installed pack. */
export function packTool(options: {
  root: string;
  pack: string;
  declaration: PackToolDeclaration;
  variables: () => Record<string, string>;
  secrets: () => Record<string, string>;
}): Tool {
  const { root, pack, declaration } = options;
  return {
    name: mcpToolName(pack, declaration.name),
    description: `${declaration.description}\n\nRuns ${declaration.script} of the installed pack ${pack}; returns exit_code, stdout, stderr and truncated.`,
    parameters: declaration.input_schema,
    effect: 'execute',
    // What the model writes is checked against the schema and runs as written, %NAME% included: values from
    // variables and secrets go only where the pack declared them
    variables: false,
    run: async (args, context) => {
      const variables = options.variables();
      const secrets = options.secrets();
      const env = {
        ...Object.fromEntries(
          Object.entries(declaration.env).map(([name, value]) => [
            name,
            expandVariables(value, { ...variables, ...secrets }),
          ]),
        ),
        ...identityEnvironment(context.identity),
      };
      return JSON.stringify(
        await runTool({
          root,
          pack,
          script: declaration.script,
          args: packToolArgv(declaration.args, args, variables),
          stdin: declaration.stdin === 'json' ? JSON.stringify(args) : '',
          variables,
          secrets,
          env,
          expand: false,
        }),
      );
    },
  };
}
