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
  /** The drawer is open on this mode. */
  visible?: boolean;
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
/** Optional management content inside the existing extensions page, also while off. */
export interface PluginDetailProps {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  feedback?: ReactNode;
}
/** A bundled UI extension. Runtime extensions and services retain their own APIs. */
export interface WorkbenchPlugin {
  id: string;
  version: string;
  apiVersion: 1;
  title: string;
  description: string;
  icon: LucideIcon;
  /**
   * The mark of the service it connects, drawn on its cards on the extensions page in place of `icon`, `size` pixels
   * square (components/marks.tsx).
   */
  mark?: ComponentType<{ size?: number }>;
  requires?: string[];
  /**
   * The runtime extension that is this plugin's other half, by name. A paired plugin shows
   * only while it is switched on and that extension is installed, loaded, enabled and of
   * the same version. Turning the page on turns the extension on if it was off. Turning
   * it off turns the extension off only when no other page of that extension stays on.
   */
  runtimeExtension?: string;
  /**
   * The MCP server entry that extension keeps, by name. The entry is the extension's connection: its card on the
   * extensions page shows the entry's state and tools, and the MCP servers page does not list it.
   */
  mcpServer?: string;
  detail?: ComponentType<PluginDetailProps>;
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
