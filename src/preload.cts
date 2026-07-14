const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");
import type { DesktopActionId } from "./shared/actions.js";
import type { TaskRunState } from "./shared/projects.js";
import type { OAuthEvent } from "./shared/providers.js";
import type { PiLotApi } from "./shared/readiness.js";

const api: PiLotApi = {
  getStartupState: () => ipcRenderer.invoke("startup:get"),
  platform: process.platform as "darwin" | "win32" | "linux",
  setActionState: (states) => ipcRenderer.send("actions:set-state", states),
  onAction: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, id: DesktopActionId) => listener(id);
    ipcRenderer.on("actions:invoke", handler);
    return () => ipcRenderer.removeListener("actions:invoke", handler);
  },
  getPreferences: () => ipcRenderer.invoke("preferences:get"),
  setAppearance: (appearance) => ipcRenderer.invoke("preferences:set-appearance", appearance),
  setExpandThinking: (expand) => ipcRenderer.invoke("preferences:set-expand-thinking", expand),
  getApplicationState: (projectPath, taskPath) => ipcRenderer.invoke("applications:get", projectPath, taskPath),
  setPreferredApplication: (projectPath, taskPath, application) => ipcRenderer.invoke("applications:set-preferred", projectPath, taskPath, application),
  getProviderState: () => ipcRenderer.invoke("providers:get"),
  setApiKey: (provider, key) => ipcRenderer.invoke("providers:set-key", provider, key),
  removeApiKey: (provider) => ipcRenderer.invoke("providers:remove-key", provider),
  login: (provider) => ipcRenderer.invoke("providers:login", provider),
  logout: (provider) => ipcRenderer.invoke("providers:logout", provider),
  respondToOAuth: (value) => ipcRenderer.invoke("providers:oauth-reply", value),
  onOAuthEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: OAuthEvent) => listener(value);
    ipcRenderer.on("providers:oauth-event", handler);
    return () => ipcRenderer.removeListener("providers:oauth-event", handler);
  },
  getProjects: () => ipcRenderer.invoke("projects:get"),
  addProject: () => ipcRenderer.invoke("projects:add"),
  selectProject: (path) => ipcRenderer.invoke("projects:select", path),
  removeProject: (path) => ipcRenderer.invoke("projects:remove", path),
  createTask: (projectPath) => ipcRenderer.invoke("tasks:create", projectPath),
  getTaskRun: (projectPath, taskPath) => ipcRenderer.invoke("tasks:get-run", projectPath, taskPath),
  reloadTask: (projectPath, taskPath) => ipcRenderer.invoke("tasks:reload", projectPath, taskPath),
  forkChangedTask: (projectPath, taskPath) => ipcRenderer.invoke("tasks:fork-changed", projectPath, taskPath),
  getTaskModel: (projectPath, taskPath) => ipcRenderer.invoke("tasks:get-model", projectPath, taskPath),
  getTaskResources: (projectPath, taskPath) => ipcRenderer.invoke("tasks:get-resources", projectPath, taskPath),
  getTaskHistory: (projectPath, taskPath) => ipcRenderer.invoke("tasks:get-history", projectPath, taskPath),
  navigateTaskHistory: (projectPath, taskPath, entryId, summarize, customInstructions) => ipcRenderer.invoke("tasks:navigate-history", projectPath, taskPath, entryId, summarize, customInstructions),
  setTaskHistoryLabel: (projectPath, taskPath, entryId, label) => ipcRenderer.invoke("tasks:set-history-label", projectPath, taskPath, entryId, label),
  forkTaskFromHistory: (projectPath, taskPath, entryId) => ipcRenderer.invoke("tasks:fork-history", projectPath, taskPath, entryId),
  cloneTaskHistory: (projectPath, taskPath) => ipcRenderer.invoke("tasks:clone-history", projectPath, taskPath),
  getTaskChanges: (projectPath, taskPath) => ipcRenderer.invoke("tasks:get-changes", projectPath, taskPath),
  getTaskFileDiff: (projectPath, taskPath, filePath) => ipcRenderer.invoke("tasks:get-file-diff", projectPath, taskPath, filePath),
  openTaskPathInApplication: (projectPath, taskPath, application, filePath) => ipcRenderer.invoke("tasks:open-in-application", projectPath, taskPath, application, filePath),
  setTaskModel: (projectPath, taskPath, provider, modelId) => ipcRenderer.invoke("tasks:set-model", projectPath, taskPath, provider, modelId),
  setTaskThinking: (projectPath, taskPath, level) => ipcRenderer.invoke("tasks:set-thinking", projectPath, taskPath, level),
  submitPrompt: (projectPath, taskPath, prompt, images) => ipcRenderer.invoke("tasks:submit", projectPath, taskPath, prompt, images),
  queuePrompt: (taskPath, prompt, mode) => ipcRenderer.invoke("tasks:queue", taskPath, prompt, mode),
  executeCommand: (projectPath, taskPath, command, includeInContext) => ipcRenderer.invoke("tasks:command", projectPath, taskPath, command, includeInContext),
  compactTask: (projectPath, taskPath) => ipcRenderer.invoke("tasks:compact", projectPath, taskPath),
  exportTask: (projectPath, taskPath, format) => ipcRenderer.invoke("tasks:export", projectPath, taskPath, format),
  abortRetry: (taskPath) => ipcRenderer.invoke("tasks:abort-retry", taskPath),
  abortTask: (taskPath) => ipcRenderer.invoke("tasks:abort", taskPath),
  openOutput: (path) => ipcRenderer.invoke("outputs:open", path),
  onTaskRunEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: TaskRunState) => listener(value);
    ipcRenderer.on("tasks:run-event", handler);
    return () => ipcRenderer.removeListener("tasks:run-event", handler);
  },
  setTaskArchived: (projectPath, taskPath, archived) => ipcRenderer.invoke("projects:set-task-archived", projectPath, taskPath, archived),
  setResourceTrust: (path, trusted) => ipcRenderer.invoke("projects:set-resource-trust", path, trusted),
  setExecutionConsent: (path, consent) => ipcRenderer.invoke("projects:set-execution-consent", path, consent),
};

contextBridge.exposeInMainWorld("pilot", api);
