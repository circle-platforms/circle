import type { Attachment } from '../model/types';
import { t } from '../i18n';
import { CopyableText } from './common';

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
  const display = terminalSelectionDisplay(file);
  if (!display) return <pre>{file.content}</pre>;
  return (
    <>
      <p className="panel-note">
        {display.label} · {display.cwd}
      </p>
      <CopyableText
        className="terminal-selection-text"
        tabIndex={0}
        text={display.text}
        label={t('copy selected text')}
      />
      <details className="context-source terminal-selection-original">
        <summary>{t('original attachment and source details')}</summary>
        <CopyableText
          tabIndex={0}
          text={file.content}
          label={t('copy original attachment')}
        />
      </details>
    </>
  );
}
