import { t } from '../i18n/index.ts';
import type { SettingsSectionId } from './types.ts';

/** One group of the settings dialog, as the list at its left shows it. */
export interface SettingsSection {
  id: SettingsSectionId;
  label: string;
  /** Words the search box also matches, in the language that is shown. */
  keywords: string;
}
/** A heading over the groups that belong together. */
export interface SettingsGroup {
  id: string;
  label: string;
  sections: SettingsSection[];
}
/** What decides which groups exist at all. */
export interface SettingsContext {
  /** A real runtime, not the browser preview. */
  live: boolean;
  /** The runtime has told how it trusts the network. */
  network: boolean;
}

/** `/page/settings` opens the dialog at this group. */
export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = 'appearance';
export const SETTINGS_SECTION_IDS: readonly SettingsSectionId[] = [
  'appearance',
  'behavior',
  'shortcuts',
  'help',
  'about',
  'models',
  'skills',
  'commands',
  'mcp',
  'extensions',
  'tools',
  'hooks',
  'workspace',
  'git',
  'approvals',
  'files',
  'variables',
  'network',
  'launch',
];

const words = (...parts: string[]) => parts.join(' ');

/**
 * The groups of the settings dialog, in the order they are listed. A kind of thing
 * decides where it goes: text that is loaded into a conversation is a skill, a program
 * Circle talks to over MCP is an MCP server, and code that runs inside Circle is an
 * extension, whatever it is for (GitHub is one).
 */
export function settingsGroups(context: SettingsContext): SettingsGroup[] {
  const general: SettingsSection[] = [
    {
      id: 'appearance',
      label: t('appearance'),
      keywords: words(
        t('theme'),
        t('text size'),
        t('language'),
        t('terminal screen reader'),
      ),
    },
    {
      id: 'behavior',
      label: t('sessions'),
      keywords: words(t('double Esc'), t('hide thinking in new sessions')),
    },
    {
      id: 'shortcuts',
      label: t('shortcuts'),
      keywords: words(t('keyboard'), t('view shortcuts')),
    },
    {
      id: 'help',
      label: t('help'),
      keywords: words(t('commands & help'), t('Circle documentation')),
    },
    {
      id: 'about',
      label: t('about & updates'),
      keywords: words(t('version'), t('check for updates'), t('update')),
    },
  ];
  if (!context.live)
    general.push({ id: 'launch', label: 'launch options', keywords: '' });
  const safety: SettingsSection[] = [
    {
      id: 'approvals',
      label: t('approvals'),
      keywords: words(t('approval mode'), t('recent decisions')),
    },
    {
      id: 'files',
      label: t('file access'),
      keywords: words(t('external file access'), t('protected files')),
    },
    {
      id: 'variables',
      label: t('variables & secrets'),
      keywords: words(t('variables'), t('secrets')),
    },
  ];
  if (context.network)
    safety.push({
      id: 'network',
      label: t('network'),
      keywords: words(t('network trust'), t('proxy enabled')),
    });
  return [
    { id: 'general', label: t('general'), sections: general },
    {
      id: 'models',
      label: t('models'),
      sections: [
        {
          id: 'models',
          label: t('models & connection'),
          keywords: words(
            t('connection'),
            t('model'),
            t('thinking depth'),
            t('refresh models'),
          ),
        },
      ],
    },
    {
      id: 'capabilities',
      label: t('capabilities'),
      sections: [
        { id: 'skills', label: t('skills'), keywords: '' },
        { id: 'commands', label: t('commands'), keywords: '' },
        {
          id: 'mcp',
          label: t('mcp servers'),
          keywords: 'mcp',
        },
        {
          id: 'extensions',
          label: t('extensions'),
          keywords: words(t('interface components'), 'GitHub'),
        },
        { id: 'tools', label: t('tools'), keywords: '' },
        { id: 'hooks', label: t('hooks'), keywords: '' },
      ],
    },
    {
      id: 'workspace',
      label: t('workspace & git'),
      sections: [
        {
          id: 'workspace',
          label: t('workspace'),
          keywords: words(
            t('default workspace'),
            t('tasks with no project'),
            t('workspace trust'),
            t('parallel tasks'),
          ),
        },
        {
          id: 'git',
          label: t('git'),
          keywords: words(t('commits'), t('pull requests'), 'PR'),
        },
      ],
    },
    { id: 'safety', label: t('permissions & safety'), sections: safety },
  ];
}

const isSection = (id: string): id is SettingsSectionId =>
  (SETTINGS_SECTION_IDS as readonly string[]).includes(id);

/**
 * The group a window address opens in the settings dialog, if it opens one:
 * `/page/settings` is the first, `/page/<group>` any other. Anything after the
 * path (`?plugin=github`) belongs to the group's own page.
 */
export function settingsSectionOf(pathname: string): SettingsSectionId | null {
  const match = /^\/page\/([a-z][a-z0-9-]*)\/?$/.exec(pathname);
  if (!match) return null;
  if (match[1] === 'settings') return DEFAULT_SETTINGS_SECTION;
  return isSection(match[1]!) ? match[1]! : null;
}

/** The address of a group. */
export const settingsHref = (id: SettingsSectionId) => `/page/${id}`;
