const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");
import type { OAuthEvent } from "./shared/providers.js";
import type { PiLotApi } from "./shared/readiness.js";

const api: PiLotApi = {
  getStartupState: () => ipcRenderer.invoke("startup:get"),
  getPreferences: () => ipcRenderer.invoke("preferences:get"),
  setAppearance: (appearance) => ipcRenderer.invoke("preferences:set-appearance", appearance),
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
};

contextBridge.exposeInMainWorld("pilot", api);
