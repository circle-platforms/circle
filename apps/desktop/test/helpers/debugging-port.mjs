import { readFile } from 'node:fs/promises';

// The port in the file Chromium writes once it listens, or undefined while there is none
// to read yet: no file, an empty one, or one Chromium still holds, which Windows refuses
// to open with EBUSY. Any other failure is a real one.
export async function readDebuggingPort(file, read = readFile) {
  const text = await read(file, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT' || error?.code === 'EBUSY') return '';
    throw error;
  });
  return Number(text.split('\n')[0]) || undefined;
}
