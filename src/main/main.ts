import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getStartupState } from "./readiness.js";
import { getProviderState, login, logout, removeApiKey, respondToOAuth, selectModel, setApiKey } from "./providers.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const debuggingPort = process.argv.find((argument) => argument.startsWith("--pilot-debug-port="))?.split("=")[1];
if (debuggingPort) app.commandLine.appendSwitch("remote-debugging-port", debuggingPort);

function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors;
  const chromeColor = dark ? "#242523" : "#ebebea";
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 680,
    minHeight: 520,
    backgroundColor: chromeColor,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    ...(process.platform === "darwin" ? {} : {
      titleBarOverlay: { color: chromeColor, symbolColor: dark ? "#e8e8e5" : "#20211f", height: 38 },
    }),
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(directory, "../preload.cjs"),
    },
  });

  window.once("ready-to-show", () => window.show());
  void window.loadFile(path.join(directory, "../../renderer/index.html"));
}

app.whenReady().then(() => {
  ipcMain.handle("startup:get", getStartupState);
  ipcMain.handle("providers:get", getProviderState);
  ipcMain.handle("providers:set-key", (_event, provider: string, key: string) => setApiKey(provider, key));
  ipcMain.handle("providers:remove-key", (_event, provider: string) => removeApiKey(provider));
  ipcMain.handle("providers:login", (event, provider: string) => login(provider, event.sender));
  ipcMain.handle("providers:logout", (_event, provider: string) => logout(provider));
  ipcMain.handle("providers:select-model", (_event, value: string) => selectModel(value));
  ipcMain.handle("providers:oauth-reply", (_event, value?: string) => respondToOAuth(value));
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
