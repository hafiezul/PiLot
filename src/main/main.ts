import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell, type MenuItemConstructorOptions } from "electron";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPreferences, saveAppearance, saveExpandThinking, savePreferredEditor } from "./preferences.js";
import { addProject, assertProjectAdmitted, createTask, getProjectsState, removeProject, selectProject, setExecutionConsent, setResourceTrust, setTaskArchived } from "./projects.js";
import { getProviderState, login, logout, removeApiKey, respondToOAuth, setApiKey } from "./providers.js";
import { LocalRunCoordinator } from "./runs.js";
import { assertRunnableTask, getTaskModelState, setTaskModel, setTaskThinking } from "./tasks.js";
import { getTaskResources } from "./resources.js";
import { getStartupState } from "./readiness.js";
import { getTaskChanges, getTaskFileDiff, openTaskPathInEditor } from "./changes.js";
import { getConfiguredEditor, getEditorState } from "./editors.js";
import { desktopActionIds, desktopActions, type DesktopActionId, type DesktopActionState } from "../shared/actions.js";
import { editorIds, type EditorId } from "../shared/editors.js";
import type { Appearance, Preferences } from "../shared/preferences.js";
import type { ImageAttachment, ThinkingLevel } from "../shared/projects.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const developmentRenderer = !app.isPackaged && process.env.PILOT_DEV_SERVER === "1"
  ? "http://127.0.0.1:5173"
  : undefined;
const debuggingPort = process.argv.find((argument) => argument.startsWith("--pilot-debug-port="))?.split("=")[1];
const testWindowHidden = process.argv.includes("--pilot-test-hidden");
if (debuggingPort) app.commandLine.appendSwitch("remote-debugging-port", debuggingPort);
if (process.env.PILOT_USER_DATA_DIR) app.setPath("userData", process.env.PILOT_USER_DATA_DIR);

let preferences: Preferences = { appearance: "system", expandThinking: false };
const actionMenuItems = new Map<DesktopActionId, Electron.MenuItem>();

function invokeRendererAction(id: DesktopActionId, target?: Electron.BaseWindow) {
  const window = target instanceof BrowserWindow ? target : BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  window?.webContents.send("actions:invoke", id);
}

function actionMenuItem(id: DesktopActionId): MenuItemConstructorOptions {
  const action = desktopActions.find((candidate) => candidate.id === id)!;
  return {
    id,
    label: action.label,
    accelerator: "accelerator" in action ? action.accelerator : undefined,
    enabled: id === "project.add" || id === "view.settings" || id === "view.commandPalette",
    click: (_item, window) => invokeRendererAction(id, window),
  };
}

function createApplicationMenu() {
  const file: MenuItemConstructorOptions[] = [
    actionMenuItem("project.add"),
    actionMenuItem("task.new"),
    { type: "separator" },
    actionMenuItem("task.exportJsonl"),
    actionMenuItem("task.exportHtml"),
    ...(process.platform === "darwin" ? [] : [{ type: "separator" as const }, actionMenuItem("view.settings")]),
    { type: "separator" },
    { role: "close" },
  ];
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{
      label: app.name,
      submenu: [
        { role: "about" as const },
        { type: "separator" as const },
        actionMenuItem("view.settings"),
        { type: "separator" as const },
        { role: "services" as const },
        { type: "separator" as const },
        { role: "hide" as const },
        { role: "hideOthers" as const },
        { role: "unhide" as const },
        { type: "separator" as const },
        { role: "quit" as const },
      ],
    }] : []),
    { label: "File", submenu: file },
    { role: "editMenu" },
    { label: "Task", submenu: [
      actionMenuItem("task.archive"),
      { type: "separator" },
      actionMenuItem("task.chooseModel"),
      actionMenuItem("task.chooseThinking"),
      { type: "separator" },
      actionMenuItem("resources.reload"),
    ] },
    { label: "Run", submenu: [actionMenuItem("run.compact"), actionMenuItem("run.stop")] },
    { label: "View", submenu: [
      actionMenuItem("view.commandPalette"),
      { type: "separator" },
      actionMenuItem("view.focusPrompt"),
      actionMenuItem("view.details"),
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ] },
    { role: "windowMenu" },
  ];
  const menu = Menu.buildFromTemplate(template);
  for (const action of desktopActions) {
    const item = menu.getMenuItemById(action.id);
    if (item) actionMenuItems.set(action.id, item);
  }
  Menu.setApplicationMenu(menu);
}

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

  if (!testWindowHidden) window.once("ready-to-show", () => window.show());
  void (developmentRenderer
    ? window.loadURL(developmentRenderer)
    : window.loadFile(path.join(directory, "../../renderer/index.html")));
}

app.whenReady().then(async () => {
  preferences = await loadPreferences(app.getPath("userData"));
  nativeTheme.themeSource = preferences.appearance;
  nativeTheme.on("updated", updateWindowChrome);

  createApplicationMenu();
  ipcMain.on("actions:set-state", (_event, states: unknown) => {
    if (!Array.isArray(states) || states.some((state) => !state || typeof state !== "object"
      || typeof (state as DesktopActionState).id !== "string" || !desktopActionIds.has((state as DesktopActionState).id)
      || typeof (state as DesktopActionState).enabled !== "boolean"
      || (typeof (state as DesktopActionState).label !== "undefined" && typeof (state as DesktopActionState).label !== "string"))) return;
    for (const state of states as DesktopActionState[]) {
      const item = actionMenuItems.get(state.id);
      if (!item) continue;
      item.enabled = state.enabled;
      item.label = state.label ?? desktopActions.find(({ id }) => id === state.id)!.label;
    }
  });

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
  const requireTaskPath = (value: unknown) => {
    if (typeof value !== "string" || !value) throw new Error("A Task path is required");
    return value;
  };
  const editorContext = async (projectPath: unknown, taskPath: unknown) => {
    const project = requireProjectPath(projectPath);
    const task = requireTaskPath(taskPath);
    await assertProjectAdmitted(app.getPath("userData"), project);
    const { executionPath } = await assertRunnableTask(getAgentDir(), project, task);
    return getConfiguredEditor(getAgentDir(), executionPath);
  };
  ipcMain.handle("editors:get", async (_event, projectPath: unknown, taskPath: unknown) =>
    getEditorState(preferences.preferredEditor, await editorContext(projectPath, taskPath)));
  ipcMain.handle("editors:set-preferred", async (_event, projectPath: unknown, taskPath: unknown, editor: unknown) => {
    if (typeof editor !== "string" || !editorIds.has(editor as EditorId)) throw new Error("Unknown editor");
    const configured = await editorContext(projectPath, taskPath);
    const state = await getEditorState(editor as EditorId, configured);
    if (!state.available.some(({ id }) => id === editor)) throw new Error("That editor is not available on this computer");
    preferences = await savePreferredEditor(app.getPath("userData"), editor);
    return getEditorState(preferences.preferredEditor, configured);
  });
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
  ipcMain.handle("tasks:get-model", async (_event, projectPath: unknown, taskPath: unknown) =>
    getTaskModelState(getAgentDir(), requireProjectPath(projectPath), requireProjectPath(taskPath)));
  ipcMain.handle("tasks:get-resources", async (_event, projectPath: unknown, taskPath: unknown) =>
    getTaskResources(getAgentDir(), requireProjectPath(projectPath), requireProjectPath(taskPath)));
  ipcMain.handle("tasks:get-changes", async (_event, projectPath: unknown, taskPath: unknown) =>
    getTaskChanges(getAgentDir(), requireProjectPath(projectPath), requireProjectPath(taskPath)));
  ipcMain.handle("tasks:get-file-diff", async (_event, projectPath: unknown, taskPath: unknown, filePath: unknown) => {
    if (typeof filePath !== "string" || !filePath) throw new Error("A changed file is required");
    return getTaskFileDiff(getAgentDir(), requireProjectPath(projectPath), requireProjectPath(taskPath), filePath);
  });
  ipcMain.handle("tasks:open-in-editor", async (_event, projectPath: unknown, taskPath: unknown, editor: unknown, filePath: unknown) => {
    if (typeof editor !== "string" || !editorIds.has(editor as EditorId)) throw new Error("An editor is required");
    if (filePath !== undefined && (typeof filePath !== "string" || !filePath)) throw new Error("A changed file is required");
    return openTaskPathInEditor(app.getPath("userData"), getAgentDir(), requireProjectPath(projectPath), requireTaskPath(taskPath), editor as EditorId, filePath as string | undefined);
  });
  ipcMain.handle("tasks:set-model", async (_event, projectPath: unknown, taskPath: unknown, provider: unknown, modelId: unknown) => {
    if (typeof provider !== "string" || typeof modelId !== "string") throw new Error("A provider and model are required");
    return setTaskModel(getAgentDir(), requireProjectPath(projectPath), requireProjectPath(taskPath), provider, modelId);
  });
  ipcMain.handle("tasks:set-thinking", async (_event, projectPath: unknown, taskPath: unknown, level: unknown) => {
    if (typeof level !== "string") throw new Error("A thinking level is required");
    return setTaskThinking(getAgentDir(), requireProjectPath(projectPath), requireProjectPath(taskPath), level as ThinkingLevel);
  });
  ipcMain.handle("tasks:submit", async (_event, projectPath: unknown, taskPath: unknown, prompt: unknown, images: unknown) => {
    if (typeof prompt !== "string" || (images !== undefined && !Array.isArray(images))) throw new Error("A prompt is required");
    return runs.submitPrompt(requireProjectPath(projectPath), requireProjectPath(taskPath), prompt, (images ?? []) as ImageAttachment[]);
  });
  ipcMain.handle("tasks:queue", async (_event, taskPath: unknown, prompt: unknown, mode: unknown) => {
    if (typeof prompt !== "string" || (mode !== "steer" && mode !== "followUp")) throw new Error("A live input mode is required");
    return runs.queuePrompt(requireProjectPath(taskPath), prompt, mode);
  });
  ipcMain.handle("tasks:command", async (_event, projectPath: unknown, taskPath: unknown, command: unknown, includeInContext: unknown) => {
    if (typeof command !== "string" || typeof includeInContext !== "boolean") throw new Error("A command is required");
    return runs.executeCommand(requireProjectPath(projectPath), requireProjectPath(taskPath), command, includeInContext);
  });
  ipcMain.handle("tasks:compact", async (_event, projectPath: unknown, taskPath: unknown) =>
    runs.compactTask(requireProjectPath(projectPath), requireProjectPath(taskPath)));
  ipcMain.handle("tasks:export", async (event, projectPath: unknown, taskPath: unknown, format: unknown) => {
    const project = requireProjectPath(projectPath);
    const task = requireProjectPath(taskPath);
    if (format !== "jsonl" && format !== "html") throw new Error("Choose a supported Task export format");
    if (process.env.PILOT_TEST_EXPORT_DIR) {
      await runs.exportTask(project, task, format, path.join(process.env.PILOT_TEST_EXPORT_DIR, `pilot-export.${format}`));
      return true;
    }
    const owner = BrowserWindow.fromWebContents(event.sender);
    const warning: Electron.MessageBoxOptions = {
      type: "warning",
      title: "Export Task",
      message: "Task exports may contain sensitive content",
      detail: "The export can include project paths, prompts, model responses, and tool input or output. Review it before sharing. PiLot writes only to the local file you choose.",
      buttons: ["Export", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const confirmation = owner ? await dialog.showMessageBox(owner, warning) : await dialog.showMessageBox(warning);
    if (confirmation.response !== 0) return false;
    const extension = format === "jsonl" ? "jsonl" : "html";
    const options: Electron.SaveDialogOptions = {
      title: `Export Task as ${extension.toUpperCase()}`,
      defaultPath: `${path.basename(task, path.extname(task))}.${extension}`,
      filters: [{ name: format === "jsonl" ? "Pi session" : "Web page", extensions: [extension] }],
    };
    const destination = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
    if (destination.canceled || !destination.filePath) return false;
    await runs.exportTask(project, task, format, destination.filePath);
    return true;
  });
  ipcMain.handle("tasks:abort-retry", async (_event, taskPath: unknown) => runs.abortRetry(requireProjectPath(taskPath)));
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
