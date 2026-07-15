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
import type { AgentSettingsApi } from "./agent-settings.js";
import type { ApplicationsApi } from "./editors.js";
import type { PreferencesApi } from "./preferences.js";
import type { ProjectsApi } from "./projects.js";
import type { PiLotApi as ProviderApi } from "./providers.js";

export type PiLotApi = ProviderApi & AgentSettingsApi & PreferencesApi & ApplicationsApi & ProjectsApi & {
  getStartupState(): Promise<StartupState>;
  platform: "darwin" | "win32" | "linux";
  setActionState(states: DesktopActionState[]): void;
  onAction(listener: (id: DesktopActionId) => void): () => void;
};
