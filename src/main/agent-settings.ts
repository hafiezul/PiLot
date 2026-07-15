import {
  AuthStorage,
  ModelRegistry,
  resolveModelScopeWithDiagnostics,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import type { AgentCompactionSettings, AgentRetrySettings, AgentSettingsState } from "../shared/agent-settings.js";
import { thinkingLevels, type ThinkingLevel } from "../shared/projects.js";

const thinkingLevelSet = new Set<ThinkingLevel>(thinkingLevels);

function settingsManager(agentDir: string) {
  return SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
}

type PiSettingsStorage = Parameters<typeof SettingsManager.fromStorage>[0];
type SettingsScope = Parameters<PiSettingsStorage["withLock"]>[0];
type AgentSettingsPatch = {
  retry?: AgentRetrySettings;
  compaction?: AgentCompactionSettings;
};

/** File storage compatible with Pi's canonical lock protocol. */
class LockedSettingsStorage implements PiSettingsStorage {
  private readonly globalPath: string;
  private readonly projectPath: string;

  constructor(agentDir: string) {
    this.globalPath = path.join(agentDir, "settings.json");
    this.projectPath = path.join(agentDir, ".pi", "settings.json");
  }

  private acquireLock(target: string) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        return lockfile.lockSync(target, { realpath: false });
      } catch (error) {
        lastError = error;
        const code = objectValue(error).code;
        if (code !== "ELOCKED" || attempt === 9) throw error;
        const started = Date.now();
        while (Date.now() - started < 20) { /* Match Pi's synchronous settings-lock retry. */ }
      }
    }
    throw lastError;
  }

  withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
    const target = scope === "global" ? this.globalPath : this.projectPath;
    const directory = path.dirname(target);
    let release: (() => void) | undefined;
    try {
      const exists = existsSync(target);
      if (exists) release = this.acquireLock(target);
      const next = fn(exists ? readFileSync(target, "utf8") : undefined);
      if (next === undefined) return;
      if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
      release ??= this.acquireLock(target);
      writeFileSync(target, next, "utf8");
    } finally {
      release?.();
    }
  }
}

/**
 * The pinned Pi SDK exposes complete retry/compaction reads but only enabled-state setters.
 * Apply the remaining public fields to the SettingsManager's serialized update
 * under the same canonical lock, while preserving unrelated nested settings.
 */
class AgentSettingsPatchStorage implements PiSettingsStorage {
  private readonly storage: LockedSettingsStorage;
  private patch: AgentSettingsPatch;

  constructor(agentDir: string, patch: AgentSettingsPatch) {
    this.storage = new LockedSettingsStorage(agentDir);
    this.patch = structuredClone(patch);
  }

  withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
    let patchWritten = false;
    this.storage.withLock(scope, (current) => {
      const next = fn(current);
      if (scope !== "global" || next === undefined || (!this.patch.retry && !this.patch.compaction)) return next;
      const settings = objectValue(JSON.parse(next));
      if (this.patch.retry) settings.retry = { ...objectValue(settings.retry), ...this.patch.retry };
      if (this.patch.compaction) settings.compaction = { ...objectValue(settings.compaction), ...this.patch.compaction };
      patchWritten = true;
      return JSON.stringify(settings, null, 2);
    });
    if (patchWritten) this.patch = {};
  }
}

function settingsError(agentDir: string, errors: ReturnType<SettingsManager["drainErrors"]>, operation: "read" | "save") {
  if (!errors.length) return;
  const first = errors[0].error as NodeJS.ErrnoException;
  if (first.code === "ELOCKED") {
    throw new Error("Pi settings are locked by another process. Wait for that settings change to finish, then try again.");
  }
  const target = path.join(agentDir, "settings.json");
  if (operation === "read") throw new Error(`Pi settings could not be read from ${target}: ${first.message}`);
  throw new Error(`Pi settings could not be saved to ${target}: ${first.message}`);
}

function finiteInteger(value: unknown, fallback: number, minimum = 0) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum ? value : fallback;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function modelRegistry(agentDir: string) {
  const auth = AuthStorage.create(path.join(agentDir, "auth.json"));
  const models = ModelRegistry.create(auth, path.join(agentDir, "models.json"));
  if (models.getError()) throw new Error(`Pi models could not be read from ${path.join(agentDir, "models.json")}: ${models.getError()}`);
  return models;
}

export async function getAgentSettings(agentDir: string): Promise<AgentSettingsState> {
  const manager = settingsManager(agentDir);
  settingsError(agentDir, manager.drainErrors(), "read");
  const global = manager.getGlobalSettings();
  const models = modelRegistry(agentDir);
  const available = models.getAvailable();
  const availableKeys = new Set(available.map((model) => `${model.provider}\0${model.id}`));
  const all = models.getAll();
  const defaultProvider = typeof global.defaultProvider === "string" ? global.defaultProvider : undefined;
  const defaultModelId = typeof global.defaultModel === "string" ? global.defaultModel : undefined;
  const configuredDefault = defaultProvider && defaultModelId
    ? all.find((model) => model.provider === defaultProvider && model.id === defaultModelId)
    : undefined;
  const enabledModels = Array.isArray(global.enabledModels)
    ? global.enabledModels.filter((pattern): pattern is string => typeof pattern === "string")
    : [];
  const scope = enabledModels.length
    ? await resolveModelScopeWithDiagnostics(enabledModels, models)
    : { scopedModels: [], diagnostics: [] };
  const retry = objectValue(global.retry);
  const compaction = objectValue(global.compaction);
  const defaultThinkingLevel = thinkingLevelSet.has(global.defaultThinkingLevel as ThinkingLevel)
    ? global.defaultThinkingLevel as ThinkingLevel
    : "medium";

  return {
    settingsPath: path.join(agentDir, "settings.json"),
    ...(defaultProvider && defaultModelId ? {
      defaultModel: {
        provider: defaultProvider,
        id: defaultModelId,
        name: configuredDefault?.name || defaultModelId,
        available: availableKeys.has(`${defaultProvider}\0${defaultModelId}`),
      },
    } : {}),
    models: available.map((model) => ({ provider: model.provider, id: model.id, name: model.name || model.id }))
      .sort((left, right) => left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name)),
    defaultThinkingLevel,
    enabledModels,
    scopeDiagnostics: scope.diagnostics.map(({ message }) => message),
    retry: {
      enabled: typeof retry.enabled === "boolean" ? retry.enabled : true,
      maxRetries: finiteInteger(retry.maxRetries, 3),
      baseDelayMs: finiteInteger(retry.baseDelayMs, 2_000),
    },
    compaction: {
      enabled: typeof compaction.enabled === "boolean" ? compaction.enabled : true,
      reserveTokens: finiteInteger(compaction.reserveTokens, 16_384, 1),
      keepRecentTokens: finiteInteger(compaction.keepRecentTokens, 20_000, 1),
    },
  };
}

async function updateAgentSettings(
  agentDir: string,
  update: (manager: SettingsManager) => void,
): Promise<AgentSettingsState> {
  const manager = settingsManager(agentDir);
  settingsError(agentDir, manager.drainErrors(), "read");
  update(manager);
  await manager.flush();
  settingsError(agentDir, manager.drainErrors(), "save");
  return getAgentSettings(agentDir);
}

export function saveDefaultAgentModel(agentDir: string, provider: unknown, modelId: unknown) {
  if (typeof provider !== "string" || typeof modelId !== "string") throw new Error("Choose an available default model");
  const available = modelRegistry(agentDir).getAvailable();
  if (!available.some((model) => model.provider === provider && model.id === modelId)) {
    throw new Error("Connect this model's provider before making it the default");
  }
  return updateAgentSettings(agentDir, (manager) => manager.setDefaultModelAndProvider(provider, modelId));
}

export function saveDefaultAgentThinking(agentDir: string, level: unknown) {
  if (typeof level !== "string" || !thinkingLevelSet.has(level as ThinkingLevel)) throw new Error("Choose a valid default thinking level");
  return updateAgentSettings(agentDir, (manager) => manager.setDefaultThinkingLevel(level as ThinkingLevel));
}

export function saveAgentModelScope(agentDir: string, value: unknown) {
  if (!Array.isArray(value)) throw new Error("Model scope must be a list of Pi model patterns");
  const patterns = value.map((pattern) => {
    if (typeof pattern !== "string") throw new Error("Each scoped model pattern must be text");
    const normalized = pattern.trim();
    if (normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error("Each scoped model pattern must be one line and 256 characters or fewer");
    return normalized;
  }).filter(Boolean);
  if (patterns.length > 100) throw new Error("Choose no more than 100 scoped model patterns");
  return updateAgentSettings(agentDir, (manager) => manager.setEnabledModels(patterns.length ? patterns : undefined));
}

function nonNegativeInteger(value: unknown, label: string, minimum = 0) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be ${minimum > 0 ? "a positive" : "a non-negative"} integer`);
  }
  return value;
}

async function updatePatchedAgentSettings(
  agentDir: string,
  patch: AgentSettingsPatch,
  update: (manager: SettingsManager) => void,
): Promise<AgentSettingsState> {
  const manager = SettingsManager.fromStorage(new AgentSettingsPatchStorage(agentDir, patch), { projectTrusted: false });
  settingsError(agentDir, manager.drainErrors(), "read");
  update(manager);
  await manager.flush();
  settingsError(agentDir, manager.drainErrors(), "save");
  return getAgentSettings(agentDir);
}

export function saveAgentRetry(agentDir: string, value: unknown) {
  const retry = objectValue(value);
  if (typeof retry.enabled !== "boolean") throw new Error("Choose whether Pi retries transient failures automatically");
  const settings: AgentRetrySettings = {
    enabled: retry.enabled,
    maxRetries: nonNegativeInteger(retry.maxRetries, "Maximum retries"),
    baseDelayMs: nonNegativeInteger(retry.baseDelayMs, "Base retry delay"),
  };
  return updatePatchedAgentSettings(agentDir, { retry: settings }, (manager) => manager.setRetryEnabled(settings.enabled));
}

export function saveAgentCompaction(agentDir: string, value: unknown) {
  const compaction = objectValue(value);
  if (typeof compaction.enabled !== "boolean") throw new Error("Choose whether Pi compacts context automatically");
  const settings: AgentCompactionSettings = {
    enabled: compaction.enabled,
    reserveTokens: nonNegativeInteger(compaction.reserveTokens, "Reserved tokens", 1),
    keepRecentTokens: nonNegativeInteger(compaction.keepRecentTokens, "Recent tokens", 1),
  };
  return updatePatchedAgentSettings(agentDir, { compaction: settings }, (manager) => manager.setCompactionEnabled(settings.enabled));
}
