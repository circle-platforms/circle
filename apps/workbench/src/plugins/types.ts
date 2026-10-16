import type { ComponentType, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { DialogId, Interaction } from '../model/types';
export interface PluginViewProps {
  sessionId: string;
}
export interface PluginPage {
  id: string;
  title: string;
  icon: LucideIcon;
  component: ComponentType<PluginViewProps>;
}
export interface PluginPanelProps extends PluginViewProps {
  selection: string;
  onFile: (path: string) => void;
  onAgent: (id: string) => void;
  onDialog: (kind: DialogId, selection?: string) => void;
  onInteraction: (item: Interaction) => void;
}
export interface PluginPanel {
  id: string;
  title: string;
  icon: LucideIcon;
  component: ComponentType<PluginPanelProps>;
  /** Offered in the full view, which takes the panel across the whole workspace. */
  fullView?: boolean;
}
export interface PluginWidget {
  id: string;
  component: ComponentType<PluginViewProps>;
}
/** A bundled UI extension. Runtime extensions and services retain their own APIs. */
export interface WorkbenchPlugin {
  id: string;
  version: string;
  apiVersion: 1;
  title: string;
  description: string;
  icon: LucideIcon;
  requires?: string[];
  /**
   * The runtime extension that is this plugin's other half, by name. A paired plugin shows
   * only while it is switched on and that extension is installed, loaded, enabled and of
   * the same version. Turning the page on turns the extension on if it was off. Turning
   * it off turns the extension off only when no other page of that extension stays on.
   */
  runtimeExtension?: string;
  pages?: PluginPage[];
  widgets?: PluginWidget[];
  composerActions?: PluginWidget[];
  panels?: PluginPanel[];
  recordPage?: string;
}
export interface PluginService {
  getSnapshot: () => unknown;
  subscribe: (listener: () => void) => () => void;
}
export type ServiceRegistry = Record<string, PluginService>;
