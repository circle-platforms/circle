import type { Attachment } from '../model/types';
import { useRuntime } from '../app/context';
import { copyText } from '../host';
import { t } from '../i18n';
import { Button } from './common';

/** Display recognition only. Attachment metadata never grants resource access. */
export function terminalSelectionDisplay(
  file: Attachment,
): { text: string; label: string; cwd: string } | undefined {
  const prefix = 'terminal-selection:';
  if (
    file.kind !== 'file' ||
    file.mime !== 'text/plain' ||
    !file.id.startsWith(prefix)
  )
    return;
  const captureId = file.id.slice(prefix.length);
  const marker = '\n\n--- terminal capture source ---\n';
  const offset = file.content.lastIndexOf(marker);
  if (!captureId || offset < 0) return;
  try {
    const metadata = JSON.parse(file.content.slice(offset + marker.length));
    if (
      metadata?.kind !== 'circle.terminal-selection' ||
      metadata.version !== 1 ||
      metadata.captureId !== captureId ||
      typeof metadata.label !== 'string' ||
      typeof metadata.cwd !== 'string'
    )
      return;
    return {
      text: file.content.slice(0, offset),
      label: metadata.label,
      cwd: metadata.cwd,
    };
  } catch {
    return;
  }
}
export function TerminalSelectionPreview({ file }: { file: Attachment }) {
  const { perform } = useRuntime();
  const display = terminalSelectionDisplay(file);
  if (!display) return <pre>{file.content}</pre>;
  return (
    <>
      <p className="panel-note">
        {display.label} · {display.cwd}
      </p>
      <pre className="terminal-selection-text" tabIndex={0}>
        {display.text}
      </pre>
      <Button onClick={() => perform(() => copyText(display.text))}>
        {t('copy selected text')}
      </Button>
      <details className="context-source terminal-selection-original">
        <summary>{t('original attachment and source details')}</summary>
        <pre tabIndex={0}>{file.content}</pre>
        <Button onClick={() => perform(() => copyText(file.content))}>
          {t('copy original attachment')}
        </Button>
      </details>
    </>
  );
}
