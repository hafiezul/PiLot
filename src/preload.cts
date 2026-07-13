const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");
import type { PiLotApi } from "./shared/readiness.js";

const api: PiLotApi = {
  getStartupState: () => ipcRenderer.invoke("startup:get"),
};

contextBridge.exposeInMainWorld("pilot", api);
