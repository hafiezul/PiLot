export type ReadinessGap = {
  area: "provider" | "shell" | "environment" | "sessions";
  title: string;
  detail: string;
};

import type { ProjectSummary } from "./projects.js";

export type { ProjectSummary } from "./projects.js";

export type StartupState = {
  gaps: ReadinessGap[];
  projects: ProjectSummary[];
  passed: number;
};

import type { PreferencesApi } from "./preferences.js";
import type { ProjectsApi } from "./projects.js";
import type { PiLotApi as ProviderApi } from "./providers.js";

export type PiLotApi = ProviderApi & PreferencesApi & ProjectsApi & {
  getStartupState(): Promise<StartupState>;
};
