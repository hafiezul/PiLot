import type { ApplicationId, TerminalId, TerminalState } from "./editors.js";

export const appearances = ["system", "light", "dark"] as const;
export type Appearance = typeof appearances[number];

export type Preferences = {
  appearance: Appearance;
  expandThinking: boolean;
  preferredApplication?: ApplicationId;
  preferredTerminal: TerminalId;
};

export type PreferencesApi = {
  getPreferences(): Promise<Preferences>;
  setAppearance(appearance: Appearance): Promise<Preferences>;
  setExpandThinking(expand: boolean): Promise<Preferences>;
  getTerminalState(): Promise<TerminalState>;
  setPreferredTerminal(terminal: TerminalId): Promise<TerminalState>;
};
