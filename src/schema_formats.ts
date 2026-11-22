import type { JsonSchemaType } from '@modelcontextprotocol/client';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';

// A format is an annotation (JSON Schema leaves it to whoever reads the document), and a validator checks the ones it
// knows. For each it does not know, Ajv prints a notice to standard error, over the screen of the terminal, every time
// it compiles a schema that names it, and the person at the terminal can do nothing about it. Circle leaves such a
// format to whoever wrote the schema, silently. Only this notice is left out: Ajv's other messages go where they went,
// and what a schema fails to be, or to compile as, is an error of the caller's.
const UNKNOWN_FORMAT = /^unknown format ".*" ignored in schema at path ".*"$/s;

/** Whether what a validator was told to print is its notice for a format it has no check for, as Ajv words it. */
export function isUnknownFormatNotice(args: readonly unknown[]): boolean {
  return (
    args.length === 1 &&
    typeof args[0] === 'string' &&
    UNKNOWN_FORMAT.test(args[0])
  );
}

/** The `logger` of an Ajv that Circle builds: the console, but for the notice of a format it has no check for. */
export const ajvLogger = {
  log: (...args: unknown[]): void => console.log(...args),
  warn: (...args: unknown[]): void => {
    if (!isUnknownFormatNotice(args)) console.warn(...args);
  },
  error: (...args: unknown[]): void => console.error(...args),
};

/**
 * Runs a compile that a library does on an Ajv of its own, which it lets nobody give a logger, with the notice of a
 * format it has no check for left out of the console. The compile is synchronous, so nothing else prints meanwhile,
 * and the console is given back when it ends or throws.
 */
export function withoutUnknownFormatNotices<T>(compile: () => T): T {
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (!isUnknownFormatNotice(args)) warn.apply(console, args);
  };
  try {
    return compile();
  } finally {
    console.warn = warn;
  }
}

/**
 * The library's validator of JSON Schema, which checks the formats `ajv-formats` has and says so of the others, said
 * no more: for the output schemas of an MCP server's tools, whose formats are the server's own.
 */
export class QuietJsonSchemaValidator extends AjvJsonSchemaValidator {
  override getValidator<T>(schema: JsonSchemaType) {
    return withoutUnknownFormatNotices(() => super.getValidator<T>(schema));
  }
}
