export type ReadinessGap = {
  area: "provider" | "shell" | "environment";
  title: string;
  detail: string;
};

export type StartupState = {
  gaps: ReadinessGap[];
  passed: number;
};

import type { DesktopActionId, DesktopActionState } from "./actions.js";
import type { EditorsApi } from "./editors.js";
import type { PreferencesApi } from "./preferences.js";
import type { ProjectsApi } from "./projects.js";
import type { PiLotApi as ProviderApi } from "./providers.js";

export type PiLotApi = ProviderApi & PreferencesApi & EditorsApi & ProjectsApi & {
  getStartupState(): Promise<StartupState>;
  platform: "darwin" | "win32" | "linux";
  setActionState(states: DesktopActionState[]): void;
  onAction(listener: (id: DesktopActionId) => void): () => void;
};
