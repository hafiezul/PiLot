import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { applicationIds, terminalIds, type ApplicationId, type TerminalId } from "../shared/editors.js";
import { appearances, DEFAULT_GLOBAL_RUN_CAP, DEFAULT_INSPECTOR_PANE_WIDTH, DEFAULT_NAVIGATION_PANE_WIDTH, MAXIMUM_GLOBAL_RUN_CAP, MAXIMUM_INSPECTOR_PANE_WIDTH, MAXIMUM_NAVIGATION_PANE_WIDTH, MINIMUM_GLOBAL_RUN_CAP, MINIMUM_INSPECTOR_PANE_WIDTH, MINIMUM_NAVIGATION_PANE_WIDTH, preferenceInspectorViews, type Appearance, type NotificationPreferences, type PanePreferences, type Preferences, type WindowPreference } from "../shared/preferences.js";

const defaults: Preferences = {
  appearance: "system",
  expandThinking: false,
  globalRunCap: DEFAULT_GLOBAL_RUN_CAP,
  notifications: { runCompleted: false, runFailed: true, attentionRequired: true },
  panes: {
    inspectorVisible: false,
    inspectorView: "details",
    navigationWidth: DEFAULT_NAVIGATION_PANE_WIDTH,
    inspectorWidth: DEFAULT_INSPECTOR_PANE_WIDTH,
  },
  recentSelection: {},
  preferredTerminal: "system",
};

function savedWindow(value: unknown): WindowPreference | undefined {
  if (!value || typeof value !== "object") return;
  const window = value as Partial<WindowPreference>;
  if (!Number.isInteger(window.width) || window.width! < 680 || window.width! > 10_000
    || !Number.isInteger(window.height) || window.height! < 520 || window.height! > 10_000
    || (window.x !== undefined && !Number.isSafeInteger(window.x))
    || (window.y !== undefined && !Number.isSafeInteger(window.y))) return;
  return {
    width: window.width!,
    height: window.height!,
    maximized: window.maximized === true,
    ...(window.x === undefined ? {} : { x: window.x }),
    ...(window.y === undefined ? {} : { y: window.y }),
  };
}
let preferenceWrites = Promise.resolve();

function isPaneWidth(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function savedPaneWidth(value: unknown, minimum: number, maximum: number, fallback: number) {
  return isPaneWidth(value, minimum, maximum) ? value : fallback;
}

export async function loadPreferences(directory: string): Promise<Preferences> {
  try {
    const saved = JSON.parse(await readFile(path.join(directory, "preferences.json"), "utf8")) as Partial<Preferences> & { preferredEditor?: unknown };
    const preferredEditor = applicationIds.has(saved.preferredEditor as ApplicationId) ? saved.preferredEditor as ApplicationId : undefined;
    const preferredApplication = applicationIds.has(saved.preferredApplication as ApplicationId)
      ? saved.preferredApplication as ApplicationId
      : preferredEditor;
    const notifications = saved.notifications && typeof saved.notifications === "object"
      ? saved.notifications as Partial<NotificationPreferences>
      : {};
    const panes = saved.panes && typeof saved.panes === "object" ? saved.panes as Partial<PanePreferences> : {};
    const recent = saved.recentSelection && typeof saved.recentSelection === "object"
      ? saved.recentSelection as { projectPath?: unknown; taskPath?: unknown }
      : {};
    const window = savedWindow(saved.window);
    const recentProjectPath = typeof recent.projectPath === "string" && path.isAbsolute(recent.projectPath) ? recent.projectPath : undefined;
    const recentTaskPath = recentProjectPath && typeof recent.taskPath === "string" && path.isAbsolute(recent.taskPath) ? recent.taskPath : undefined;
    return {
      appearance: appearances.includes(saved.appearance as Appearance) ? saved.appearance as Appearance : defaults.appearance,
      expandThinking: saved.expandThinking === true,
      globalRunCap: Number.isInteger(saved.globalRunCap) && saved.globalRunCap! >= MINIMUM_GLOBAL_RUN_CAP && saved.globalRunCap! <= MAXIMUM_GLOBAL_RUN_CAP
        ? saved.globalRunCap!
        : defaults.globalRunCap,
      notifications: {
        runCompleted: typeof notifications.runCompleted === "boolean" ? notifications.runCompleted : defaults.notifications.runCompleted,
        runFailed: typeof notifications.runFailed === "boolean" ? notifications.runFailed : defaults.notifications.runFailed,
        attentionRequired: typeof notifications.attentionRequired === "boolean" ? notifications.attentionRequired : defaults.notifications.attentionRequired,
      },
      panes: {
        inspectorVisible: panes.inspectorVisible === true,
        inspectorView: preferenceInspectorViews.includes(panes.inspectorView as PanePreferences["inspectorView"])
          ? panes.inspectorView as PanePreferences["inspectorView"] : defaults.panes.inspectorView,
        navigationWidth: savedPaneWidth(panes.navigationWidth, MINIMUM_NAVIGATION_PANE_WIDTH, MAXIMUM_NAVIGATION_PANE_WIDTH, defaults.panes.navigationWidth),
        inspectorWidth: savedPaneWidth(panes.inspectorWidth, MINIMUM_INSPECTOR_PANE_WIDTH, MAXIMUM_INSPECTOR_PANE_WIDTH, defaults.panes.inspectorWidth),
      },
      recentSelection: {
        ...(recentProjectPath ? { projectPath: recentProjectPath } : {}),
        ...(recentTaskPath ? { taskPath: recentTaskPath } : {}),
      },
      ...(window ? { window } : {}),
      preferredTerminal: terminalIds.has(saved.preferredTerminal as TerminalId) ? saved.preferredTerminal as TerminalId : defaults.preferredTerminal,
      ...(preferredApplication ? { preferredApplication } : {}),
      ...(preferredEditor ? { preferredEditor } : {}),
    };
  } catch {
    return structuredClone(defaults);
  }
}

async function savePreferences(directory: string, preferences: Preferences) {
  const target = path.join(directory, "preferences.json");
  const temporary = `${target}.tmp`;
  await mkdir(directory, { recursive: true });
  await writeFile(temporary, JSON.stringify(preferences, null, 2));
  await rename(temporary, target);
  return preferences;
}

function updatePreferences(directory: string, update: (current: Preferences) => Preferences) {
  const pending = preferenceWrites.then(async () => savePreferences(directory, update(await loadPreferences(directory))));
  preferenceWrites = pending.then(() => undefined, () => undefined);
  return pending;
}

export async function saveAppearance(directory: string, appearance: string): Promise<Preferences> {
  if (!appearances.includes(appearance as Appearance)) throw new Error("Unknown appearance preference");
  return updatePreferences(directory, (current) => ({ ...current, appearance: appearance as Appearance }));
}

export async function saveExpandThinking(directory: string, expandThinking: unknown): Promise<Preferences> {
  if (typeof expandThinking !== "boolean") throw new Error("Unknown thinking visibility preference");
  return updatePreferences(directory, (current) => ({ ...current, expandThinking }));
}

export async function saveGlobalRunCap(directory: string, limit: unknown): Promise<Preferences> {
  if (!Number.isInteger(limit) || (limit as number) < MINIMUM_GLOBAL_RUN_CAP || (limit as number) > MAXIMUM_GLOBAL_RUN_CAP) {
    throw new Error(`Active Run limit must be between ${MINIMUM_GLOBAL_RUN_CAP} and ${MAXIMUM_GLOBAL_RUN_CAP}`);
  }
  return updatePreferences(directory, (current) => ({ ...current, globalRunCap: limit as number }));
}

export async function saveNotificationPreferences(directory: string, value: unknown): Promise<Preferences> {
  if (!value || typeof value !== "object") throw new Error("Unknown notification preferences");
  const notifications = value as Partial<NotificationPreferences>;
  if (typeof notifications.runCompleted !== "boolean" || typeof notifications.runFailed !== "boolean" || typeof notifications.attentionRequired !== "boolean") {
    throw new Error("Unknown notification preferences");
  }
  return updatePreferences(directory, (current) => ({
    ...current,
    notifications: {
      runCompleted: notifications.runCompleted!,
      runFailed: notifications.runFailed!,
      attentionRequired: notifications.attentionRequired!,
    },
  }));
}

export async function savePanePreferences(directory: string, value: unknown): Promise<Preferences> {
  if (!value || typeof value !== "object") throw new Error("Unknown pane preferences");
  const panes = value as Partial<PanePreferences>;
  if (typeof panes.inspectorVisible !== "boolean"
    || !preferenceInspectorViews.includes(panes.inspectorView as PanePreferences["inspectorView"])
    || !isPaneWidth(panes.navigationWidth, MINIMUM_NAVIGATION_PANE_WIDTH, MAXIMUM_NAVIGATION_PANE_WIDTH)
    || !isPaneWidth(panes.inspectorWidth, MINIMUM_INSPECTOR_PANE_WIDTH, MAXIMUM_INSPECTOR_PANE_WIDTH)) {
    throw new Error("Unknown pane preferences");
  }
  return updatePreferences(directory, (current) => ({
    ...current,
    panes: {
      inspectorVisible: panes.inspectorVisible!,
      inspectorView: panes.inspectorView!,
      navigationWidth: panes.navigationWidth!,
      inspectorWidth: panes.inspectorWidth!,
    },
  }));
}

export async function saveRecentSelection(directory: string, projectPath: unknown, taskPath: unknown): Promise<Preferences> {
  if (projectPath !== undefined && (typeof projectPath !== "string" || !path.isAbsolute(projectPath))) throw new Error("Unknown recent Project selection");
  if (taskPath !== undefined && (typeof taskPath !== "string" || !path.isAbsolute(taskPath))) throw new Error("Unknown recent Task selection");
  if (taskPath !== undefined && projectPath === undefined) throw new Error("A recent Task must belong to a recent Project");
  return updatePreferences(directory, (current) => ({
    ...current,
    recentSelection: {
      ...(typeof projectPath === "string" ? { projectPath } : {}),
      ...(typeof taskPath === "string" ? { taskPath } : {}),
    },
  }));
}

export async function saveWindowPreference(directory: string, value: unknown): Promise<Preferences> {
  const window = savedWindow(value);
  if (!window) throw new Error("Unknown window geometry preference");
  return updatePreferences(directory, (current) => ({ ...current, window }));
}

export async function savePreferredApplication(directory: string, application: unknown): Promise<Preferences> {
  if (typeof application !== "string" || !applicationIds.has(application as ApplicationId)) throw new Error("Unknown application preference");
  return updatePreferences(directory, (current) => {
    const { preferredEditor: _legacy, ...preferences } = current;
    return { ...preferences, preferredApplication: application as ApplicationId };
  });
}

export async function savePreferredTerminal(directory: string, terminal: unknown): Promise<Preferences> {
  if (typeof terminal !== "string" || !terminalIds.has(terminal as TerminalId)) throw new Error("Unknown terminal preference");
  return updatePreferences(directory, (current) => ({ ...current, preferredTerminal: terminal as TerminalId }));
}
