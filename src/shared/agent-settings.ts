import type { ThinkingLevel } from "./projects.js";

export type AgentModelOption = {
  provider: string;
  id: string;
  name: string;
};

export type AgentRetrySettings = {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
};

export type AgentCompactionSettings = {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
};

export type AgentSettingsState = {
  settingsPath: string;
  defaultModel?: AgentModelOption & { available: boolean };
  models: AgentModelOption[];
  defaultThinkingLevel: ThinkingLevel;
  enabledModels: string[];
  scopeDiagnostics: string[];
  retry: AgentRetrySettings;
  compaction: AgentCompactionSettings;
};

export type AgentSettingsApi = {
  getAgentSettings(): Promise<AgentSettingsState>;
  setDefaultAgentModel(provider: string, modelId: string): Promise<AgentSettingsState>;
  setDefaultAgentThinking(level: ThinkingLevel): Promise<AgentSettingsState>;
  setAgentModelScope(patterns: string[]): Promise<AgentSettingsState>;
  setAgentRetry(settings: AgentRetrySettings): Promise<AgentSettingsState>;
  setAgentCompaction(settings: AgentCompactionSettings): Promise<AgentSettingsState>;
};
