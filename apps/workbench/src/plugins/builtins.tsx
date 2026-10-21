import { githubPlugin } from './github';
import { Folder, FileDiff, Globe } from 'lucide-react';
import { FilesPanel, BrowserPanel } from '../features/Panels';
import { ChangesMode } from '../features/ChangesMode';
import type { WorkbenchPlugin } from './types';
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
            visible={props.visible}
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
        component: (props) => (
          <ChangesMode
            selection={props.selection}
            active={!!props.visible}
            onFile={props.onFile}
          />
        ),
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
];
export const defaultPlugins = circlePlugins;
