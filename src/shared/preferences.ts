import type { ApplicationId, TerminalId, TerminalState } from "./editors.js";

export const appearances = ["system", "light", "dark"] as const;
export type Appearance = typeof appearances[number];

export const DEFAULT_GLOBAL_RUN_CAP = 4;
export const MINIMUM_GLOBAL_RUN_CAP = 1;
export const MAXIMUM_GLOBAL_RUN_CAP = 16;

export const preferenceInspectorViews = ["details", "changes", "history"] as const;
export type PreferenceInspectorView = typeof preferenceInspectorViews[number];

export type NotificationPreferences = {
  runCompleted: boolean;
  runFailed: boolean;
  attentionRequired: boolean;
};

export type PanePreferences = {
  inspectorVisible: boolean;
  inspectorView: PreferenceInspectorView;
};

export type WindowPreference = {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
};

export type RecentSelection = {
  projectPath?: string;
  taskPath?: string;
};

export type Preferences = {
  appearance: Appearance;
  expandThinking: boolean;
  globalRunCap: number;
  notifications: NotificationPreferences;
  panes: PanePreferences;
  recentSelection: RecentSelection;
  window?: WindowPreference;
  preferredApplication?: ApplicationId;
  /** Preserved while migrating the pre-0.1 editor preference. */
  preferredEditor?: ApplicationId;
  preferredTerminal: TerminalId;
};

export type PreferencesApi = {
  getPreferences(): Promise<Preferences>;
  setAppearance(appearance: Appearance): Promise<Preferences>;
  setExpandThinking(expand: boolean): Promise<Preferences>;
  setGlobalRunCap(limit: number): Promise<Preferences>;
  setNotificationPreferences(notifications: NotificationPreferences): Promise<Preferences>;
  setPanePreferences(panes: PanePreferences): Promise<Preferences>;
  setRecentSelection(projectPath?: string, taskPath?: string): Promise<Preferences>;
  getTerminalState(): Promise<TerminalState>;
  setPreferredTerminal(terminal: TerminalId): Promise<TerminalState>;
};
