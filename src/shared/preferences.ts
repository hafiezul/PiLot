import type { ApplicationId } from "./editors.js";

export const appearances = ["system", "light", "dark"] as const;
export type Appearance = typeof appearances[number];

export type Preferences = {
  appearance: Appearance;
  expandThinking: boolean;
  preferredApplication?: ApplicationId;
};

export type PreferencesApi = {
  getPreferences(): Promise<Preferences>;
  setAppearance(appearance: Appearance): Promise<Preferences>;
  setExpandThinking(expand: boolean): Promise<Preferences>;
};
