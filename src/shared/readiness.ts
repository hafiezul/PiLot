export type ReadinessGap = {
  area: "provider" | "shell" | "environment";
  title: string;
  detail: string;
};

export type StartupState = {
  gaps: ReadinessGap[];
  passed: number;
};

import type { PreferencesApi } from "./preferences.js";
import type { ProjectsApi } from "./projects.js";
import type { PiLotApi as ProviderApi } from "./providers.js";

export type PiLotApi = ProviderApi & PreferencesApi & ProjectsApi & {
  getStartupState(): Promise<StartupState>;
};
