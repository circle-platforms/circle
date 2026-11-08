import { Network } from 'lucide-react';
import { HubConnectionCard } from '../components/HubConnectionCard';
import { t } from '../i18n';
import type { PluginDetailProps, WorkbenchPlugin } from './types';

export function HubPluginDetails({
  enabled,
  onToggle,
  feedback,
}: PluginDetailProps) {
  return (
    <section className="hub-plugin" aria-label={t('Hub plugin')}>
      <HubConnectionCard integration={{ enabled, onToggle, feedback }} />
    </section>
  );
}
export const hubPlugin: WorkbenchPlugin = {
  id: 'hub',
  apiVersion: 1,
  version: '0.1.0',
  runtimeExtension: 'hub',
  get title() {
    return 'Hub';
  },
  get description() {
    return t(
      'Connect a Circle Hub by its address and sign in with a one-time code.',
    );
  },
  icon: Network,
  detail: HubPluginDetails,
};
