import { PNG } from 'pngjs';

// The largest picture Circle sends: about what the models read anyway (Anthropic scales a
// larger one down to this), and small enough that several fit in one request.
export const MAX_EDGE = 1568;
export const MAX_PIXELS = 1_150_000;
// Decoding more than this would take hundreds of megabytes
const MAX_DECODE_PIXELS = 60_000_000;

export interface Fitted {
  bytes: Buffer;
  width: number;
  height: number;
  /** The size it had before it was scaled down. */
  from?: { width: number; height: number };
}

/** A PNG's size from its header, without decoding it. */
export function pngSize(
  bytes: Buffer,
): { width: number; height: number } | undefined {
  if (
    bytes.length < 24 ||
    bytes.readUInt32BE(0) !== 0x89504e47 ||
    bytes.toString('latin1', 12, 16) !== 'IHDR'
  )
    return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * A PNG made to fit MAX_EDGE and MAX_PIXELS, each output pixel the average of the source
 * pixels it covers. One that fits, is too large to decode or cannot be read comes back as
 * it is (`width` 0 when its size is unknown).
 */
export function fitPng(bytes: Buffer): Fitted {
  const size = pngSize(bytes);
  if (!size) return { bytes, width: 0, height: 0 };
  const { width, height } = size;
  const scale = Math.min(
    1,
    MAX_EDGE / Math.max(width, height),
    Math.sqrt(MAX_PIXELS / (width * height)),
  );
  if (scale >= 1 || width * height > MAX_DECODE_PIXELS)
    return { bytes, width, height };
  let image: PNG;
  try {
    image = PNG.sync.read(bytes);
  } catch {
    return { bytes, width, height };
  }
  const outWidth = Math.max(1, Math.round(width * scale));
  const outHeight = Math.max(1, Math.round(height * scale));
  const pixels = shrink(image.data, width, height, outWidth, outHeight);
  let opaque = true;
  for (let at = 3; at < pixels.length && opaque; at += 4)
    opaque = pixels[at] === 255;
  const out = PNG.sync.write(
    Object.assign(new PNG({ width: outWidth, height: outHeight }), {
      data: pixels,
    }),
    { colorType: opaque ? 2 : 6, inputColorType: 6, inputHasAlpha: true },
  );
  return {
    bytes: out,
    width: outWidth,
    height: outHeight,
    from: { width, height },
  };
}

// Area averaging of RGBA rows, colour weighted by alpha so transparent pixels add no colour.
// One output row at a time: each source row is first averaged across into `across`.
function shrink(
  source: Buffer,
  width: number,
  height: number,
  outWidth: number,
  outHeight: number,
): Buffer {
  const out = Buffer.alloc(outWidth * outHeight * 4);
  const stepX = width / outWidth;
  const stepY = height / outHeight;
  const across = new Float64Array(outWidth * 4);
  const sum = new Float64Array(outWidth * 4);
  const reduce = (row: number): void => {
    across.fill(0);
    for (let x = 0; x < outWidth; x++) {
      const start = x * stepX;
      const end = start + stepX;
      const last = Math.min(width, Math.ceil(end));
      for (let column = Math.floor(start); column < last; column++) {
        const weight = Math.min(end, column + 1) - Math.max(start, column);
        const at = (row * width + column) * 4;
        const alpha = source[at + 3]! * weight;
        for (let channel = 0; channel < 3; channel++)
          across[x * 4 + channel] =
            across[x * 4 + channel]! + source[at + channel]! * alpha;
        across[x * 4 + 3] = across[x * 4 + 3]! + alpha;
      }
    }
  };
  for (let y = 0; y < outHeight; y++) {
    const start = y * stepY;
    const end = start + stepY;
    sum.fill(0);
    const last = Math.min(height, Math.ceil(end));
    for (let row = Math.floor(start); row < last; row++) {
      const weight = Math.min(end, row + 1) - Math.max(start, row);
      reduce(row);
      for (let at = 0; at < sum.length; at++)
        sum[at] = sum[at]! + across[at]! * weight;
    }
    for (let x = 0; x < outWidth; x++) {
      const alpha = sum[x * 4 + 3]!;
      const at = (y * outWidth + x) * 4;
      if (alpha > 0)
        for (let channel = 0; channel < 3; channel++)
          out[at + channel] = Math.round(sum[x * 4 + channel]! / alpha);
      out[at + 3] = Math.round(alpha / (stepX * stepY));
    }
  }
  return out;
}
