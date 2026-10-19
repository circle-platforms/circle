import { githubPlugin } from './github';
import {
  Folder,
  FileDiff,
  Activity,
  Globe,
  SquareTerminal,
  BookOpen,
  CirclePlay,
  Server,
  Blocks,
} from 'lucide-react';
import {
  FilesPanel,
  ChangesPanel,
  ActivityPanel,
  BrowserPanel,
} from '../features/Panels';
import { TerminalDevice } from '../features/TerminalDevice';
import {
  KnowledgePage,
  WorkPage,
  ExecutionPage,
  MethodsPage,
  WorkWidget,
  MethodsWidget,
  KnowledgeAction,
} from './platform/views';
import type { WorkbenchPlugin } from './types';
import { hubPlugin } from './hub';
import { livePlatformPlugins } from './platform/live';
import { t } from '../i18n';
// Titles and descriptions are getters so they follow the interface language when it changes.
export const circlePlugins: WorkbenchPlugin[] = [
  githubPlugin,
  {
    id: 'files',
    apiVersion: 1,
    version: '0.1.0',
    get title() {
      return t('file and diff inspector');
    },
    get description() {
      return t('Workspace files, local preview buffers and change comparison.');
    },
    icon: Folder,
    panels: [
      {
        id: 'files',
        get title() {
          return t('files');
        },
        icon: Folder,
        component: (props) => (
          <FilesPanel
            selection={props.selection}
            onFile={props.onFile}
            onDialog={props.onDialog}
          />
        ),
      },
      {
        id: 'changes',
        get title() {
          return t('changes');
        },
        icon: FileDiff,
        fullView: true,
        component: (props) => <ChangesPanel onFile={props.onFile} />,
      },
    ],
  },
  {
    id: 'activity',
    apiVersion: 1,
    version: '0.1.0',
    get title() {
      return t('activity inspector');
    },
    get description() {
      return t('Circle background jobs, subagents and pending interactions.');
    },
    icon: Activity,
    panels: [
      {
        id: 'activity',
        get title() {
          return t('activity');
        },
        icon: Activity,
        fullView: true,
        component: (props) => <ActivityPanel {...props} />,
      },
    ],
  },
  {
    id: 'browser',
    apiVersion: 1,
    version: '0.1.0',
    get title() {
      return t('browser pane');
    },
    get description() {
      return t('The same browser session shared with the future desktop host.');
    },
    icon: Globe,
    panels: [
      {
        id: 'browser',
        get title() {
          return t('browser');
        },
        icon: Globe,
        component: BrowserPanel,
        fullView: true,
      },
    ],
  },
  {
    id: 'devices',
    apiVersion: 1,
    version: '0.1.0',
    get title() {
      return t('device terminal pane');
    },
    get description() {
      return t('SSH and Telnet consoles shared with Circle.');
    },
    icon: SquareTerminal,
    panels: [
      {
        id: 'devices',
        get title() {
          return t('device terminals');
        },
        icon: SquareTerminal,
        component: TerminalDevice,
        fullView: true,
      },
    ],
  },
  hubPlugin,
  // B, C, D and E as hub holds them. Each page is switched on by itself.
  ...livePlatformPlugins,
];
// The earlier local previews of B, C, D and E, kept for the preview store's tests and as
// reference. The application shows the live ones in circlePlugins.
export const platformPreviewPlugins: WorkbenchPlugin[] = [
  {
    id: 'knowledge',
    apiVersion: 1,
    version: '0.1.0',
    title: 'knowledge',
    description:
      'B · product sources, evidence and artifacts with pinned revisions.',
    icon: BookOpen,
    recordPage: 'knowledge',
    pages: [
      {
        id: 'knowledge',
        title: 'knowledge',
        icon: BookOpen,
        component: KnowledgePage,
      },
    ],
    composerActions: [{ id: 'attach-knowledge', component: KnowledgeAction }],
  },
  {
    id: 'work',
    apiVersion: 1,
    version: '0.1.0',
    title: 'long-running work',
    description:
      'C · durable goals, waiting items, handoffs and completion records.',
    icon: CirclePlay,
    recordPage: 'work',
    pages: [
      {
        id: 'work',
        title: 'long-running work',
        icon: CirclePlay,
        component: WorkPage,
      },
    ],
    widgets: [{ id: 'linked-platform-work', component: WorkWidget }],
  },
  {
    id: 'execution',
    apiVersion: 1,
    version: '0.1.0',
    title: 'execution resources',
    description:
      'D · workspace, worker, SSH and browser observation and control.',
    icon: Server,
    recordPage: 'execution',
    pages: [
      {
        id: 'execution',
        title: 'execution resources',
        icon: Server,
        component: ExecutionPage,
      },
    ],
  },
  {
    id: 'methods',
    apiVersion: 1,
    version: '0.1.0',
    title: 'methods',
    description: 'E · versioned skills, toolkits and product rules.',
    icon: Blocks,
    recordPage: 'methods',
    pages: [
      { id: 'methods', title: 'methods', icon: Blocks, component: MethodsPage },
    ],
    widgets: [{ id: 'session-methods', component: MethodsWidget }],
  },
];
export const defaultPlugins = circlePlugins;
