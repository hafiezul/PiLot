import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getStartupState } from "./readiness.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const debuggingPort = process.argv.find((argument) => argument.startsWith("--pilot-debug-port="))?.split("=")[1];
if (debuggingPort) app.commandLine.appendSwitch("remote-debugging-port", debuggingPort);

function createWindow() {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 680,
    minHeight: 520,
    backgroundColor: "#f4f4f3",
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
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
