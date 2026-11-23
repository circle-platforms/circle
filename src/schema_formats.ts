import type { JsonSchemaType } from '@modelcontextprotocol/client';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';

// Suppress Ajv's stderr warning on unknown JSON Schema annotation formats (e.g. uri)
// while keeping all other Ajv warnings and compilation errors intact.
const UNKNOWN_FORMAT = /^unknown format ".*" ignored in schema at path ".*"$/s;

export function isUnknownFormatNotice(args: readonly unknown[]): boolean {
  return (
    args.length === 1 &&
    typeof args[0] === 'string' &&
    UNKNOWN_FORMAT.test(args[0])
  );
}

export const ajvLogger = {
  log: (...args: unknown[]): void => console.log(...args),
  warn: (...args: unknown[]): void => {
    if (!isUnknownFormatNotice(args)) console.warn(...args);
  },
  error: (...args: unknown[]): void => console.error(...args),
};

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

export class QuietJsonSchemaValidator extends AjvJsonSchemaValidator {
  override getValidator<T>(schema: JsonSchemaType) {
    return withoutUnknownFormatNotices(() => super.getValidator<T>(schema));
  }
}
