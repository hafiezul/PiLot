import type { ApplicationId, TerminalId, TerminalState } from "./editors.js";

export const appearances = ["system", "light", "dark"] as const;
export type Appearance = typeof appearances[number];

export const DEFAULT_GLOBAL_RUN_CAP = 4;
export const MINIMUM_GLOBAL_RUN_CAP = 1;
export const MAXIMUM_GLOBAL_RUN_CAP = 16;

export type Preferences = {
  appearance: Appearance;
  expandThinking: boolean;
  globalRunCap: number;
  preferredApplication?: ApplicationId;
  preferredTerminal: TerminalId;
};

export type PreferencesApi = {
  getPreferences(): Promise<Preferences>;
  setAppearance(appearance: Appearance): Promise<Preferences>;
  setExpandThinking(expand: boolean): Promise<Preferences>;
  setGlobalRunCap(limit: number): Promise<Preferences>;
  getTerminalState(): Promise<TerminalState>;
  setPreferredTerminal(terminal: TerminalId): Promise<TerminalState>;
};
