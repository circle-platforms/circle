import { copyText } from '../host';
import { useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileDiff,
  ArrowUpRight,
  Terminal,
  Users,
  FileText,
} from 'lucide-react';
import type { ToolCall } from '../model/types';
import { useRuntime } from '../app/context';
import { DataBlock, IconButton, Status } from './common';
import { DiffBlock } from './DiffBlock';
import { t } from '../i18n';
import { relativePath } from '../model/format';
import { currentSession } from '../model/state';
export function ToolMessage({
  tool,
  expanded,
  onFile,
  onAgent,
}: {
  tool: ToolCall;
  expanded: boolean;
  onFile: (path: string) => void;
  onAgent: (id: string) => void;
}) {
  const [open, setOpen] = useState(expanded);
  const [tab, setTab] = useState<'output' | 'input'>('output');
  const { notify, runtime, snapshot } = useRuntime();
  const root = snapshot.workspaces.find(
    (workspace) => workspace.id === currentSession(snapshot).workspaceId,
  )?.path;
  useEffect(() => setOpen(expanded), [expanded]);
  const Icon =
    tool.name === 'task'
      ? Users
      : tool.name === 'execute'
        ? Terminal
        : tool.diff || tool.before !== undefined
          ? FileDiff
          : FileText;
  // A file change that happened shows its diff under the call; a waiting one shows it in
  // the request below, and one that failed changed nothing.
  const diff = tool.diff && tool.status === 'success' ? tool.diff : undefined;
  return (
    <div className={`tool-call tool-${tool.status}`}>
      <button
        className="tool-head"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="tool-icon">
          <Icon size={14} />
        </span>
        <code>{tool.name}</code>
        <span className="tool-target">
          {relativePath(
            String(
              tool.input.file_path ??
                tool.input.path ??
                tool.input.command ??
                tool.input.description ??
                tool.input.query ??
                tool.input.pattern ??
                '',
            ),
            root,
          )}
        </span>
        {diff && <span className="tool-diff-summary">{diff.summary}</span>}
        <span className="tool-time">{tool.elapsed}</span>
        {tool.status === 'success' ? (
          <Check size={13} />
        ) : (
          <Status value={tool.status} />
        )}
        <span>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </button>
      {diff && !open && (
        <div className="tool-diff">
          <DiffBlock diff={diff} compact />
        </div>
      )}
      {open && (
        <div className="tool-content">
          {diff && <DiffBlock diff={diff} />}
          <div className="tool-toolbar">
            <div className="segmented">
              <button
                className={tab === 'output' ? 'active' : ''}
                onClick={() => setTab('output')}
              >
                {t('output')}
              </button>
              <button
                className={tab === 'input' ? 'active' : ''}
                onClick={() => setTab('input')}
              >
                {t('input')}
              </button>
            </div>
            {tool.filePath && (
              <button
                className="text-button"
                onClick={() => onFile(tool.filePath!)}
              >
                {t('open file')}
                <ArrowUpRight size={12} />
              </button>
            )}
            {tool.agentId && (
              <button
                className="text-button"
                onClick={() => onAgent(tool.agentId!)}
              >
                {t('agent record')}
                <ArrowUpRight size={12} />
              </button>
            )}
            <IconButton
              label={t('copy tool output')}
              onClick={() =>
                copyText(
                  tab === 'input'
                    ? JSON.stringify(tool.input, null, 2)
                    : tool.output,
                ).then(
                  () => notify(t('copied')),
                  () => notify(t('clipboard unavailable')),
                )
              }
            >
              <Copy size={13} />
            </IconButton>
          </div>
          <DataBlock
            title={tab === 'input' ? t('raw input') : t('raw output')}
            value={tab === 'input' ? tool.input : tool.output}
          />
          {runtime.mode !== 'live' && (
            <div className="tool-meta">{tool.id} · sample record</div>
          )}
        </div>
      )}
    </div>
  );
}
