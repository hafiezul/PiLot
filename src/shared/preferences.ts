export const appearances = ["system", "light", "dark"] as const;
export type Appearance = typeof appearances[number];

export type Preferences = {
  appearance: Appearance;
};

export type PreferencesApi = {
  getPreferences(): Promise<Preferences>;
  setAppearance(appearance: Appearance): Promise<Preferences>;
};
