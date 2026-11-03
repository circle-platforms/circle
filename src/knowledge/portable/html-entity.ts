// Decode one character-reference candidate in HTML text, using generated standard reference data.
import {
  HTML_NAMED_REFERENCES,
  HTML_NUMERIC_REPLACEMENTS,
} from './html-entities.generated.js';

export function decodeHtmlEntity(value: string): string {
  const numeric = /^&#(x[0-9a-f]+|[0-9]+);?$/i.exec(value);
  if (numeric) {
    const digits = numeric[1]!,
      point =
        digits[0]!.toLowerCase() === 'x'
          ? Number.parseInt(digits.slice(1), 16)
          : Number(digits);
    if (
      !Number.isSafeInteger(point) ||
      point > 0x10ffff ||
      (point >= 0xd800 && point <= 0xdfff)
    )
      return '\ufffd';
    return HTML_NUMERIC_REPLACEMENTS[point]! ?? String.fromCodePoint(point);
  }
  for (let length = value.length; length > 1; length--) {
    const prefix = value.slice(0, length);
    if (Object.hasOwn(HTML_NAMED_REFERENCES, prefix))
      return HTML_NAMED_REFERENCES[prefix]! + value.slice(length);
  }
  return value;
}
