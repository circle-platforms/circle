import { FileCode, FileImage, FileJson, FileText } from 'lucide-react';

export type FileKind = 'image' | 'data' | 'text' | 'code' | 'plain';

/** A file's kind by its extension, for the shape of its icon. */
export function fileKind(name: string): FileKind {
  const extension = name.includes('.') ? name.split('.').at(-1)! : '';
  if (/^(png|jpe?g|gif|webp|svg|ico|bmp)$/i.test(extension)) return 'image';
  if (/^(json|jsonc|ya?ml|toml|lock|ini|env)$/i.test(extension)) return 'data';
  if (/^(md|mdx|txt|rst)$/i.test(extension)) return 'text';
  if (extension) return 'code';
  return 'plain';
}

/** One icon per kind of file. Colour belongs to a file's change, not to its type. */
export function FileIcon({ name, size = 14 }: { name: string; size?: number }) {
  const kind = fileKind(name);
  const Icon =
    kind === 'image'
      ? FileImage
      : kind === 'data'
        ? FileJson
        : kind === 'code'
          ? FileCode
          : FileText;
  return <Icon size={size} className={`file-icon ${kind}`} aria-hidden />;
}
