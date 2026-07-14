export const desktopActions = [
  { id: "project.add", label: "Add Project…", menu: "File", accelerator: "CommandOrControl+O", keywords: "open folder" },
  { id: "task.new", label: "New Task", menu: "File", accelerator: "CommandOrControl+N", keywords: "create session" },
  { id: "task.exportJsonl", label: "Export Task as JSONL…", menu: "File", keywords: "save canonical session" },
  { id: "task.exportHtml", label: "Export Task as HTML…", menu: "File", keywords: "save readable session" },
  { id: "task.archive", label: "Archive Task", menu: "Task", keywords: "finish hide" },
  { id: "task.chooseModel", label: "Choose Model…", menu: "Task", keywords: "provider" },
  { id: "task.chooseThinking", label: "Choose Thinking Level…", menu: "Task", keywords: "reasoning" },
  { id: "resources.reload", label: "Reload Pi Resources", menu: "Task", accelerator: "CommandOrControl+Alt+R", keywords: "skills prompts context models settings" },
  { id: "run.compact", label: "Compact Context", menu: "Run", keywords: "summarize tokens" },
  { id: "run.stop", label: "Stop Run", menu: "Run", accelerator: "CommandOrControl+.", keywords: "abort cancel" },
  { id: "view.focusPrompt", label: "Focus Prompt", menu: "View", accelerator: "CommandOrControl+L", keywords: "composer input" },
  { id: "view.details", label: "Show Details", menu: "View", keywords: "inspector model usage cost" },
  { id: "view.settings", label: "Settings…", menu: "View", accelerator: "CommandOrControl+,", keywords: "preferences providers appearance" },
  { id: "view.commandPalette", label: "Open Command Palette", menu: "View", accelerator: "CommandOrControl+Shift+P", keywords: "actions commands" },
] as const;

export type DesktopAction = typeof desktopActions[number];
export type DesktopActionId = DesktopAction["id"];

export const desktopActionIds = new Set<DesktopActionId>(desktopActions.map(({ id }) => id));

export const builtInTuiCommands = new Set([
  "settings", "model", "scoped-models", "export", "import", "share", "copy", "name", "session",
  "changelog", "hotkeys", "fork", "clone", "tree", "trust", "login", "logout", "new", "compact",
  "resume", "reload", "quit", "debug", "arminsayshi", "dementedelves",
]);

export function builtInTuiCommand(input: string) {
  const match = input.trim().match(/^\/([\w-]+)(?:\s|$)/);
  return match && builtInTuiCommands.has(match[1]) ? match[1] : undefined;
}
