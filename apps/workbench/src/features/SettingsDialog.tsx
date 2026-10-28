import { Modal } from '../components/common';
import { useRuntime } from '../app/context';
import { t } from '../i18n';
import {
  DEFAULT_SETTINGS_SECTION,
  settingsGroups,
} from '../model/settings-sections';
import type { DialogId, SettingsSectionId } from '../model/types';
import {
  ApprovalsPage,
  CommandsPage,
  ExtensionsPage,
  HelpPage,
  McpPage,
  ModelsPage,
  SkillsPage,
  ToolsPage,
} from './Pages';
import {
  AboutSection,
  AppearanceSection,
  BehaviorSection,
  FilesSection,
  GitSection,
  HooksSection,
  LaunchSection,
  NetworkSection,
  ShortcutsSection,
  VariablesSection,
  WorkspaceSection,
} from './SettingsSections';
import { SettingsLayout } from './SettingsLayout';

type Open = (dialog: DialogId, selection?: string) => void;

function Section({
  id,
  onDialog,
  onClose,
}: {
  id: SettingsSectionId;
  onDialog: Open;
  onClose: () => void;
}) {
  switch (id) {
    case 'appearance':
      return <AppearanceSection />;
    case 'behavior':
      return <BehaviorSection />;
    case 'shortcuts':
      return <ShortcutsSection onDialog={onDialog} />;
    case 'help':
      return <HelpPage onDialog={onDialog} onClose={onClose} />;
    case 'about':
      return <AboutSection />;
    case 'models':
      return <ModelsPage onDialog={onDialog} />;
    case 'skills':
      return <SkillsPage />;
    case 'commands':
      return <CommandsPage />;
    case 'mcp':
      return <McpPage />;
    case 'extensions':
      return <ExtensionsPage />;
    case 'tools':
      return <ToolsPage />;
    case 'hooks':
      return <HooksSection />;
    case 'workspace':
      return <WorkspaceSection onDialog={onDialog} />;
    case 'git':
      return <GitSection />;
    case 'approvals':
      return <ApprovalsPage />;
    case 'files':
      return <FilesSection onDialog={onDialog} />;
    case 'variables':
      return <VariablesSection />;
    case 'network':
      return <NetworkSection />;
    case 'launch':
      return <LaunchSection />;
  }
}

/**
 * Settings, skills, MCP servers, extensions and the rest open as one dialog over
 * the window you were in, which stays behind a grey backdrop. A click outside,
 * `esc` or × closes it and returns to that view. A group's own pages (an
 * extension's details) open inside the dialog too.
 */
export function SettingsDialog({
  section,
  onSelect,
  onClose,
  onDialog,
}: {
  /** The group the window address names; the dialog is closed without one. */
  section: SettingsSectionId | null;
  onSelect: (id: SettingsSectionId) => void;
  onClose: () => void;
  onDialog: Open;
}) {
  const { runtime, snapshot } = useRuntime();
  const groups = settingsGroups({
    live: runtime.mode === 'live',
    network: !!snapshot.runtime?.network,
  });
  // A group this runtime does not offer, such as the network before it has
  // reported, shows the first one instead.
  const offered = groups.flatMap((group) => group.sections);
  const active =
    offered.find((item) => item.id === section)?.id ?? DEFAULT_SETTINGS_SECTION;
  return (
    <Modal
      open={section !== null}
      onOpenChange={(open) => {
        // `esc` reaches this dialog and one opened over it in the same moment, before
        // this one has learned it is no longer the top: only the top one closes. A
        // dialog already underneath settings must not keep settings from closing.
        const dialogs = [...document.querySelectorAll('[role="dialog"]')];
        const settings = dialogs.findIndex((dialog) =>
          dialog.classList.contains('settings-dialog'),
        );
        if (!open && settings >= 0 && settings < dialogs.length - 1) return;
        if (!open) onClose();
      }}
      title={t('settings')}
      className="settings-dialog"
      restoreFocus
      onEscapeKeyDown={(event) => {
        // In the search box with something typed in it, `esc` only empties the box.
        const field = event.target;
        if (
          field instanceof HTMLInputElement &&
          field.closest('.settings-index') &&
          field.value
        )
          event.preventDefault();
      }}
    >
      <SettingsLayout
        groups={groups}
        active={active}
        onSelect={(id) => onSelect(id as SettingsSectionId)}
      >
        <Section
          key={active}
          id={active}
          onDialog={onDialog}
          onClose={onClose}
        />
      </SettingsLayout>
    </Modal>
  );
}
