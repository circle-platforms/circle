import { Bug } from 'lucide-react';
import { t } from '../i18n';
import type { RuntimeExtension } from '../model/types';
import { pairing } from './registry';
import type { WorkbenchPlugin } from './types';

export const developerPlugin: WorkbenchPlugin = {
  id: 'developer',
  apiVersion: 1,
  version: '0.1.0',
  runtimeExtension: 'developer',
  get title() {
    return t('developer extension');
  },
  get description() {
    return t('Node debugging and TypeScript and JavaScript language features.');
  },
  icon: Bug,
};

/** The debug tab, debug actions and language service follow this extension. */
export function developerToolsEnabled(
  extensions: readonly Pick<
    RuntimeExtension,
    'name' | 'version' | 'enabled' | 'error'
  >[],
): boolean {
  return pairing(developerPlugin, extensions).live;
}
