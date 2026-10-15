import { desktopHost, saveExport } from '../host';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  Copy,
  Download,
  FileText,
  GitBranch,
  Plus,
  ShieldCheck,
  Terminal,
  X,
} from 'lucide-react';
import {
  PROVIDER_PRESETS,
  providerPreset,
  PROVIDER_PRESET_DATE,
} from '../../../../src/providers';
import { VERSION } from '../../../../src/version';
import { useRuntime } from '../app/context';
import { t, tn } from '../i18n';
import { DiffBlock } from '../components/DiffBlock';
import { BrowserApproval, requestReason } from './InlineRequest';
import { hasToolInput } from '../model/browser';
import { canArchiveSession } from '../model/session-management';
import { branchMessages, currentSession, sessionText } from '../model/state';
import type { DialogId, Interaction, Session } from '../model/types';
import {
  Button,
  Modal,
  SearchInput,
  DataBlock,
  Facts,
  Switch,
  Status,
} from '../components/common';
export const downloadFile = saveExport;
// Dialog titles. Functions, so a title follows the language when it changes.
const NAMES: Record<DialogId, () => string> = {
  rename: () => t('rename session'),
  'delete-session': () => t('delete session'),
  tree: () => t('session tree'),
  fork: () => t('fork session'),
  session: () => t('session details'),
  export: () => t('export session'),
  editor: () => t('draft editor'),
  connect: () => t('connection'),
  trust: () => t('workspace trust'),
  preview: () => 'frontend preview',
  hotkeys: () => t('keyboard shortcuts'),
  compact: () => t('compact context'),
  exit: () => t('close session'),
  secret: () => t('secret input'),
  'job-stop': () => t('stop background job'),
};
// Who wrote a message in the session tree.
const ROLE_TEXT: Record<string, () => string> = {
  user: () => t('you'),
  assistant: () => 'circle',
  tool: () => t('tool'),
  notice: () => t('notice'),
};
// The app's own keys, as the composer and the menus handle them (Conversation.tsx,
// App.tsx, the main process menu); the terminal's keys differ.
function desktopShortcuts(): [string, string][] {
  const mod =
    document.documentElement.dataset.desktop === 'darwin' ? '⌘' : 'Ctrl+';
  return [
    [
      'Enter',
      t('send; while Circle works, it reads it after its current step'),
    ],
    ['Shift+Enter', t('new line')],
    ['Alt+Enter', t('queue a follow-up for after the turn')],
    ['Shift+Tab', t('next approval mode')],
    ['Esc', t('stop the turn, or clear the box')],
    ['Esc Esc', t('session tree, with an empty box')],
    ['↑ ↓', t('earlier messages, at the start of the box')],
    ['Alt+↑', t('take back queued messages')],
    ['?', t('this list, with an empty box')],
    [mod + 'K', t('search')],
    [mod + 'F', t('find in conversation')],
    [mod + 'N', t('new session')],
    [mod + 'O', t('open folder')],
    [mod + ',', t('settings')],
    [mod + 'P', t('next model')],
    [mod + 'L', t('models')],
    [mod + 'T', t('show or hide thinking')],
    [mod + 'G', t('write the message in a larger editor')],
    [mod + 'S', t('enter a secret')],
    [mod + 'X', t('copy the last answer, when nothing is selected')],
  ];
}
// What the runtime's probe-connection answers (src/probe.ts resolveEndpoint): the kind of
// API, the models it lists and the URL that answered. Never the key.
interface ConnectionProbe {
  status: 'discovered' | 'empty' | 'failed' | 'preset';
  protocol: 'openai' | 'anthropic';
  models: string[];
  baseUrl: string;
  inferred: boolean;
  summary: string;
  detail: string;
}
const hostOf = (url: string): string => {
  try {
    return new URL(url.trim()).host.toLowerCase();
  } catch {
    return '';
  }
};
// The connection, asked as the terminal's /login asks it: the URL and the key, then what the
// endpoint lists, or the kind of API and a typed model id when it lists nothing. The key is
// kept in this component's state only and is gone when the dialog closes.
function ConnectionWizard({ onClose }: { onClose: () => void }) {
  const { snapshot, runtime, notify } = useRuntime();
  const current = currentSession(snapshot);
  const [providerId, setProviderId] = useState('custom');
  const provider = providerPreset(providerId);
  const [endpoint, setEndpoint] = useState(snapshot.settings.endpoint);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [probe, setProbe] = useState<ConnectionProbe | null>(null);
  const [protocol, setProtocol] = useState<'openai' | 'anthropic'>('openai');
  const [query, setQuery] = useState('');
  const [focus, setFocus] = useState(0);
  const [typedModel, setTypedModel] = useState('');
  const list = useRef<HTMLDivElement>(null);
  // As in the terminal: an empty key keeps the saved one only on the saved endpoint's host.
  const savedHost = hostOf(snapshot.settings.endpoint);
  const keepsKey =
    !!snapshot.runtime?.hasKey && !!savedHost && hostOf(endpoint) === savedHost;
  // Nothing listed to choose from: the kind of API when it could not tell, and a typed id
  const manual = !!probe && (probe.status === 'failed' || probe.inferred);
  const listed = !!probe && !manual && probe.models.length > 0;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const typed = query.trim();
  const choices = probe
    ? [
        ...probe.models
          .filter((id) =>
            words.every((word) => id.toLowerCase().includes(word)),
          )
          .map((id) => ({ id, listed: true })),
        ...(typed && !probe.models.includes(typed)
          ? [{ id: typed, listed: false }]
          : []),
      ]
    : [];
  const chosenIndex = Math.min(focus, choices.length - 1);
  const chosen = choices[chosenIndex];
  useEffect(() => {
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [focus, query, probe]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      if (!probe) {
        let url: URL | undefined;
        try {
          url = new URL(endpoint.trim());
        } catch {
          url = undefined;
        }
        if (
          !url ||
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw Error(
            t('use an http or https endpoint without credentials in the URL'),
          );
        const found = (await runtime.request('probe-connection', {
          endpoint: endpoint.trim(),
          apiKey: secret,
          provider: providerId,
        })) as ConnectionProbe;
        setProtocol(found.protocol === 'anthropic' ? 'anthropic' : 'openai');
        setQuery('');
        setTypedModel('');
        setFocus(Math.max(0, found.models.indexOf(current.model)));
        setProbe(found);
        return;
      }
      const model = listed ? chosen?.id : typedModel.trim();
      if (!model) throw Error(t('choose a model or type its id'));
      await runtime.request('configure-connection', {
        // The URL that answered; for a kind of API chosen here, the URL as typed
        endpoint: manual ? endpoint.trim() : probe.baseUrl,
        protocol: manual ? protocol : probe.protocol,
        model,
        apiKey: secret,
      });
      setSecret('');
      notify(t('connection saved'));
      onClose();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : t('action failed'));
    } finally {
      setBusy(false);
    }
  };
  const actions = (primary: string) => (
    <div className="dialog-actions">
      {probe ? (
        <Button
          type="button"
          disabled={busy}
          onClick={() => {
            setError('');
            setProbe(null);
          }}
        >
          {t('back')}
        </Button>
      ) : (
        <Button
          type="button"
          onClick={() => {
            setSecret('');
            onClose();
          }}
        >
          {t('cancel')}
        </Button>
      )}
      <Button type="submit" className="primary" disabled={busy}>
        {primary}
      </Button>
    </div>
  );
  const problem = error && (
    <p className="inline-error" role="alert">
      {error}
    </p>
  );
  if (!probe)
    return (
      <form className="form-stack" onSubmit={submit}>
        <div className="connection-banner">
          <Status
            value={
              snapshot.runtime?.configured ? 'configured' : 'not configured'
            }
          />
          <span>{t('API URL, key and model')}</span>
        </div>
        {!snapshot.runtime?.configured && (
          <p className="dialog-paragraph">
            {t(
              'Circle answers with your own model endpoint. Enter its API URL, key and model to start.',
            )}
          </p>
        )}
        <label>
          {t('provider')}
          <select
            aria-label={t('provider')}
            value={providerId}
            disabled={busy}
            onChange={(event) => {
              const next = providerPreset(event.target.value);
              setProviderId(next.id);
              setEndpoint(
                next.baseUrl ||
                  (next.id === 'custom' ? snapshot.settings.endpoint : ''),
              );
              setSecret('');
              setError('');
            }}
          >
            {PROVIDER_PRESETS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id === 'custom' ? t('custom endpoint') : item.name}
              </option>
            ))}
          </select>
        </label>
        <p className="panel-note">
          {provider.source === 'preset'
            ? t(
                'Choose from provider presets next, or type a model id. The key and model are not checked.',
              )
            : t(
                'Next asks this endpoint for its online model list. You can also type a model id.',
              )}
        </p>
        {provider.id === 'bedrock-anthropic' && (
          <p className="panel-note">
            {t('Use a Bedrock API key and choose your region in the base URL.')}
          </p>
        )}
        {(provider.id === 'azure' || provider.id === 'foundry-anthropic') && (
          <p className="panel-note">
            {t(
              'Enter your resource base URL and deployment name. Public model names are not deployment names.',
            )}
          </p>
        )}
        <label>
          {t('base url')}
          <input
            type="url"
            required
            autoFocus
            placeholder="https://api.example.com/v1"
            aria-label={t('base url')}
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
          />
        </label>
        <label>
          {t('api key')}
          <input
            type="password"
            autoComplete="off"
            aria-label={t('api key')}
            required={!keepsKey}
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            placeholder={
              keepsKey ? t('leave empty to keep the saved key') : t('required')
            }
          />
        </label>
        <p className="panel-note">
          {t(
            'The key is saved privately by Circle. It is excluded from conversations and frontend storage.',
          )}
        </p>
        {busy && (
          <p className="pending-message" role="status">
            <i />
            {t('looking for models…')}
          </p>
        )}
        {problem}
        {actions(t('next'))}
      </form>
    );
  const move = (delta: number) => {
    if (choices.length)
      setFocus((chosenIndex + delta + choices.length) % choices.length);
  };
  return (
    <form className="form-stack" onSubmit={submit}>
      <div className="connection-banner">
        <span>
          <i />
          {probe.status === 'preset'
            ? t('provider presets ({date}); unverified', {
                date: PROVIDER_PRESET_DATE,
              })
            : manual
              ? probe.detail
                ? t('model discovery failed ({detail})', {
                    detail: probe.detail,
                  })
                : t('model discovery failed')
              : probe.models.length
                ? tn(
                    probe.models.length,
                    'discovered {n} model ({protocol})',
                    'discovered {n} models ({protocol})',
                    { protocol: probe.protocol },
                  )
                : t('the endpoint listed no models')}
        </span>
        <code>{manual ? endpoint.trim() : probe.baseUrl}</code>
      </div>
      {probe.status === 'preset' && (
        <p className="panel-note">
          {t(
            'These ids ship with Circle. Availability depends on your provider and account; you can enter another id.',
          )}
        </p>
      )}
      {listed ? (
        <>
          <SearchInput
            value={query}
            onChange={(value) => {
              setQuery(value);
              setFocus(0);
            }}
            label={t('search models')}
            inputProps={{
              autoFocus: true,
              role: 'combobox',
              'aria-expanded': true,
              'aria-controls': 'connection-model-choices',
              'aria-activedescendant': chosen
                ? `connection-choice-${chosenIndex}`
                : undefined,
              onKeyDown: (event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  move(event.key === 'ArrowDown' ? 1 : -1);
                }
              },
            }}
          />
          <div
            className="model-choices"
            role="listbox"
            id="connection-model-choices"
            aria-label={t('models')}
            ref={list}
          >
            {choices.map((choice, index) => (
              <button
                type="button"
                role="option"
                id={`connection-choice-${index}`}
                tabIndex={-1}
                key={(choice.listed ? 'model:' : 'use:') + choice.id}
                aria-selected={index === chosenIndex}
                className={index === chosenIndex ? 'selected' : ''}
                onClick={() => setFocus(index)}
              >
                <span>
                  {choice.listed
                    ? choice.id
                    : t('use “{model}”', { model: choice.id })}
                </span>
                {choice.listed && probe.status === 'preset' && (
                  <small>{t('preset')}</small>
                )}
                {choice.listed && choice.id === current.model && (
                  <small>{t('current')}</small>
                )}
                {!choice.listed && <small>{t('not listed')}</small>}
              </button>
            ))}
            {!choices.length && (
              <p className="model-choices-empty">
                {t('no model has that name')}
              </p>
            )}
          </div>
        </>
      ) : (
        <>
          {manual && !provider.protocol && (
            <div className="field-label">
              {t('kind of API')}
              <div
                className="segmented"
                role="radiogroup"
                aria-label={t('kind of API')}
              >
                {(['openai', 'anthropic'] as const).map((kind) => (
                  <button
                    type="button"
                    role="radio"
                    key={kind}
                    aria-checked={protocol === kind}
                    className={protocol === kind ? 'active' : ''}
                    onClick={() => setProtocol(kind)}
                  >
                    {kind === 'openai'
                      ? t('openai-style')
                      : t('anthropic-style')}
                  </button>
                ))}
              </div>
            </div>
          )}
          <label>
            {t('model')}
            <input
              required
              autoFocus
              aria-label={t('connection model')}
              placeholder={t('the model id your endpoint uses')}
              value={typedModel}
              onChange={(event) => setTypedModel(event.target.value)}
            />
          </label>
          <p className="panel-note">
            {probe.status === 'preset'
              ? t('Enter the deployment name from your provider console.')
              : t(
                  'The endpoint did not list its models, so the id is not checked: type the one your provider documents.',
                )}
          </p>
        </>
      )}
      {problem}
      {actions(t('connect'))}
    </form>
  );
}
export function DialogHost({
  dialog,
  selection,
  onClose,
  onSession,
}: {
  dialog: DialogId | null;
  selection: string;
  onClose: () => void;
  onSession: () => void;
}) {
  const { snapshot, runtime, perform, notify } = useRuntime();
  const current = currentSession(snapshot);
  const target =
    snapshot.sessions.find((session) => session.id === selection) ?? current;
  const workspace = snapshot.workspaces.find(
    (item) =>
      item.id ===
      (dialog === 'trust' && selection ? selection : target.workspaceId),
  )!;
  const [title, setTitle] = useState('');
  const [editor, setEditor] = useState('');
  const [query, setQuery] = useState('');
  const [userOnly, setUserOnly] = useState(false);
  const [selectedNode, setSelectedNode] = useState('');
  const [label, setLabel] = useState('');
  const [format, setFormat] = useState('markdown');
  const [endpoint, setEndpoint] = useState('');
  const [protocol, setProtocol] = useState<'openai' | 'anthropic'>('openai');
  const [model, setModel] = useState('');
  const [secret, setSecret] = useState('');
  const [resetConfirm, setResetConfirm] = useState(false);
  const [hint, setHint] = useState('');
  useEffect(() => {
    setTitle(target.title);
    setEditor(current.draft);
    setQuery('');
    setSelectedNode(current.leafId ?? '');
    setLabel('');
    setEndpoint(snapshot.settings.endpoint);
    setProtocol(snapshot.settings.protocol);
    setModel(snapshot.runtime?.configured === false ? '' : current.model);
    setSecret('');
    setFormat(
      selection === 'html'
        ? 'html'
        : selection === 'jsonl'
          ? 'json'
          : 'markdown',
    );
    setResetConfirm(false);
    setHint('');
  }, [dialog, selection]);
  const selectedJob = snapshot.jobs.find((job) => job.id === selection);
  const selectedSecret = snapshot.interactions.find(
    (item) =>
      item.sessionId === current.id &&
      item.kind === 'secret' &&
      item.status === 'pending',
  );
  const nodes = current.messages.filter(
    (message) =>
      ((dialog !== 'fork' && (!userOnly || message.role === 'user')) ||
        message.role === 'user') &&
      (message.text + ' ' + message.label + ' ' + message.role)
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const selectedMessage = current.messages.find(
    (message) => message.id === selectedNode,
  );
  const cancelSecret = () =>
    perform(async () => {
      setSecret('');
      if (runtime.mode === 'live' && selectedSecret?.status === 'pending')
        await runtime.request('cancel-interaction', {
          id: selectedSecret.id,
          revision: selectedSecret.revision,
          cancel: true,
        });
      onClose();
    });
  return (
    <Modal
      open={!!dialog}
      onOpenChange={(open) => {
        if (!open) {
          if (dialog === 'secret') {
            cancelSecret();
            return;
          }
          setSecret('');
          onClose();
        }
      }}
      title={dialog ? NAMES[dialog]() : ''}
      wide={['tree', 'fork', 'editor', 'hotkeys', 'session', 'export'].includes(
        dialog ?? '',
      )}
    >
      {dialog === 'rename' && (
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            perform(() => {
              runtime.change((state) => {
                state.sessions.find(
                  (session) => session.id === target.id,
                )!.title = title.trim() || target.title;
              });
              onClose();
            });
          }}
        >
          <label>
            {t('session name')}
            <input
              autoFocus
              aria-label={t('session name')}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <div className="dialog-actions">
            <Button onClick={onClose} type="button">
              {t('cancel')}
            </Button>
            <Button className="primary" type="submit">
              {t('save')}
            </Button>
          </div>
        </form>
      )}
      {dialog === 'delete-session' && (
        <>
          <p className="dialog-paragraph">
            {runtime.mode === 'live'
              ? !canArchiveSession(snapshot, target)
                ? t(
                    'Stop all work in “{title}”, then delete its saved conversation?',
                    {
                      title: target.title,
                    },
                  )
                : t('Delete “{title}” and its saved conversation?', {
                    title: target.title,
                  })
              : `Delete “${target.title}” from this browser preview?`}
          </p>
          <div className="dialog-actions">
            <Button onClick={onClose}>{t('keep session')}</Button>
            <Button
              className="danger"
              onClick={() =>
                perform(async () => {
                  await runtime.deleteSession(target.id, true);
                  onClose();
                })
              }
            >
              {runtime.mode === 'live' && !canArchiveSession(snapshot, target)
                ? t('stop work and delete session')
                : t('delete local session')}
            </Button>
          </div>
        </>
      )}
      {(dialog === 'tree' || dialog === 'fork') && (
        <>
          <div className="list-toolbar">
            <SearchInput
              value={query}
              onChange={setQuery}
              label={t('search session tree')}
            />
            {dialog === 'tree' && (
              <Switch
                label={t('user messages only')}
                checked={userOnly}
                onChange={setUserOnly}
              />
            )}
          </div>
          <p className="panel-note">
            {dialog === 'fork'
              ? t('Create a new session from before a user message.')
              : t('Choose what the next message continues from.')}{' '}
            {t('File changes are not reverted.')}
          </p>
          <div className="session-tree">
            {nodes.map((message) => {
              const depth = branchMessages({
                ...current,
                leafId: message.id,
              }).length;
              return (
                <button
                  key={message.id}
                  className={
                    selectedNode === message.id
                      ? 'tree-node selected'
                      : 'tree-node'
                  }
                  style={{ paddingLeft: Math.min(depth, 6) * 12 + 10 }}
                  onClick={() => {
                    setSelectedNode(message.id);
                    setLabel(message.label ?? '');
                  }}
                >
                  <GitBranch size={13} />
                  <span>
                    <strong>
                      {ROLE_TEXT[message.role]?.() ?? message.role}
                      {message.label ? ' · ' + message.label : ''}
                    </strong>
                    <p>{message.text || message.tool?.name}</p>
                  </span>
                  {current.leafId === message.id && <Status value="active" />}
                </button>
              );
            })}
          </div>
          {selectedMessage && (
            <div className="tree-selection">
              <label>
                {t('label')}
                <input
                  aria-label={t('node label')}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </label>
              <Button
                disabled={Boolean(current.archivedAt)}
                onClick={() =>
                  perform(() => {
                    runtime.change((state) => {
                      currentSession(state).messages.find(
                        (message) => message.id === selectedNode,
                      )!.label = label;
                    });
                    notify(t('message label saved'));
                  })
                }
              >
                {t('save label')}
              </Button>
              <Button
                className="primary"
                disabled={
                  current.state === 'waiting' ||
                  (dialog !== 'fork' && Boolean(current.archivedAt))
                }
                onClick={() =>
                  perform(async () => {
                    await runtime.branch(
                      selectedNode,
                      dialog === 'fork' ? 'fork' : 'tree',
                    );
                    onClose();
                    onSession();
                  })
                }
              >
                {dialog === 'fork' ? t('create fork') : t('continue from here')}
              </Button>
            </div>
          )}
        </>
      )}
      {dialog === 'session' && (
        <>
          <Facts
            values={{
              [t('session')]: current.id,
              [t('title')]: current.title,
              [t('workspace')]: workspace.path,
              [t('model')]: current.model,
              [t('effort')]: current.effort,
              [t('messages')]: current.messages.length,
              [t('visible branch')]: branchMessages(current).length,
              [t('tool calls')]: current.messages.filter(
                (message) => message.tool,
              ).length,
              [t('active node')]: current.leafId ?? t('none'),
              [t('storage')]:
                runtime.mode === 'live'
                  ? t('Circle data folder')
                  : 'isolated browser preview',
              [t('runtime')]:
                runtime.mode === 'live'
                  ? snapshot.runtime?.connected
                    ? t('running')
                    : t('stopped')
                  : 'not connected',
            }}
          />
          <details className="raw-session">
            <summary>{t('raw session and pending input')}</summary>
            <DataBlock title={t('session snapshot')} value={current} />
          </details>
        </>
      )}
      {dialog === 'editor' && (
        <>
          <textarea
            autoFocus
            className="code-editor editor-draft"
            aria-label={t('expanded message draft')}
            value={editor}
            onChange={(event) => setEditor(event.target.value)}
          />
          <div className="dialog-actions">
            {runtime.mode === 'preview' && (
              <Button
                onClick={() => {
                  runtime.request('external-editor', { draft: editor });
                  notify('external editor requires a native host');
                }}
              >
                external editor
              </Button>
            )}
            <Button
              className="primary"
              onClick={() =>
                perform(() => {
                  runtime.change((state) => {
                    currentSession(state).draft = editor;
                  });
                  onClose();
                })
              }
            >
              {t('use draft')}
            </Button>
          </div>
        </>
      )}
      {dialog === 'export' && runtime.mode === 'live' && (
        <div className="form-stack">
          <p className="dialog-paragraph">
            {t(
              'Export the saved Circle conversation. JSONL includes its native checkpoint graph and receipts.',
            )}
          </p>
          {(['jsonl', 'html', 'md'] as const).map((kind) => (
            <Button
              key={kind}
              onClick={() =>
                perform(async () => {
                  const saved = await runtime.request('export-session', {
                    format: kind,
                  });
                  notify(saved ? t('session exported') : t('export cancelled'));
                })
              }
            >
              {t('export {kind}', { kind })}
            </Button>
          ))}
        </div>
      )}
      {dialog === 'export' && runtime.mode === 'preview' && (
        <>
          <div className="list-toolbar">
            <label>
              format
              <select
                aria-label="export format"
                value={format}
                onChange={(event) => setFormat(event.target.value)}
              >
                <option value="markdown">markdown</option>
                <option value="html">html</option>
                <option value="json">preview bundle</option>
              </select>
            </label>
            <Button
              onClick={async () => {
                const plain = sessionText(current);
                const escaped = plain
                  .replaceAll('&', '&amp;')
                  .replaceAll('<', '&lt;')
                  .replaceAll('>', '&gt;');
                const content =
                  format === 'json'
                    ? JSON.stringify(
                        {
                          schema: 'circle-workbench-preview/v1',
                          session: current,
                        },
                        null,
                        2,
                      )
                    : format === 'html'
                      ? `<!doctype html><meta charset="utf-8"><title>Circle preview</title><pre>${escaped}</pre>`
                      : plain;
                const saved = await downloadFile(
                  'circle-preview.' +
                    (format === 'json'
                      ? 'json'
                      : format === 'html'
                        ? 'html'
                        : 'md'),
                  content,
                );
                notify(saved ? 'preview exported' : 'export cancelled');
              }}
            >
              <Download size={14} />
              download preview
            </Button>
          </div>
          <DataBlock title="preview content" value={sessionText(current)} />
          <p className="panel-note">
            Native Circle JSONL export and checksums need the connected runtime.
            A preview bundle is only for this frontend.
          </p>
          <div className="dialog-actions">
            <Button
              onClick={() => {
                runtime.request('export-session', {
                  format: selection || format,
                });
                notify('native export request recorded');
              }}
            >
              request native export
            </Button>
            <Button
              onClick={async () => {
                const saved = await downloadFile(
                  'circle-share.md',
                  sessionText(current),
                );
                if (saved) {
                  perform(() =>
                    runtime.change((state) => {
                      currentSession(state).shared = true;
                    }),
                  );
                  notify('local copy saved; nothing was uploaded');
                }
              }}
            >
              share local copy
            </Button>
          </div>
        </>
      )}
      {dialog === 'connect' && runtime.mode === 'live' && (
        <ConnectionWizard onClose={onClose} />
      )}
      {dialog === 'connect' && runtime.mode !== 'live' && (
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            perform(async () => {
              const url = new URL(endpoint);
              if (
                !['http:', 'https:'].includes(url.protocol) ||
                url.username ||
                url.password
              )
                throw Error(
                  t(
                    'use an http or https endpoint without credentials in the URL',
                  ),
                );
              runtime.change((state) => {
                state.settings.endpoint = endpoint;
                state.settings.protocol = protocol;
                currentSession(state).model = model;
              });
              runtime.request('configure-connection', {
                endpoint,
                protocol,
                model,
                credentialProvided: !!secret,
              });
              setSecret('');
              notify(
                'connection draft saved; key discarded, no endpoint contacted',
              );
              onClose();
            });
          }}
        >
          <div className="connection-banner">
            <Status value="not configured" />
            <span>{t('API URL, key and model')}</span>
          </div>
          <label>
            {t('base url')}
            <input
              type="url"
              required
              autoFocus
              placeholder="https://api.example.com/v1"
              aria-label={t('base url')}
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
            />
          </label>
          <label>
            {t('protocol')}
            <select
              value={protocol}
              onChange={(event) =>
                setProtocol(event.target.value as typeof protocol)
              }
            >
              <option value="openai">openai</option>
              <option value="anthropic">anthropic</option>
            </select>
          </label>
          <label>
            {t('api key')}
            <input
              type="password"
              autoComplete="off"
              aria-label={t('api key')}
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder="not saved or sent by this preview"
            />
          </label>
          <label>
            {t('model')}
            <input
              required
              aria-label={t('connection model')}
              placeholder={t('the model id your endpoint uses')}
              list="connection-models"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
            <datalist id="connection-models">
              {snapshot.models
                .filter((item) => item.id !== 'not connected')
                .map((item) => (
                  <option key={item.id}>{item.id}</option>
                ))}
            </datalist>
          </label>
          <p className="panel-note">
            Credentials stay in this form and are discarded when it closes. The
            desktop host will own the actual connection.
          </p>
          <div className="dialog-actions">
            <Button
              type="button"
              onClick={() => {
                setSecret('');
                onClose();
              }}
            >
              {t('cancel')}
            </Button>
            <Button type="submit" className="primary">
              save connection draft
            </Button>
          </div>
        </form>
      )}
      {dialog === 'trust' && (
        <>
          <p className="dialog-paragraph">{workspace.path}</p>
          <p className="dialog-paragraph">
            {t(
              "Circle can load this workspace's instructions, skills, commands, settings and extensions after you trust it. Extensions run code in the runtime.",
            )}
          </p>
          {workspace.instructions.map((item) => (
            <details className="context-source" key={item.name}>
              <summary>{item.name}</summary>
              <pre>{item.content}</pre>
            </details>
          ))}
          <p className="panel-note">
            {workspace.origin === 'native'
              ? t(
                  'This choice is kept locally. The connected Circle runtime must enforce workspace trust before loading project code.',
                )
              : 'This choice applies only to the sample workspace. No folder is opened or loaded.'}
          </p>
          <div className="dialog-actions">
            <Button onClick={onClose}>{t('cancel')}</Button>
            <Button
              className="primary"
              onClick={() =>
                perform(async () => {
                  if (runtime.mode === 'live') {
                    await runtime.request('trust-workspace', { enabled: true });
                    onClose();
                    notify(t('workspace trusted'));
                    return;
                  }
                  runtime.change((state) => {
                    state.workspaces.find(
                      (item) => item.id === workspace.id,
                    )!.trusted = true;
                  });
                  onClose();
                  notify('sample workspace marked trusted');
                })
              }
            >
              {runtime.mode === 'live'
                ? t('trust workspace')
                : 'trust in preview'}
            </Button>
          </div>
        </>
      )}
      {dialog === 'compact' && (
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            runtime.request('compact', { hint });
            onClose();
            notify(t('compaction requested; raw history is unchanged'));
          }}
        >
          <p className="dialog-paragraph">
            {t(
              'A connected Circle runtime summarizes older context. The full record is kept.',
            )}
          </p>
          <label>
            {t('focus')}
            <input
              aria-label={t('compaction focus')}
              value={hint}
              onChange={(event) => setHint(event.target.value)}
              placeholder={t('what should the summary preserve?')}
            />
          </label>
          <Button type="submit" className="primary">
            {t('request compaction')}
          </Button>
        </form>
      )}
      {dialog === 'hotkeys' && (
        <table className="shortcut-table">
          <tbody>
            {desktopShortcuts().map(([keys, what]) => (
              <tr key={keys}>
                <td>
                  <kbd>{keys}</kbd>
                </td>
                <td>{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {dialog === 'exit' && (
        <>
          <p className="dialog-paragraph">
            {desktopHost()
              ? t('Quitting stops Circle and the background jobs it started.')
              : 'Closing a real Circle process stops its owned background jobs. This preview can only record the request.'}
          </p>
          <div className="dialog-actions">
            <Button onClick={onClose}>{t('keep working')}</Button>
            <Button
              onClick={() => {
                runtime.request('exit');
                onClose();
                if (desktopHost()) void desktopHost()!.windowControl('quit');
                else notify('exit requested; no runtime process was stopped');
              }}
            >
              {desktopHost() ? t('quit application') : 'request exit'}
            </Button>
          </div>
        </>
      )}
      {dialog === 'job-stop' && selectedJob && (
        <>
          <h3>
            {selectedJob.id} · {selectedJob.title}
          </h3>
          <p className="dialog-paragraph">
            {t(
              'The runtime must confirm that the process and its children stopped. A request alone does not establish that.',
            )}
          </p>
          <div className="dialog-actions">
            <Button onClick={onClose}>{t('keep running')}</Button>
            <Button
              onClick={() => {
                runtime.request('stop-job', { id: selectedJob.id });
                onClose();
                notify(t('stop requested; execution state is unverified'));
              }}
            >
              {t('request stop')}
            </Button>
          </div>
        </>
      )}
      {dialog === 'secret' && (
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (!secret.trim()) {
              notify(t('enter a value or cancel'));
              return;
            }
            if (selectedSecret)
              perform(async () => {
                await runtime.answer(
                  selectedSecret.id,
                  selectedSecret.revision,
                  secret,
                );
                setSecret('');
                onClose();
                notify(
                  runtime.mode === 'live'
                    ? t('secret sent privately')
                    : 'secret discarded by preview; nothing was sent',
                );
              });
          }}
        >
          <Facts
            values={{
              [t('request')]: selectedSecret?.title ?? t('no pending secret'),
              [t('destination')]: selectedSecret?.target ?? t('none'),
            }}
          />
          <label>
            {t('secret')}
            <input
              autoFocus
              type="password"
              autoComplete="off"
              maxLength={512}
              aria-label={t('secret value')}
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
          </label>
          <p className="panel-note">
            {runtime.mode === 'live'
              ? t(
                  'The value goes directly to the pending secret request. It is excluded from the conversation.',
                )
              : 'This preview does not retain or transmit the value.'}
          </p>
          <div className="dialog-actions">
            <Button type="button" onClick={cancelSecret}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={!selectedSecret}>
              {runtime.mode === 'live'
                ? t('submit secret')
                : 'record preview response'}
            </Button>
          </div>
        </form>
      )}
      {dialog === 'preview' && (
        <>
          <Facts
            values={{
              version: VERSION,
              scope: 'frontend only',
              data: 'synthetic records and your local input',
              runtime: 'not connected',
              models: 'not contacted',
              workspace: desktopHost()
                ? 'user-selected files through granted handles'
                : 'no real files accessed',
            }}
          />
          <p className="dialog-paragraph">
            Use the interface to review sessions, tools, branches, approvals,
            jobs and settings. Requests remain local. Your real Circle settings
            and sessions are not read.
          </p>
          {resetConfirm ? (
            <div className="dialog-actions">
              <Button onClick={() => setResetConfirm(false)}>
                keep local data
              </Button>
              <Button
                className="danger"
                onClick={() => {
                  runtime.reset();
                  onClose();
                  onSession();
                }}
              >
                confirm reset
              </Button>
            </div>
          ) : (
            <Button onClick={() => setResetConfirm(true)}>
              reset sample data
            </Button>
          )}
        </>
      )}
    </Modal>
  );
}
export function InteractionDialog({
  item,
  onClose,
}: {
  item: Interaction | null;
  onClose: () => void;
}) {
  const { runtime, perform, notify } = useRuntime();
  const [selected, setSelected] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [cancelConfirm, setCancelConfirm] = useState(false);
  useEffect(() => {
    setSelected([]);
    setComment('');
    setCancelConfirm(false);
  }, [item?.id]);
  const finish = (answer: string) => {
    if (!item) return;
    perform(async () => {
      await runtime.answer(item.id, item.revision, answer);
      onClose();
      notify(
        runtime.mode === 'live'
          ? t('response sent to Circle')
          : 'response recorded locally; runtime not connected',
      );
    });
  };
  const close = () => {
    if (!item) return;
    if (item.status === 'recorded') {
      onClose();
      return;
    }
    if (
      item.kind === 'question' &&
      (selected.length || comment) &&
      !cancelConfirm
    ) {
      setCancelConfirm(true);
      return;
    }
    finish(item.kind === 'question' ? 'cancelled' : 'reject');
  };
  return (
    <Modal
      open={!!item}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={
        item?.kind === 'approval' && item.tool
          ? [item.tool, requestReason(item.reason)].filter(Boolean).join(' · ')
          : (item?.title ?? t('request'))
      }
      wide={!!item?.before || !!item?.diff}
    >
      {item && (
        <>
          <div className="interaction-meta">
            <Status
              value={item.status === 'pending' ? 'waiting' : 'recorded'}
            />
            {runtime.mode !== 'live' && (
              <code>
                {item.id} · revision {item.revision}
              </code>
            )}
            <span>
              {runtime.mode === 'live'
                ? (item.origin?.name ?? t('Circle request'))
                : 'sample request'}
            </span>
          </div>
          {item.tool?.startsWith('browser_') ? (
            <BrowserApproval input={item.input} />
          ) : item.command ? (
            <pre className="approval-command">{item.command}</pre>
          ) : item.diff ? (
            <DiffBlock diff={item.diff} path={item.target || undefined} />
          ) : (
            item.target && <p className="file-path">{item.target}</p>
          )}
          {!item.tool?.startsWith('browser_') &&
            hasToolInput(item.input) &&
            (item.command || item.diff ? (
              <details className="request-input">
                <summary>{t('tool input')}</summary>
                <DataBlock title={t('tool input')} value={item.input} />
              </details>
            ) : (
              <DataBlock title={t('tool input')} value={item.input} />
            ))}
          {item.before !== undefined && (
            <div className="approval-diff">
              <DataBlock title={t('before')} value={item.before} />
              <DataBlock title={t('after')} value={item.after} />
            </div>
          )}
          {item.status === 'recorded' ? (
            <DataBlock title={t('local response')} value={item.decision} />
          ) : item.kind === 'question' ? (
            <>
              <div className="question-options">
                {item.choices?.map((choice) => (
                  <label key={choice}>
                    <input
                      type={item.multiple ? 'checkbox' : 'radio'}
                      name="question"
                      checked={selected.includes(choice)}
                      onChange={(event) =>
                        setSelected(
                          item.multiple
                            ? event.target.checked
                              ? [...selected, choice]
                              : selected.filter((value) => value !== choice)
                            : [choice],
                        )
                      }
                    />
                    {choice}
                  </label>
                ))}
              </div>
              <label className="field-label" htmlFor="question-comment">
                {t('your answer')}
              </label>
              <textarea
                id="question-comment"
                className="input short"
                value={comment}
                onChange={(event) => setComment(event.target.value)}
              />
              {cancelConfirm && (
                <p className="inline-error">
                  {t(
                    'Cancel this answer? Press escape again or choose cancel.',
                  )}
                </p>
              )}
              <div className="dialog-actions">
                <Button onClick={() => finish('cancelled')}>
                  {t('cancel')}
                </Button>
                <Button
                  className="primary"
                  disabled={!selected.length && !comment.trim()}
                  onClick={() =>
                    finish(JSON.stringify({ choices: selected, comment }))
                  }
                >
                  {t('save response')}
                </Button>
              </div>
            </>
          ) : item.kind === 'plan-exit' ? (
            <>
              <p className="dialog-paragraph">
                {t('Leave read-only mode and implement the plan?')}
              </p>
              <div className="dialog-actions">
                <Button onClick={() => finish('stay read-only')}>
                  {t('stay read-only')}
                </Button>
                <Button onClick={() => finish('implement plan')}>
                  {t('request implementation')}
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="approval-options">
                <Button
                  className="primary"
                  onClick={() => finish('allow once')}
                  disabled={
                    runtime.mode === 'live' &&
                    !item.choices?.includes('approve')
                  }
                >
                  {t('allow once')}
                </Button>
                <Button
                  disabled={
                    runtime.mode === 'live' && !item.choices?.includes('always')
                  }
                  onClick={() => finish('allow for this session')}
                >
                  {t('allow for this session')}
                </Button>
                <Button onClick={() => finish('reject')}>{t('reject')}</Button>
                {runtime.mode === 'live' &&
                  item.choices?.includes('prefix') && (
                    <Button onClick={() => finish('prefix')}>
                      {t('allow command prefix')}
                    </Button>
                  )}
              </div>
              <label className="field-label" htmlFor="reject-reason">
                {t('reject and explain')}
              </label>
              <div className="inline-actions">
                <input
                  id="reject-reason"
                  className="input"
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                />
                <Button
                  onClick={() =>
                    finish(comment.trim() ? 'reject: ' + comment : 'reject')
                  }
                >
                  {t('send rejection')}
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  );
}
