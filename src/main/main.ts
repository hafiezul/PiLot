import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPreferences, saveAppearance } from "./preferences.js";
import { getProviderState, login, logout, removeApiKey, respondToOAuth, setApiKey } from "./providers.js";
import { getStartupState } from "./readiness.js";
import type { Appearance, Preferences } from "../shared/preferences.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const debuggingPort = process.argv.find((argument) => argument.startsWith("--pilot-debug-port="))?.split("=")[1];
if (debuggingPort) app.commandLine.appendSwitch("remote-debugging-port", debuggingPort);
if (process.env.PILOT_USER_DATA_DIR) app.setPath("userData", process.env.PILOT_USER_DATA_DIR);

let preferences: Preferences = { appearance: "system" };

function chromeColors() {
  return nativeTheme.shouldUseDarkColors
    ? { background: "#242523", foreground: "#e8e8e5" }
    : { background: "#ebebea", foreground: "#20211f" };
}

function updateWindowChrome() {
  const colors = chromeColors();
  for (const window of BrowserWindow.getAllWindows()) {
    window.setBackgroundColor(colors.background);
    if (process.platform !== "darwin") window.setTitleBarOverlay({ color: colors.background, symbolColor: colors.foreground, height: 38 });
  }
}

function createWindow() {
  const colors = chromeColors();
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 680,
    minHeight: 520,
    backgroundColor: colors.background,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    ...(process.platform === "darwin" ? {} : {
      titleBarOverlay: { color: colors.background, symbolColor: colors.foreground, height: 38 },
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

app.whenReady().then(async () => {
  preferences = await loadPreferences(app.getPath("userData"));
  nativeTheme.themeSource = preferences.appearance;
  nativeTheme.on("updated", updateWindowChrome);

  ipcMain.handle("startup:get", getStartupState);
  ipcMain.handle("preferences:get", () => preferences);
  ipcMain.handle("preferences:set-appearance", async (_event, appearance: Appearance) => {
    preferences = await saveAppearance(app.getPath("userData"), appearance);
    nativeTheme.themeSource = preferences.appearance;
    updateWindowChrome();
    return preferences;
  });
  ipcMain.handle("providers:get", getProviderState);
  ipcMain.handle("providers:set-key", (_event, provider: string, key: string) => setApiKey(provider, key));
  ipcMain.handle("providers:remove-key", (_event, provider: string) => removeApiKey(provider));
  ipcMain.handle("providers:login", (event, provider: string) => login(provider, event.sender));
  ipcMain.handle("providers:logout", (_event, provider: string) => logout(provider));
  ipcMain.handle("providers:oauth-reply", (_event, value?: string) => respondToOAuth(value));
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
