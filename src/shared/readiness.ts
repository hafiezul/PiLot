export type ReadinessGap = {
  area: "provider" | "shell" | "environment" | "sessions";
  title: string;
  detail: string;
};

export type ProjectSummary = {
  name: string;
  taskCount: number;
};

export type StartupState = {
  gaps: ReadinessGap[];
  projects: ProjectSummary[];
  passed: number;
};

import type { PiLotApi as ProviderApi } from "./providers.js";

export type PiLotApi = ProviderApi & {
  getStartupState(): Promise<StartupState>;
};
