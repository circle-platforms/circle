import { useState } from 'react';
import {
  setTerminalAccessibility,
  useTerminalAccessibilityChoice,
} from '../terminal-accessibility';
import { desktopHost, setDefaultWorkspace, setTaskFolder } from '../host';
import { KeybindingsEditor } from './KeybindingsEditor';
import { TaskLimitsSettings } from './TaskLimitsSettings';
import { WorkspaceTrustSettings } from './WorkspaceTrustSettings';
import { ProtectedFilesSettings } from './ProtectedFilesSettings';
import { VariablesSettings } from './VariablesSettings';
import { NetworkStatus } from './NetworkStatus';
import { UpdateControl } from './Update';
import { VERSION } from '../../../../src/version';
import { useRuntime } from '../app/context';
import { taskWorkspaceIds } from '../model/session-management';
import { Page, Button, Choice, Facts, Switch } from '../components/common';
import { TEXT_SIZES, textSizes } from '../theme';
import { LANGUAGES, languageChoice, setLanguage, t } from '../i18n';
import type { DialogId, TextSize } from '../model/types';

type Settings = ReturnType<typeof useRuntime>['snapshot']['settings'];

/** Applies a change to the settings as it is made; there is nothing to save afterwards. */
function useSave() {
  const { runtime, perform } = useRuntime();
  return (update: (draft: Settings) => void) =>
    perform(() => runtime.change((state) => update(state.settings)));
}

const TEXT_SIZE_LABELS: Record<TextSize, () => string> = {
  small: () => t('small'),
  default: () => t('default'),
  large: () => t('large'),
  larger: () => t('larger'),
};
const THEME_LABELS: Record<'auto' | 'light' | 'dark', () => string> = {
  auto: () => t('auto'),
  light: () => t('light'),
  dark: () => t('dark'),
};
const SETTINGS_THEMES = ['auto', 'light', 'dark'] as const;

export function AppearanceSection() {
  const terminalAccessibility = useTerminalAccessibilityChoice();
  const { snapshot } = useRuntime();
  const settings = snapshot.settings;
  const save = useSave();
  return (
    <Page
      title={t('appearance')}
      description={t('Theme, text size and language for this window.')}
    >
      <Choice
        label={t('theme')}
        value={settings.theme}
        options={SETTINGS_THEMES.map(
          (theme) => [theme, THEME_LABELS[theme]()] as const,
        )}
        onChange={(theme) =>
          save((value) => {
            value.theme = theme;
          })
        }
      />
      <Choice
        label={t('text size')}
        value={settings.textSize}
        options={textSizes.map(
          (size) =>
            [
              size,
              TEXT_SIZE_LABELS[size](),
              TEXT_SIZES[size][0] + 'px',
            ] as const,
        )}
        onChange={(size) =>
          save((value) => {
            value.textSize = size;
          })
        }
      />
      <Choice
        label={t('language')}
        value={languageChoice()}
        options={LANGUAGES.map(
          (language) =>
            [
              language,
              language === 'system'
                ? t('follow system')
                : language === 'zh-CN'
                  ? '简体中文'
                  : 'English',
            ] as const,
        )}
        onChange={(language) => setLanguage(language, localStorage)}
      />
      <Choice
        label={t('terminal screen reader')}
        value={terminalAccessibility}
        options={
          [
            ['auto', t('follow system')],
            ['always', t('always on')],
          ] as const
        }
        onChange={setTerminalAccessibility}
      />
    </Page>
  );
}

export function BehaviorSection() {
  const { snapshot } = useRuntime();
  const settings = snapshot.settings;
  const save = useSave();
  return (
    <Page
      title={t('sessions')}
      description={t('How a session starts, and what a double Esc does.')}
    >
      <Choice
        label={t('double Esc')}
        value={settings.doubleEscape}
        options={
          [
            ['tree', t('open the session tree')],
            ['fork', t('fork the session')],
            ['none', t('nothing')],
          ] as const
        }
        onChange={(value) =>
          save((draft) => {
            draft.doubleEscape = value;
          })
        }
      />
      <div className="setting-row">
        <Switch
          label={t('hide thinking in new sessions')}
          checked={settings.hideThinking}
          onChange={(checked) =>
            save((value) => {
              value.hideThinking = checked;
            })
          }
        />
      </div>
    </Page>
  );
}

export function ShortcutsSection({
  onDialog,
}: {
  onDialog: (dialog: DialogId) => void;
}) {
  return (
    <Page
      title={t('shortcuts')}
      description={t('Keys for the window and for the message box.')}
      action={
        <Button onClick={() => onDialog('hotkeys')}>
          {t('view shortcuts')}
        </Button>
      }
    >
      <KeybindingsEditor />
    </Page>
  );
}

export function AboutSection() {
  const { snapshot, runtime, notify } = useRuntime();
  const settings = snapshot.settings;
  const save = useSave();
  return (
    <Page
      title={t('about & updates')}
      description={t('The version, and whether Circle looks for a newer one.')}
    >
      <Facts
        values={{
          [t('version')]: VERSION,
          [t('runtime')]: snapshot.runtime?.connected
            ? t('connected')
            : t('not connected'),
          [t('host')]: desktopHost()
            ? t('desktop application')
            : t('browser layout preview'),
          [t('data')]:
            runtime.mode === 'live'
              ? t('Circle desktop data folder')
              : t('this browser only'),
        }}
      />
      <div className="setting-row">
        <Switch
          label={t('check for updates')}
          checked={settings.updateCheck}
          onChange={(checked) =>
            save((value) => {
              value.updateCheck = checked;
            })
          }
        />
      </div>
      {desktopHost() ? (
        <UpdateControl />
      ) : (
        <Button
          onClick={() => {
            runtime.request('check-update');
            notify(t('update check requires the desktop application'));
          }}
        >
          {t('check now')}
        </Button>
      )}
    </Page>
  );
}

export function HooksSection() {
  const { snapshot } = useRuntime();
  const settings = snapshot.settings;
  const save = useSave();
  return (
    <Page
      title={t('hooks')}
      description={t(
        'Hooks run shell commands you configured. A deny overrides every approval mode, including auto.',
      )}
    >
      <p className="panel-note">
        {t('A skill hook runs after that skill is loaded in this session.')}
      </p>
      <div className="setting-row">
        <Switch
          label={t('show hook allowed notices')}
          checked={settings.showHookAllow === true}
          onChange={(checked) =>
            save((value) => {
              value.showHookAllow = checked;
            })
          }
        />
      </div>
      {settings.projectHooksIgnored && (
        <p className="panel-note">
          {t('Project hooks are not running until this folder is trusted.')}
        </p>
      )}
      {(settings.projectHooksWaiting ?? []).map((file) => (
        <p className="panel-note" key={file}>
          {t(
            '{file} does not run until you approve this version. Circle asks when a conversation starts its next turn.',
            { file },
          )}
        </p>
      ))}
      {(settings.hooks ?? []).length === 0 ? (
        <p className="panel-note">{t('no hooks')}</p>
      ) : (
        settings.hooks!.map((hook) => (
          <div
            className="setting-row"
            key={`${hook.source}:${hook.event}:${hook.name}:${hook.command}`}
          >
            <span>
              {hook.name}
              <small>
                {hook.source === 'user'
                  ? t('user')
                  : hook.source === 'project'
                    ? t('project')
                    : `${t('skill')}${hook.skill ? ` ${hook.skill}` : ''}`}
                {' · '}
                {hook.event}
                {hook.tools !== '*' ? ` · ${hook.tools}` : ''}
                {hook.active === false ? ` · ${t('waits for the skill')}` : ''}
              </small>
            </span>
            <code>{hook.command}</code>
          </div>
        ))
      )}
    </Page>
  );
}

export function WorkspaceSection({
  onDialog,
}: {
  onDialog: (dialog: DialogId, selection?: string) => void;
}) {
  const { snapshot, runtime, perform, notify } = useRuntime();
  const taskFolders = taskWorkspaceIds(snapshot.sessions, snapshot.agents);
  const settings = snapshot.settings;
  return (
    <Page
      title={t('workspace')}
      description={t('The folder Circle starts in, and the folders it trusts.')}
    >
      <section className="settings-block">
        <h2>{t('default workspace')}</h2>
        <div className="setting-row">
          <span>
            {t('folder')}
            <small>{settings.workspaceFolder}</small>
          </span>
          {runtime.mode === 'live' && (
            <Button
              onClick={() =>
                perform(async () => {
                  if (await setDefaultWorkspace(runtime))
                    notify(t('default workspace changed'));
                })
              }
            >
              {t('change…')}
            </Button>
          )}
        </div>
        <p className="panel-note">
          {t(
            'changing the folder does not move your files; the new folder still needs trust',
          )}
        </p>
        {settings.oldWorkspaceFolder && (
          <p className="panel-note">
            {t(
              'the old default folder {path} keeps its sessions until you delete it by hand',
              { path: settings.oldWorkspaceFolder },
            )}
          </p>
        )}
      </section>
      {!!settings.taskFolder && (
        <section className="settings-block">
          <h2>{t('tasks with no project')}</h2>
          <div className="setting-row">
            <span>
              {t('folder')}
              <small>{settings.taskFolder}</small>
            </span>
            {runtime.mode === 'live' && (
              <Button
                onClick={() =>
                  perform(async () => {
                    if (await setTaskFolder(runtime))
                      notify(t('task folder changed'));
                  })
                }
              >
                {t('change…')}
              </Button>
            )}
          </div>
          <p className="panel-note">
            {t(
              'a task you start outside a project gets a folder of its own here, and is listed apart from your projects',
            )}
          </p>
        </section>
      )}
      <WorkspaceTrustSettings
        hidden={taskFolders}
        onReview={(id) => onDialog('trust', id)}
      />
      {runtime.mode === 'live' && desktopHost() && snapshot.activeSessionId && (
        <TaskLimitsSettings sessionId={snapshot.activeSessionId} />
      )}
    </Page>
  );
}

export function GitSection() {
  const { snapshot } = useRuntime();
  const save = useSave();
  return (
    <Page
      title={t('git')}
      description={t(
        'Whether the commits and pull requests Circle makes credit Circle.',
      )}
    >
      <div className="setting-row">
        <Switch
          label={t('credit Circle in commits and pull requests')}
          checked={snapshot.settings.attribution}
          onChange={(checked) =>
            save((value) => {
              value.attribution = checked;
            })
          }
        />
      </div>
      <p className="panel-note">
        {t(
          'When enabled in a Git repository, Circle asks the model to credit Circle in commits and pull requests. The commit author follows your attribution settings.',
        )}
      </p>
    </Page>
  );
}

export function FilesSection({
  onDialog,
}: {
  onDialog: (dialog: DialogId) => void;
}) {
  return (
    <Page
      title={t('file access')}
      description={t(
        'Files a session may read outside a project, and name-based protections for sensitive files.',
      )}
    >
      <section className="settings-block">
        <h2>{t('external file access')}</h2>
        <p className="panel-note">
          {t(
            'Exact-file permissions belong to the current session, not global preferences.',
          )}
        </p>
        <Button onClick={() => onDialog('external-files')}>
          {t('manage external file access')}
        </Button>
      </section>
      <ProtectedFilesSettings />
    </Page>
  );
}

export function VariablesSection() {
  return (
    <Page
      title={t('variables & secrets')}
      description={t('Values you name once and use in a tool call as %NAME%.')}
    >
      <VariablesSettings />
    </Page>
  );
}

export function NetworkSection() {
  return (
    <Page
      title={t('network')}
      description={t('How Circle trusts a server before it sends anything.')}
    >
      <NetworkStatus />
    </Page>
  );
}

/** The frontend preview only: a launch draft that starts nothing. */
export function LaunchSection() {
  const { runtime, notify } = useRuntime();
  const [launch, setLaunch] = useState('--mode rpc --no-tools');
  return (
    <Page title={t('launch options')}>
      <textarea
        aria-label={t('launch arguments')}
        className="input short"
        value={launch}
        onChange={(event) => setLaunch(event.target.value)}
      />
      <Button
        onClick={() => {
          runtime.request('launch-options', { arguments: launch });
          notify(t('launch draft saved; no process started'));
        }}
      >
        {t('save launch draft')}
      </Button>
    </Page>
  );
}
