import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPreferences, saveAppearance, saveExpandThinking } from "./preferences.js";
import { addProject, createTask, getProjectsState, removeProject, selectProject, setExecutionConsent, setResourceTrust, setTaskArchived } from "./projects.js";
import { getProviderState, login, logout, removeApiKey, respondToOAuth, setApiKey } from "./providers.js";
import { LocalRunCoordinator } from "./runs.js";
import { getStartupState } from "./readiness.js";
import type { Appearance, Preferences } from "../shared/preferences.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const developmentRenderer = !app.isPackaged && process.env.PILOT_DEV_SERVER === "1"
  ? "http://127.0.0.1:5173"
  : undefined;
const debuggingPort = process.argv.find((argument) => argument.startsWith("--pilot-debug-port="))?.split("=")[1];
if (debuggingPort) app.commandLine.appendSwitch("remote-debugging-port", debuggingPort);
if (process.env.PILOT_USER_DATA_DIR) app.setPath("userData", process.env.PILOT_USER_DATA_DIR);

let preferences: Preferences = { appearance: "system", expandThinking: false };

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
  void (developmentRenderer
    ? window.loadURL(developmentRenderer)
    : window.loadFile(path.join(directory, "../../renderer/index.html")));
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
  ipcMain.handle("preferences:set-expand-thinking", async (_event, expand: unknown) => {
    preferences = await saveExpandThinking(app.getPath("userData"), expand);
    return preferences;
  });
  ipcMain.handle("providers:get", getProviderState);
  ipcMain.handle("providers:set-key", (_event, provider: string, key: string) => setApiKey(provider, key));
  ipcMain.handle("providers:remove-key", (_event, provider: string) => removeApiKey(provider));
  ipcMain.handle("providers:login", (event, provider: string) => login(provider, event.sender));
  ipcMain.handle("providers:logout", (_event, provider: string) => logout(provider));
  ipcMain.handle("providers:oauth-reply", (_event, value?: string) => respondToOAuth(value));

  const projectState = async () => getProjectsState(app.getPath("userData"), getAgentDir());
  const runs = new LocalRunCoordinator(app.getPath("userData"), getAgentDir(), (state) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send("tasks:run-event", state);
  });
  const requireProjectPath = (value: unknown) => {
    if (typeof value !== "string" || !value) throw new Error("A Project path is required");
    return value;
  };
  ipcMain.handle("projects:get", projectState);
  ipcMain.handle("projects:add", async (event) => {
    let projectPath = process.env.PILOT_TEST_PROJECT_DIR;
    if (!projectPath) {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const options: Electron.OpenDialogOptions = { title: "Add Project", properties: ["openDirectory"] };
      const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      projectPath = result.canceled ? undefined : result.filePaths[0];
    }
    if (!projectPath) return projectState();
    return addProject(app.getPath("userData"), getAgentDir(), projectPath);
  });
  ipcMain.handle("projects:select", async (_event, projectPath: unknown) =>
    selectProject(app.getPath("userData"), getAgentDir(), requireProjectPath(projectPath)));
  ipcMain.handle("projects:remove", async (_event, projectPath: unknown) =>
    removeProject(app.getPath("userData"), getAgentDir(), requireProjectPath(projectPath)));
  ipcMain.handle("tasks:create", async (_event, projectPath: unknown) =>
    createTask(app.getPath("userData"), getAgentDir(), requireProjectPath(projectPath)));
  ipcMain.handle("tasks:get-run", async (_event, projectPath: unknown, taskPath: unknown) =>
    runs.getTaskRun(requireProjectPath(projectPath), requireProjectPath(taskPath)));
  ipcMain.handle("tasks:submit", async (_event, projectPath: unknown, taskPath: unknown, prompt: unknown) => {
    if (typeof prompt !== "string") throw new Error("A prompt is required");
    return runs.submitPrompt(requireProjectPath(projectPath), requireProjectPath(taskPath), prompt);
  });
  ipcMain.handle("tasks:queue", async (_event, taskPath: unknown, prompt: unknown, mode: unknown) => {
    if (typeof prompt !== "string" || (mode !== "steer" && mode !== "followUp")) throw new Error("A live input mode is required");
    return runs.queuePrompt(requireProjectPath(taskPath), prompt, mode);
  });
  ipcMain.handle("tasks:command", async (_event, projectPath: unknown, taskPath: unknown, command: unknown, includeInContext: unknown) => {
    if (typeof command !== "string" || typeof includeInContext !== "boolean") throw new Error("A command is required");
    return runs.executeCommand(requireProjectPath(projectPath), requireProjectPath(taskPath), command, includeInContext);
  });
  ipcMain.handle("tasks:abort", async (_event, taskPath: unknown) => runs.abortTask(requireProjectPath(taskPath)));
  ipcMain.handle("outputs:open", async (_event, outputPath: unknown) => {
    if (typeof outputPath !== "string" || !path.isAbsolute(outputPath)) throw new Error("A complete output path is required");
    const [temporaryDirectory, target] = await Promise.all([realpath(tmpdir()), realpath(outputPath)]);
    const relative = path.relative(temporaryDirectory, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("That output is outside Pi's temporary output directory");
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
  });
  ipcMain.handle("projects:set-task-archived", async (_event, projectPath: unknown, taskPath: unknown, archived: unknown) => {
    if (typeof archived !== "boolean") throw new Error("A Task lifecycle is required");
    return setTaskArchived(app.getPath("userData"), getAgentDir(), requireProjectPath(projectPath), requireProjectPath(taskPath), archived);
  });
  ipcMain.handle("projects:set-resource-trust", async (_event, projectPath: unknown, trusted: unknown) => {
    if (typeof trusted !== "boolean") throw new Error("A trust decision is required");
    return setResourceTrust(app.getPath("userData"), getAgentDir(), requireProjectPath(projectPath), trusted);
  });
  ipcMain.handle("projects:set-execution-consent", async (_event, projectPath: unknown, consent: unknown) => {
    if (typeof consent !== "boolean") throw new Error("An execution consent decision is required");
    return setExecutionConsent(app.getPath("userData"), getAgentDir(), requireProjectPath(projectPath), consent);
  });
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
