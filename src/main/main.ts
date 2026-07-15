import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, screen, shell, Tray, type MenuItemConstructorOptions } from "electron";
import { realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPreferences, saveAppearance, saveExpandThinking, saveGlobalRunCap, saveNotificationPreferences, savePanePreferences, savePreferredApplication, savePreferredTerminal, saveRecentSelection, saveWindowPreference } from "./preferences.js";
import { getAgentSettings, saveAgentCompaction, saveAgentModelScope, saveAgentRetry, saveDefaultAgentModel, saveDefaultAgentThinking } from "./agent-settings.js";
import { addProject, assertExecutionAllowed, assertProjectAdmitted, createTask, getProjectEnvironmentOverrides, getProjectsState, getTaskCreation, ProjectStateLoadError, removeProject, selectProject, setExecutionConsent, setProjectEnvironmentOverrides, setResourceTrust, setTaskArchived, withTaskExecution } from "./projects.js";
import { getProviderState, login, logout, removeApiKey, respondToOAuth, setApiKey } from "./providers.js";
import { RunCoordinator } from "./runs.js";
import { assertRunnableTask, getTaskModelState, recoverTaskWorktreeRemovals, setTaskModel, setTaskThinking } from "./tasks.js";
import { getTaskResources } from "./resources.js";
import { getStartupState } from "./readiness.js";
import { getTaskChanges, getTaskFileDiff, openTaskPathInApplication } from "./changes.js";
import { getApplicationState, getConfiguredEditor, getTerminalState } from "./editors.js";
import { createTaskWorktreeBranch, getTaskWorktreeState, openTaskWorktreeTerminal, removeManagedWorktree, WorktreeSetupCoordinator } from "./worktrees.js";
import { desktopActionIds, desktopActions, type DesktopActionId, type DesktopActionState } from "../shared/actions.js";
import type { DiagnosticOperation } from "../shared/diagnostics.js";
import { applicationIds, type ApplicationId } from "../shared/editors.js";
import { type Appearance, type Preferences } from "../shared/preferences.js";
import { CHANGE_STATUSES, type ChangeStatus, type ImageAttachment, type ProjectEnvironmentOverride, type TaskCreationRequest, type TaskWorktreeFile, type ThinkingLevel } from "../shared/projects.js";
import { captureLoginShellEnvironment, installCapturedEnvironment, projectEnvironment } from "./environment.js";
import { backgroundRunStatus, lastWindowPrompt, RunAttentionPolicy, type RunAttentionNotification } from "./desktop-lifecycle.js";
import { LocalDiagnostics } from "./diagnostics.js";

function disablePiTelemetry(environment: NodeJS.ProcessEnv) {
  for (const name of Object.keys(environment)) if (name.toUpperCase() === "PI_TELEMETRY") delete environment[name];
  environment.PI_TELEMETRY = "0";
  return environment;
}

// PiLot never opts into the Pi CLI's install telemetry, and intentionally does not start Electron's crashReporter.
disablePiTelemetry(process.env);

const directory = path.dirname(fileURLToPath(import.meta.url));
const developmentRenderer = !app.isPackaged && process.env.PILOT_DEV_SERVER === "1"
  ? "http://127.0.0.1:5173"
  : undefined;
const debuggingPort = process.argv.find((argument) => argument.startsWith("--pilot-debug-port="))?.split("=")[1];
const testWindowHidden = process.argv.includes("--pilot-test-hidden");
const testLifecycle = !app.isPackaged && process.argv.includes("--pilot-test-lifecycle");
const testCloseResponse = testLifecycle ? process.env.PILOT_TEST_CLOSE_RESPONSE : undefined;
// The 32 px representations keep the status icon crisp at 2x display scale.
const macTrayIcon = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAARElEQVR42mNgoBH4jwMTrZEseWJtwanuPwHn/0dTg1UzsQZgGPKfgDP/41AzagARMYEtZhjwpYP/lKZWipIyVTITyQAArBFUrN6dr4YAAAAASUVORK5CYII=";
const macTrayIcon2x = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAaUlEQVR42u2XQQoAIAgENfz/l+0cRBYqCq3n2rZRw4h+D35YqxnaozMBddC63t+SgPfmT3rlBOSCjgZR1pY1IJtccXK9Lee0rgErhxzRPeUEYAAGYAAGxHqrA+aAoy4mIkzFAz8jQhTHBM0KEz4Gi2RdAAAAAElFTkSuQmCC";
const windowsTrayIcon = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAATUlEQVR42mNgoAXQ1dP5jw0Trfndu9dYMUFD8GkmaAhMs7KKEl6M1RBkm4kxAMMQdKejK0bnjxrwmviYwBYzRKUFshISVZIyVTITqQAAo5eaqgBj2VUAAAAASUVORK5CYII=";
const windowsTrayIcon2x = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAjUlEQVR42mNgGOmAkViFuno6/0kx+PKlK0SZzTToQwDm84MH9pNksL2DI1EhMXhDgFyfkxoSgy8E0H1uamZOkQWnT53EGxIDHgIs1I5zXABmrr2D43/kkBg8IUAoDtHTAkwcBgjJD9pyYNQBow4YdcCoA1jQ23CwsprSOgFWMg762nC0RTTaKh7tGY0CAAB1TYjPqNxpAAAAAElFTkSuQmCC";
const changeStatuses = new Set<ChangeStatus>(CHANGE_STATUSES);
if (debuggingPort) app.commandLine.appendSwitch("remote-debugging-port", debuggingPort);
if (process.env.PILOT_USER_DATA_DIR) app.setPath("userData", process.env.PILOT_USER_DATA_DIR);
if (process.platform === "win32") app.setAppUserModelId("com.hafiezul.pilot");

let preferences: Preferences;
let diagnostics: LocalDiagnostics | undefined;
let runCoordinator: RunCoordinator | undefined;
let setupCoordinatorForQuit: WorktreeSetupCoordinator | undefined;
let mainWindow: BrowserWindow | undefined;
let backgroundTray: Tray | undefined;
let backgroundStatusKey: string | undefined;
let backgroundMode = false;
let closeDecisionPending = false;
let quitCleanupStarted = false;
let quitCleanupFinished = false;
const actionMenuItems = new Map<DesktopActionId, Electron.MenuItem>();
const runAttentionPolicy = new RunAttentionPolicy();
const liveNotifications = new Set<Notification>();
const maximumLiveNotifications = 128;

type LastWindowChoice = "background" | "stop" | "cancel";

function diagnosticApplication() {
  return {
    name: "PiLot" as const,
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    architecture: process.arch,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
  };
}

async function withDiagnostic<T>(operation: DiagnosticOperation, action: () => T | Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    await diagnostics?.record(operation, error);
    throw error;
  }
}

function handleDiagnostic(
  channel: string,
  operation: DiagnosticOperation,
  listener: Parameters<typeof ipcMain.handle>[1],
) {
  ipcMain.handle(channel, (...args) => withDiagnostic(operation, () => listener(...args)));
}

function runActivity() {
  return runCoordinator?.getActivity() ?? { runCount: 0, activeCount: 0, waitingCount: 0 };
}

function destroyBackgroundTray() {
  backgroundTray?.destroy();
  backgroundTray = undefined;
  backgroundStatusKey = undefined;
}

function restoreMainWindow() {
  backgroundMode = false;
  destroyBackgroundTray();
  if (process.platform === "darwin") app.show();
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : BrowserWindow.getAllWindows()[0];
  if (!window) {
    createWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function refreshBackgroundTray() {
  if (!backgroundMode) return;
  const { activeCount, waitingCount, runCount } = runActivity();
  const statusKey = `${activeCount}:${waitingCount}`;
  if (backgroundTray && statusKey === backgroundStatusKey) return;
  const status = backgroundRunStatus({ activeCount, waitingCount });
  if (!backgroundTray) {
    const image = nativeImage.createFromDataURL(process.platform === "darwin" ? macTrayIcon : windowsTrayIcon);
    image.addRepresentation({ scaleFactor: 2, dataURL: process.platform === "darwin" ? macTrayIcon2x : windowsTrayIcon2x });
    if (process.platform === "darwin") image.setTemplateImage(true);
    backgroundTray = new Tray(image);
    backgroundTray.on("click", restoreMainWindow);
  }
  backgroundTray.setToolTip(status.tooltip);
  if (process.platform === "darwin") backgroundTray.setTitle(runCount ? ` ${runCount}` : "");
  backgroundTray.setContextMenu(Menu.buildFromTemplate([
    { label: status.menuLabel, enabled: false },
    { type: "separator" },
    { label: "Open PiLot", click: restoreMainWindow },
    { label: runCount ? "Stop Runs and Quit" : "Quit PiLot", click: () => app.quit() },
  ]));
  backgroundStatusKey = statusKey;
}

function continueInBackground(window: BrowserWindow) {
  backgroundMode = true;
  try {
    refreshBackgroundTray();
    window.hide();
  } catch (error) {
    backgroundMode = false;
    destroyBackgroundTray();
    throw error;
  }
}

async function chooseLastWindowAction(window: BrowserWindow, runCount: number): Promise<LastWindowChoice> {
  if (testCloseResponse === "background" || testCloseResponse === "stop" || testCloseResponse === "cancel") return testCloseResponse;
  const prompt = lastWindowPrompt(runCount);
  const result = await dialog.showMessageBox(window, {
    type: "warning",
    ...prompt,
    buttons: [...prompt.buttons],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  return result.response === 0 ? "background" : result.response === 1 ? "stop" : "cancel";
}

function showRunAttention(attention: RunAttentionNotification) {
  if (testWindowHidden || !Notification.isSupported()) return;
  const notification = new Notification({
    id: attention.id,
    groupId: "pilot-runs",
    ...(process.platform === "win32" ? { groupTitle: "PiLot Runs" } : {}),
    title: attention.title,
    body: attention.body,
  });
  liveNotifications.add(notification);
  while (liveNotifications.size > maximumLiveNotifications) {
    const oldest = liveNotifications.values().next().value as Notification | undefined;
    if (!oldest) break;
    liveNotifications.delete(oldest);
    oldest.close();
  }
  const release = () => liveNotifications.delete(notification);
  notification.once("click", () => {
    release();
    restoreMainWindow();
  });
  notification.once("close", release);
  notification.once("failed", (_event, error) => {
    release();
    void diagnostics?.record("app.notification", error);
    console.error("Could not show a PiLot notification");
  });
  try {
    notification.show();
  } catch (error) {
    release();
    void diagnostics?.record("app.notification", error);
    console.error("Could not show a PiLot notification");
  }
}

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

function restoredWindowBounds() {
  const saved = preferences.window;
  if (!saved) return { width: 1180, height: 760 };
  const positioned = saved.x !== undefined && saved.y !== undefined;
  const display = positioned
    ? screen.getDisplayMatching({ x: saved.x!, y: saved.y!, width: saved.width, height: saved.height })
    : screen.getPrimaryDisplay();
  const width = Math.max(680, Math.min(saved.width, display.workArea.width));
  const height = Math.max(520, Math.min(saved.height, display.workArea.height));
  return {
    width,
    height,
    ...(positioned ? {
      x: Math.max(display.workArea.x, Math.min(saved.x!, display.workArea.x + display.workArea.width - width)),
      y: Math.max(display.workArea.y, Math.min(saved.y!, display.workArea.y + display.workArea.height - height)),
    } : {}),
  };
}

function createWindow() {
  const colors = chromeColors();
  const window = new BrowserWindow({
    ...restoredWindowBounds(),
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
      ...(testLifecycle ? { additionalArguments: ["--pilot-test-lifecycle-api"] } : {}),
    },
  });

  mainWindow = window;
  window.webContents.on("render-process-gone", () => { void diagnostics?.record("app.window-load"); });
  window.on("unresponsive", () => { void diagnostics?.record("app.window-load"); });
  if (preferences.window?.maximized) window.maximize();
  if (!testWindowHidden) window.once("ready-to-show", () => window.show());

  let geometryTimer: NodeJS.Timeout | undefined;
  const persistGeometry = () => {
    geometryTimer = undefined;
    const bounds = window.getNormalBounds();
    void saveWindowPreference(app.getPath("userData"), { ...bounds, maximized: window.isMaximized() }).then((next) => { preferences = next; })
      .catch((error) => {
        void diagnostics?.record("preferences.write", error);
        console.error("Could not save PiLot window geometry");
      });
  };
  const scheduleGeometry = () => {
    if (geometryTimer) clearTimeout(geometryTimer);
    geometryTimer = setTimeout(persistGeometry, 150);
  };
  window.on("move", scheduleGeometry);
  window.on("resize", scheduleGeometry);
  window.on("maximize", scheduleGeometry);
  window.on("unmaximize", scheduleGeometry);
  window.on("close", (event) => {
    if (geometryTimer) clearTimeout(geometryTimer);
    persistGeometry();
    if (quitCleanupStarted || quitCleanupFinished) return;
    if (BrowserWindow.getAllWindows().some((candidate) => candidate !== window && !candidate.isDestroyed())) return;
    const { runCount } = runActivity();
    if (!runCount) return;
    event.preventDefault();
    if (closeDecisionPending) return;
    closeDecisionPending = true;
    void chooseLastWindowAction(window, runCount).then((choice) => {
      if (window.isDestroyed()) return;
      if (choice === "background") {
        continueInBackground(window);
      } else if (choice === "stop") {
        setImmediate(() => app.quit());
      }
    }).catch((error) => {
      void diagnostics?.record("app.lifecycle", error);
      console.error("Could not choose how to close PiLot");
    }).finally(() => {
      closeDecisionPending = false;
    });
  });
  window.on("closed", () => {
    if (geometryTimer) clearTimeout(geometryTimer);
    if (mainWindow === window) mainWindow = undefined;
  });

  void (developmentRenderer
    ? window.loadURL(developmentRenderer)
    : window.loadFile(path.join(directory, "../../renderer/index.html")))
    .catch((error) => diagnostics?.record("app.window-load", error));
}

app.whenReady().then(async () => {
  const localDiagnostics = new LocalDiagnostics(app.getPath("userData"), diagnosticApplication());
  diagnostics = localDiagnostics;
  await localDiagnostics.record("app.start");
  const launchEnvironment = { ...process.env };
  const bootstrapAgentDir = getAgentDir();
  const bootstrapSettings = SettingsManager.create(homedir(), bootstrapAgentDir, { projectTrusted: false });
  const capturedEnvironment = await captureLoginShellEnvironment(launchEnvironment, bootstrapSettings.getShellPath());
  if (capturedEnvironment.error) await localDiagnostics.record("shell.capture", capturedEnvironment.error);
  const baseEnvironment = disablePiTelemetry(installCapturedEnvironment(capturedEnvironment, launchEnvironment));
  disablePiTelemetry(process.env);
  const agentDir = getAgentDir();
  const environmentForProject = async (projectPath: string) => projectEnvironment(
    baseEnvironment,
    await getProjectEnvironmentOverrides(app.getPath("userData"), projectPath),
    agentDir,
  );

  preferences = await loadPreferences(app.getPath("userData"));
  await recoverTaskWorktreeRemovals(
    app.getPath("userData"),
    agentDir,
    (error) => localDiagnostics.record("runtime.setup", error),
  );
  nativeTheme.themeSource = preferences.appearance;
  nativeTheme.on("updated", updateWindowChrome);

  createApplicationMenu();
  const diagnosedRuns = new Map<string, string>();
  const runs = new RunCoordinator(app.getPath("userData"), agentDir, (state) => {
    const latestRun = state.runs.at(-1);
    if (latestRun && (latestRun.status === "failed" || latestRun.status === "interrupted")
      && diagnosedRuns.get(state.taskPath) !== latestRun.id) {
      diagnosedRuns.set(state.taskPath, latestRun.id);
      if (diagnosedRuns.size > 1_000) diagnosedRuns.delete(diagnosedRuns.keys().next().value!);
      void diagnostics?.record("runtime.run");
    }
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send("tasks:run-event", state);
    const focused = BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isFocused());
    for (const attention of runAttentionPolicy.observe(state, { focused, preferences: preferences.notifications })) {
      showRunAttention(attention);
    }
    refreshBackgroundTray();
  }, environmentForProject, preferences.globalRunCap);
  runCoordinator = runs;
  if (testLifecycle) {
    ipcMain.on("window:test-close", (event) => BrowserWindow.fromWebContents(event.sender)?.close());
    ipcMain.handle("window:test-lifecycle-state", (event) => ({
      windowVisible: BrowserWindow.fromWebContents(event.sender)?.isVisible() ?? false,
      statusPresent: Boolean(backgroundTray && !backgroundTray.isDestroyed()),
    }));
  }
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

  handleDiagnostic("startup:get", "shell.resolve", () => getStartupState(capturedEnvironment, baseEnvironment));
  handleDiagnostic("preferences:get", "preferences.read", () => preferences);
  handleDiagnostic("preferences:set-appearance", "preferences.write", async (_event, appearance: Appearance) => {
    preferences = await saveAppearance(app.getPath("userData"), appearance);
    nativeTheme.themeSource = preferences.appearance;
    updateWindowChrome();
    return preferences;
  });
  handleDiagnostic("preferences:set-expand-thinking", "preferences.write", async (_event, expand: unknown) => {
    preferences = await saveExpandThinking(app.getPath("userData"), expand);
    return preferences;
  });
  handleDiagnostic("preferences:set-global-run-cap", "preferences.write", async (_event, limit: unknown) => {
    preferences = await saveGlobalRunCap(app.getPath("userData"), limit);
    runs.setRunLimit(preferences.globalRunCap);
    return preferences;
  });
  handleDiagnostic("preferences:set-notifications", "preferences.write", async (_event, notifications: unknown) => {
    preferences = await saveNotificationPreferences(app.getPath("userData"), notifications);
    return preferences;
  });
  handleDiagnostic("preferences:set-panes", "preferences.write", async (_event, panes: unknown) => {
    preferences = await savePanePreferences(app.getPath("userData"), panes);
    return preferences;
  });
  handleDiagnostic("preferences:set-recent-selection", "preferences.write", async (_event, projectPath: unknown, taskPath: unknown) => {
    preferences = await saveRecentSelection(app.getPath("userData"), projectPath, taskPath);
    return preferences;
  });
  handleDiagnostic("agent-settings:get", "settings.read", () => getAgentSettings(getAgentDir()));
  handleDiagnostic("agent-settings:set-default-model", "settings.write", (_event, provider: unknown, modelId: unknown) =>
    saveDefaultAgentModel(getAgentDir(), provider, modelId));
  handleDiagnostic("agent-settings:set-default-thinking", "settings.write", (_event, level: unknown) =>
    saveDefaultAgentThinking(getAgentDir(), level));
  handleDiagnostic("agent-settings:set-model-scope", "settings.write", (_event, patterns: unknown) =>
    saveAgentModelScope(getAgentDir(), patterns));
  handleDiagnostic("agent-settings:set-retry", "settings.write", (_event, settings: unknown) =>
    saveAgentRetry(getAgentDir(), settings));
  handleDiagnostic("agent-settings:set-compaction", "settings.write", (_event, settings: unknown) =>
    saveAgentCompaction(getAgentDir(), settings));
  handleDiagnostic("terminals:get", "shell.resolve", () => getTerminalState(preferences.preferredTerminal, baseEnvironment));
  ipcMain.handle("terminals:set-preferred", async (_event, terminal: unknown) => {
    preferences = await withDiagnostic("preferences.write", () => savePreferredTerminal(app.getPath("userData"), terminal));
    return withDiagnostic("shell.resolve", () => getTerminalState(preferences.preferredTerminal, baseEnvironment));
  });
  handleDiagnostic("providers:get", "auth.read", getProviderState);
  handleDiagnostic("providers:set-key", "auth.write", (_event, provider: string, key: string) => setApiKey(provider, key));
  handleDiagnostic("providers:remove-key", "auth.write", (_event, provider: string) => removeApiKey(provider));
  handleDiagnostic("providers:login", "auth.login", (event, provider: string) => login(provider, event.sender));
  handleDiagnostic("providers:logout", "auth.write", (_event, provider: string) => logout(provider));
  handleDiagnostic("providers:oauth-reply", "auth.login", (_event, value?: string) => respondToOAuth(value));
  handleDiagnostic("diagnostics:get", "diagnostics.preview", () => localDiagnostics.bundle());
  handleDiagnostic("diagnostics:export", "diagnostics.export-failed", async (event) => {
    let destination: string | undefined;
    if (process.env.PILOT_TEST_DIAGNOSTICS_EXPORT_DIR) {
      destination = path.join(process.env.PILOT_TEST_DIAGNOSTICS_EXPORT_DIR, "pilot-diagnostics.json");
    } else {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const options: Electron.SaveDialogOptions = {
        title: "Export Diagnostic Bundle",
        defaultPath: `PiLot-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: "PiLot diagnostics", extensions: ["json"] }],
      };
      const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
      destination = result.canceled ? undefined : result.filePath;
    }
    if (!destination) return false;
    await localDiagnostics.export(destination);
    return true;
  });

  const projectState = async () => {
    const state = await getProjectsState(app.getPath("userData"), getAgentDir());
    const withLiveRuns = (project: NonNullable<typeof state.selected>) => ({
      ...project,
      tasks: project.tasks.map((task) => {
        const runStatus = runs.getLiveRunStatus(task.path);
        return runStatus ? { ...task, runStatus } : task;
      }),
    });
    const projects = state.projects.map(withLiveRuns);
    const selected = state.selected
      ? projects.find(({ path: projectPath }) => projectPath === state.selected!.path) ?? withLiveRuns(state.selected)
      : undefined;
    if (projects.some(({ diagnostics: projectDiagnostics }) => projectDiagnostics.length > 0)
      || (selected?.diagnostics.length ?? 0) > 0) {
      await diagnostics?.record("session.compatibility");
    }
    return { projects, ...(selected ? { selected } : {}) };
  };
  const diagnosedSetups = new Map<string, string>();
  const setups = new WorktreeSetupCoordinator(agentDir, (state) => {
    if ((state.status === "failed" || state.status === "interrupted") && diagnosedSetups.get(state.taskPath) !== state.status) {
      diagnosedSetups.set(state.taskPath, state.status);
      if (diagnosedSetups.size > 1_000) diagnosedSetups.delete(diagnosedSetups.keys().next().value!);
      void diagnostics?.record("runtime.setup");
    } else if (state.status === "running") {
      diagnosedSetups.delete(state.taskPath);
    }
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send("tasks:setup-event", state);
  }, environmentForProject);
  setupCoordinatorForQuit = setups;
  const requireProjectPath = (value: unknown) => {
    if (typeof value !== "string" || !value) throw new Error("A Project path is required");
    return value;
  };
  const requireTaskPath = (value: unknown) => {
    if (typeof value !== "string" || !value) throw new Error("A Task path is required");
    return value;
  };
  const requireHistoryEntry = (value: unknown) => {
    if (typeof value !== "string" || !value || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("A history entry is required");
    return value;
  };
  const requireTaskCreation = (value: unknown): TaskCreationRequest => {
    if (!value || typeof value !== "object" || ((value as TaskCreationRequest).kind !== "local" && (value as TaskCreationRequest).kind !== "worktree")) {
      throw new Error("Choose an Execution location");
    }
    if ((value as TaskCreationRequest).kind === "worktree") {
      if (typeof (value as { ref?: unknown }).ref !== "string") throw new Error("Choose a committed branch or commit");
      const setup = (value as { setupCommand?: unknown }).setupCommand;
      if (setup !== undefined && typeof setup !== "string") throw new Error("Setup command must be text");
    }
    return value as TaskCreationRequest;
  };
  const editorContext = async (projectPath: unknown, taskPath: unknown) => {
    const project = requireProjectPath(projectPath);
    const task = requireTaskPath(taskPath);
    await assertProjectAdmitted(app.getPath("userData"), project);
    const environment = await environmentForProject(project);
    const { executionPath } = await assertRunnableTask(getAgentDir(), project, task, environment);
    return { configured: getConfiguredEditor(getAgentDir(), executionPath, project, environment), environment };
  };
  const worktreeContext = async (projectPath: unknown, taskPath: unknown) => {
    const project = requireProjectPath(projectPath);
    const task = requireTaskPath(taskPath);
    await assertProjectAdmitted(app.getPath("userData"), project);
    return { project, task };
  };
  handleDiagnostic("applications:get", "shell.launch", async (_event, projectPath: unknown, taskPath: unknown) => {
    const { configured, environment } = await editorContext(projectPath, taskPath);
    return getApplicationState(preferences.preferredApplication, configured, environment);
  });
  ipcMain.handle("applications:set-preferred", async (_event, projectPath: unknown, taskPath: unknown, application: unknown) => {
    const { configured, environment } = await withDiagnostic("shell.launch", async () => {
      if (typeof application !== "string" || !applicationIds.has(application as ApplicationId)) throw new Error("Unknown application");
      const context = await editorContext(projectPath, taskPath);
      const state = await getApplicationState(application as ApplicationId, context.configured, context.environment);
      if (!state.available.some(({ id }) => id === application)) throw new Error("That application is not available on this computer");
      return context;
    });
    preferences = await withDiagnostic("preferences.write", () => savePreferredApplication(app.getPath("userData"), application));
    return withDiagnostic("shell.launch", () => getApplicationState(preferences.preferredApplication, configured, environment));
  });
  handleDiagnostic("projects:load-state", "session.read", async () => {
    try {
      return { status: "ready", state: await projectState() } as const;
    } catch (error) {
      if (!(error instanceof ProjectStateLoadError)) throw error;
      await diagnostics?.record("session.read", error);
      return { status: "unreadable", message: error.message } as const;
    }
  });
  handleDiagnostic("projects:get", "session.read", projectState);
  handleDiagnostic("projects:add", "session.read", async (event) => {
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
  handleDiagnostic("projects:select", "session.read", async (_event, projectPath: unknown) => {
    await selectProject(app.getPath("userData"), getAgentDir(), requireProjectPath(projectPath));
    return projectState();
  });
  handleDiagnostic("projects:remove", "session.write", async (_event, projectPath: unknown) => {
    const project = requireProjectPath(projectPath);
    await removeProject(app.getPath("userData"), getAgentDir(), project);
    await runs.abortProject(project);
    return projectState();
  });
  handleDiagnostic("tasks:get-creation", "runtime.command", async (_event, projectPath: unknown) => {
    const project = requireProjectPath(projectPath);
    return getTaskCreation(app.getPath("userData"), getAgentDir(), project, await environmentForProject(project));
  });
  handleDiagnostic("tasks:create", "session.write", async (_event, projectPath: unknown, request: unknown) => {
    const project = requireProjectPath(projectPath);
    return createTask(app.getPath("userData"), getAgentDir(), project, requireTaskCreation(request), await environmentForProject(project));
  });
  handleDiagnostic("tasks:get-run", "session.read", async (_event, projectPath: unknown, taskPath: unknown) =>
    runs.getTaskRun(requireProjectPath(projectPath), requireProjectPath(taskPath)));
  handleDiagnostic("tasks:get-setup", "runtime.setup", async (_event, projectPath: unknown, taskPath: unknown) =>
    setups.get(requireProjectPath(projectPath), requireTaskPath(taskPath)));
  handleDiagnostic("tasks:run-setup", "runtime.setup", async (_event, projectPath: unknown, taskPath: unknown) => {
    const project = requireProjectPath(projectPath);
    const task = requireTaskPath(taskPath);
    await assertExecutionAllowed(app.getPath("userData"), project);
    if ((await setups.get(project, task))?.status === "running") throw new Error("Setup is already running for this Task");
    return runs.withIdleExecution(project, task, () => setups.run(project, task));
  });
  handleDiagnostic("tasks:abort-setup", "runtime.setup", async (_event, taskPath: unknown) => setups.abort(requireTaskPath(taskPath)));
  handleDiagnostic("tasks:bypass-setup", "runtime.setup", async (_event, projectPath: unknown, taskPath: unknown) => {
    const project = requireProjectPath(projectPath);
    const task = requireTaskPath(taskPath);
    await assertExecutionAllowed(app.getPath("userData"), project);
    return runs.withIdleExecution(project, task, () => setups.bypass(project, task));
  });
  handleDiagnostic("tasks:reload", "session.read", async (_event, projectPath: unknown, taskPath: unknown) =>
    runs.reloadTask(requireProjectPath(projectPath), requireTaskPath(taskPath)));
  handleDiagnostic("tasks:fork-changed", "session.write", async (_event, projectPath: unknown, taskPath: unknown, request: unknown) => {
    const project = requireProjectPath(projectPath);
    const task = requireTaskPath(taskPath);
    return withTaskExecution(app.getPath("userData"), getAgentDir(), project, requireTaskCreation(request), ({ execution, setupCommand }) =>
      runs.forkChangedTask(project, task, execution, setupCommand), await environmentForProject(project));
  });
  handleDiagnostic("tasks:get-model", "session.read", async (_event, projectPath: unknown, taskPath: unknown) => {
    const project = requireProjectPath(projectPath);
    return getTaskModelState(getAgentDir(), project, requireProjectPath(taskPath), await environmentForProject(project));
  });
  handleDiagnostic("tasks:get-resources", "session.read", async (_event, projectPath: unknown, taskPath: unknown) => {
    const project = requireProjectPath(projectPath);
    return getTaskResources(getAgentDir(), project, requireProjectPath(taskPath), await environmentForProject(project));
  });
  handleDiagnostic("tasks:get-history", "session.read", async (_event, projectPath: unknown, taskPath: unknown) =>
    runs.getTaskHistory(requireProjectPath(projectPath), requireTaskPath(taskPath)));
  handleDiagnostic("tasks:navigate-history", "session.write", async (_event, projectPath: unknown, taskPath: unknown, entryId: unknown, summarize: unknown, customInstructions: unknown) => {
    if (typeof summarize !== "boolean" || (customInstructions !== undefined && typeof customInstructions !== "string")) throw new Error("Choose valid history navigation options");
    return runs.navigateTaskHistory(requireProjectPath(projectPath), requireTaskPath(taskPath), requireHistoryEntry(entryId), summarize, customInstructions as string | undefined);
  });
  handleDiagnostic("tasks:set-history-label", "session.write", async (_event, projectPath: unknown, taskPath: unknown, entryId: unknown, label: unknown) => {
    if (label !== undefined && typeof label !== "string") throw new Error("A history label must be text");
    return runs.setTaskHistoryLabel(requireProjectPath(projectPath), requireTaskPath(taskPath), requireHistoryEntry(entryId), label as string | undefined);
  });
  handleDiagnostic("tasks:fork-history", "session.write", async (_event, projectPath: unknown, taskPath: unknown, entryId: unknown, request: unknown) => {
    const project = requireProjectPath(projectPath);
    const task = requireTaskPath(taskPath);
    const entry = requireHistoryEntry(entryId);
    return withTaskExecution(app.getPath("userData"), getAgentDir(), project, requireTaskCreation(request), ({ execution, setupCommand }) =>
      runs.forkTaskFromHistory(project, task, entry, execution, setupCommand), await environmentForProject(project));
  });
  handleDiagnostic("tasks:clone-history", "session.write", async (_event, projectPath: unknown, taskPath: unknown, request: unknown) => {
    const project = requireProjectPath(projectPath);
    const task = requireTaskPath(taskPath);
    return withTaskExecution(app.getPath("userData"), getAgentDir(), project, requireTaskCreation(request), ({ execution, setupCommand }) =>
      runs.cloneTaskHistory(project, task, execution, setupCommand), await environmentForProject(project));
  });
  handleDiagnostic("tasks:get-changes", "runtime.command", async (_event, projectPath: unknown, taskPath: unknown) => {
    const project = requireProjectPath(projectPath);
    return getTaskChanges(getAgentDir(), project, requireProjectPath(taskPath), await environmentForProject(project));
  });
  handleDiagnostic("tasks:get-file-diff", "runtime.command", async (_event, projectPath: unknown, taskPath: unknown, filePath: unknown) => {
    if (typeof filePath !== "string" || !filePath) throw new Error("A changed file is required");
    const project = requireProjectPath(projectPath);
    return getTaskFileDiff(getAgentDir(), project, requireProjectPath(taskPath), filePath, await environmentForProject(project));
  });
  handleDiagnostic("tasks:get-worktree", "runtime.command", async (_event, projectPath: unknown, taskPath: unknown) => {
    const { project, task } = await worktreeContext(projectPath, taskPath);
    return getTaskWorktreeState(getAgentDir(), project, task, await environmentForProject(project));
  });
  handleDiagnostic("tasks:create-worktree-branch", "runtime.command", async (_event, projectPath: unknown, taskPath: unknown, branch: unknown) => {
    if (typeof branch !== "string") throw new Error("A branch name is required");
    const { project, task } = await worktreeContext(projectPath, taskPath);
    const environment = await environmentForProject(project);
    return runs.withIdleExecution(project, task, () =>
      createTaskWorktreeBranch(app.getPath("userData"), getAgentDir(), project, task, branch, environment));
  });
  handleDiagnostic("tasks:open-worktree-terminal", "shell.launch", async (_event, projectPath: unknown, taskPath: unknown) => {
    const { project, task } = await worktreeContext(projectPath, taskPath);
    return openTaskWorktreeTerminal(getAgentDir(), project, task, preferences.preferredTerminal, await environmentForProject(project));
  });
  handleDiagnostic("tasks:remove-worktree", "runtime.command", async (_event, projectPath: unknown, taskPath: unknown, discard: unknown, expectedFiles: unknown) => {
    if (typeof discard !== "boolean" || !Array.isArray(expectedFiles)
      || expectedFiles.some((file) => !file || typeof file !== "object" || typeof (file as TaskWorktreeFile).path !== "string" || !(file as TaskWorktreeFile).path
        || typeof (file as TaskWorktreeFile).fingerprint !== "string" || !/^[a-f0-9]{64}$/.test((file as TaskWorktreeFile).fingerprint)
        || !changeStatuses.has((file as TaskWorktreeFile).status)
        || ((file as TaskWorktreeFile).previousPath !== undefined && (typeof (file as TaskWorktreeFile).previousPath !== "string" || !(file as TaskWorktreeFile).previousPath)))) {
      throw new Error("Review the affected files before removing this Worktree");
    }
    const files = expectedFiles as TaskWorktreeFile[];
    if (new Set(files.map(({ path: filePath, previousPath, status }) => JSON.stringify([status, previousPath ?? null, filePath]))).size !== files.length) {
      throw new Error("Review each affected file once before removing this Worktree");
    }
    const { project, task } = await worktreeContext(projectPath, taskPath);
    const environment = await environmentForProject(project);
    return runs.withIdleExecution(project, task, async () => {
      await removeManagedWorktree(app.getPath("userData"), getAgentDir(), project, task, discard, files, environment);
      return projectState();
    });
  });
  handleDiagnostic("tasks:open-in-application", "shell.launch", async (_event, projectPath: unknown, taskPath: unknown, application: unknown, filePath: unknown) => {
    if (typeof application !== "string" || !applicationIds.has(application as ApplicationId)) throw new Error("An application is required");
    if (filePath !== undefined && (typeof filePath !== "string" || !filePath)) throw new Error("A changed file is required");
    const project = requireProjectPath(projectPath);
    return openTaskPathInApplication(app.getPath("userData"), getAgentDir(), project, requireTaskPath(taskPath), application as ApplicationId, filePath as string | undefined, await environmentForProject(project));
  });
  handleDiagnostic("tasks:set-model", "session.write", async (_event, projectPath: unknown, taskPath: unknown, provider: unknown, modelId: unknown) => {
    if (typeof provider !== "string" || typeof modelId !== "string") throw new Error("A provider and model are required");
    const project = requireProjectPath(projectPath);
    return setTaskModel(getAgentDir(), project, requireProjectPath(taskPath), provider, modelId, await environmentForProject(project));
  });
  handleDiagnostic("tasks:set-thinking", "session.write", async (_event, projectPath: unknown, taskPath: unknown, level: unknown) => {
    if (typeof level !== "string") throw new Error("A thinking level is required");
    const project = requireProjectPath(projectPath);
    return setTaskThinking(getAgentDir(), project, requireProjectPath(taskPath), level as ThinkingLevel, await environmentForProject(project));
  });
  handleDiagnostic("tasks:submit", "runtime.run", async (_event, projectPath: unknown, taskPath: unknown, prompt: unknown, images: unknown) => {
    if (typeof prompt !== "string" || (images !== undefined && !Array.isArray(images))) throw new Error("A prompt is required");
    return runs.submitPrompt(requireProjectPath(projectPath), requireProjectPath(taskPath), prompt, (images ?? []) as ImageAttachment[]);
  });
  handleDiagnostic("tasks:queue", "runtime.run", async (_event, taskPath: unknown, prompt: unknown, mode: unknown) => {
    if (typeof prompt !== "string" || (mode !== "steer" && mode !== "followUp")) throw new Error("A live input mode is required");
    return runs.queuePrompt(requireProjectPath(taskPath), prompt, mode);
  });
  handleDiagnostic("tasks:command", "runtime.command", async (_event, projectPath: unknown, taskPath: unknown, command: unknown, includeInContext: unknown) => {
    if (typeof command !== "string" || typeof includeInContext !== "boolean") throw new Error("A command is required");
    return runs.executeCommand(requireProjectPath(projectPath), requireProjectPath(taskPath), command, includeInContext);
  });
  handleDiagnostic("tasks:compact", "runtime.run", async (_event, projectPath: unknown, taskPath: unknown) =>
    runs.compactTask(requireProjectPath(projectPath), requireProjectPath(taskPath)));
  handleDiagnostic("tasks:export", "session.read", async (event, projectPath: unknown, taskPath: unknown, format: unknown) => {
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
  handleDiagnostic("tasks:abort-retry", "runtime.run", async (_event, taskPath: unknown) => runs.abortRetry(requireProjectPath(taskPath)));
  handleDiagnostic("tasks:abort", "runtime.run", async (_event, taskPath: unknown) => runs.abortTask(requireProjectPath(taskPath)));
  handleDiagnostic("outputs:open", "shell.launch", async (_event, outputPath: unknown) => {
    if (typeof outputPath !== "string" || !path.isAbsolute(outputPath)) throw new Error("A complete output path is required");
    const [temporaryDirectory, target] = await Promise.all([realpath(tmpdir()), realpath(outputPath)]);
    const relative = path.relative(temporaryDirectory, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("That output is outside Pi's temporary output directory");
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
  });
  handleDiagnostic("projects:set-task-archived", "session.write", async (_event, projectPath: unknown, taskPath: unknown, archived: unknown) => {
    if (typeof archived !== "boolean") throw new Error("A Task lifecycle is required");
    const project = requireProjectPath(projectPath);
    const task = requireTaskPath(taskPath);
    const update = () => setTaskArchived(app.getPath("userData"), getAgentDir(), project, task, archived);
    return archived ? runs.withIdleExecution(project, task, update) : update();
  });
  handleDiagnostic("projects:set-resource-trust", "settings.write", async (_event, projectPath: unknown, trusted: unknown) => {
    if (typeof trusted !== "boolean") throw new Error("A trust decision is required");
    return setResourceTrust(app.getPath("userData"), getAgentDir(), requireProjectPath(projectPath), trusted);
  });
  handleDiagnostic("projects:set-execution-consent", "preferences.write", async (_event, projectPath: unknown, consent: unknown) => {
    if (typeof consent !== "boolean") throw new Error("An execution consent decision is required");
    const project = requireProjectPath(projectPath);
    await setExecutionConsent(app.getPath("userData"), getAgentDir(), project, consent);
    if (!consent) await runs.abortProject(project);
    return projectState();
  });
  handleDiagnostic("projects:set-environment", "preferences.write", (_event, projectPath: unknown, overrides: unknown) => {
    if (!Array.isArray(overrides) || overrides.some((override) => !override || typeof override !== "object"
      || typeof (override as ProjectEnvironmentOverride).name !== "string"
      || typeof (override as ProjectEnvironmentOverride).value !== "string")) {
      throw new Error("Project environment overrides must contain variable names and values");
    }
    return setProjectEnvironmentOverrides(
      app.getPath("userData"),
      agentDir,
      requireProjectPath(projectPath),
      overrides as ProjectEnvironmentOverride[],
    );
  });
  createWindow();
  if (process.platform === "win32") Notification.handleActivation(restoreMainWindow);
  app.on("child-process-gone", () => { void diagnostics?.record("app.lifecycle"); });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else restoreMainWindow();
  });
}).catch(async (error) => {
  const localDiagnostics = diagnostics ?? new LocalDiagnostics(app.getPath("userData"), diagnosticApplication());
  diagnostics = localDiagnostics;
  await localDiagnostics.record("app.bootstrap", error);
  dialog.showErrorBox("PiLot could not start", "Reopen PiLot and export the local diagnostic bundle from Settings if the problem continues.");
  app.exit(1);
});

app.on("before-quit", (event) => {
  if (quitCleanupFinished) return;
  event.preventDefault();
  if (quitCleanupStarted) return;
  quitCleanupStarted = true;
  backgroundMode = false;
  destroyBackgroundTray();
  void (async () => {
    try {
      const results = await Promise.allSettled([
        runCoordinator?.abortAll(),
        setupCoordinatorForQuit?.abortAll(),
      ]);
      for (const result of results) {
        if (result.status === "rejected") await diagnostics?.record("app.lifecycle", result.reason);
      }
      if (results.some(({ status }) => status === "rejected")) console.error("Could not finish PiLot process cleanup");
    } finally {
      await diagnostics?.flush();
      quitCleanupFinished = true;
      app.exit(0);
    }
  })();
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => app.quit());
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !backgroundMode) app.quit();
});
