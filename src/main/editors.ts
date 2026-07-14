import { ProjectTrustStore, SettingsManager } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { configuredEditorId, editorDefinitions, fileManagerId, type EditorId, type EditorState } from "../shared/editors.js";

export type ConfiguredEditor = { command: string; label: string; baseDirectory?: string };
type ResolvedEditor = { id: EditorId; label: string; command: string; args: string[]; fileManager?: boolean };
const terminalEditorCommands = new Set(["emacs", "helix", "hx", "micro", "nano", "nvim", "pico", "vi", "vim"]);

let editorCache: { expiresAt: number; editors: ResolvedEditor[] } | undefined;

async function isExecutableFile(file: string) {
  const details = await stat(file).catch(() => undefined);
  if (!details?.isFile()) return false;
  if (process.platform === "win32") {
    const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").toLocaleLowerCase().split(";");
    if (!extensions.includes(path.extname(file).toLocaleLowerCase())) return false;
  }
  return access(file, process.platform === "win32" ? constants.F_OK : constants.X_OK).then(() => true, () => false);
}

async function isApplicationBundle(file: string) {
  return stat(file).then((details) => details.isDirectory(), () => false);
}

async function findExecutable(command: string, baseDirectory?: string) {
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const candidates = path.extname(command) ? [command] : extensions.map((extension) => `${command}${extension.toLocaleLowerCase()}`);
  if (/[\\/]/.test(command) && !path.isAbsolute(command)) {
    if (!baseDirectory) return;
    const root = await realpath(baseDirectory).catch(() => undefined);
    if (!root) return;
    for (const candidate of candidates) {
      const executable = await realpath(path.resolve(root, candidate)).catch(() => undefined);
      if (!executable) continue;
      const relative = path.relative(root, executable);
      if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && await isExecutableFile(executable)) return executable;
    }
    return;
  }
  if (path.isAbsolute(command)) {
    for (const candidate of candidates) if (await isExecutableFile(candidate)) return candidate;
    return;
  }
  const directories = (process.env.PATH ?? process.env.Path ?? process.env.path ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter((entry) => path.isAbsolute(entry));
  for (const directory of directories) {
    for (const candidate of candidates) {
      const target = path.join(directory, candidate);
      if (await isExecutableFile(target)) return target;
    }
  }
}

function windowsEnvironment(name: string) {
  const key = Object.keys(process.env).find((candidate) => candidate.toLocaleLowerCase() === name.toLocaleLowerCase());
  return key ? process.env[key] : undefined;
}

async function findWindowsApplication(definition: typeof editorDefinitions[number]) {
  if ("windowsPaths" in definition) {
    for (const template of definition.windowsPaths) {
      const expanded = template.replace(/^%([^%]+)%/, (_match, name: string) => windowsEnvironment(name) ?? "");
      if (path.isAbsolute(expanded) && await isExecutableFile(expanded)) return expanded;
    }
  }
  if (!("windowsDirectory" in definition)) return;
  const localPrograms = windowsEnvironment("LOCALAPPDATA") && path.join(windowsEnvironment("LOCALAPPDATA")!, "Programs");
  const roots = [windowsEnvironment("ProgramFiles") && path.join(windowsEnvironment("ProgramFiles")!, "JetBrains"), localPrograms && path.join(localPrograms, "JetBrains"), localPrograms]
    .filter((root): root is string => Boolean(root));
  for (const root of roots) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const installations = entries.filter((entry) => entry.isDirectory() && entry.name.toLocaleLowerCase().startsWith(definition.windowsDirectory.toLocaleLowerCase())).sort((left, right) => right.name.localeCompare(left.name));
    for (const installation of installations) {
      const executable = path.join(root, installation.name, "bin", definition.windowsExecutable);
      if (await isExecutableFile(executable)) return executable;
    }
  }
}

async function resolveEditor(definition: typeof editorDefinitions[number]): Promise<ResolvedEditor | undefined> {
  for (const command of definition.commands) {
    const executable = await findExecutable(command);
    if (executable) return { id: definition.id, label: definition.label, command: executable, args: "baseArgs" in definition ? [...definition.baseArgs] : [] };
  }
  if (process.platform === "darwin" && "macApplications" in definition) {
    for (const application of definition.macApplications) {
      const installed = await isApplicationBundle(`/Applications/${application}.app`) || await isApplicationBundle(path.join(homedir(), "Applications", `${application}.app`));
      if (installed) return { id: definition.id, label: definition.label, command: "/usr/bin/open", args: ["-a", application] };
    }
  }
  if (process.platform === "win32") {
    const executable = await findWindowsApplication(definition);
    if (executable) return { id: definition.id, label: definition.label, command: executable, args: [] };
  }
}

async function staticEditors() {
  if (editorCache && editorCache.expiresAt > Date.now()) return editorCache.editors;
  const editors = (await Promise.all(editorDefinitions.map(resolveEditor))).filter((editor): editor is ResolvedEditor => Boolean(editor));
  editorCache = { expiresAt: Date.now() + 5_000, editors };
  return editors;
}

function editorCommandParts(command: string) {
  const parts: string[] = [];
  let current = "";
  let quote = "";
  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (quote) {
      if (character === quote) quote = "";
      else if (quote === '"' && character === "\\" && command[index + 1] === '"') { current += '"'; index += 1; }
      else current += character;
    } else if (character === '"' || character === "'") quote = character;
    else if (/\s/.test(character)) { if (current) { parts.push(current); current = ""; } }
    else if (character === "\\" && process.platform !== "win32" && command[index + 1] && /[\s\\"']/.test(command[index + 1])) current += command[++index];
    else current += character;
  }
  if (quote) throw new Error("The configured external editor has an unmatched quote");
  if (current) parts.push(current);
  return parts;
}

function terminalEditorName(configured?: ConfiguredEditor) {
  if (!configured?.command.trim()) return;
  let parts: string[];
  try { parts = editorCommandParts(configured.command); } catch { return; }
  const name = path.basename(parts[0] ?? "").replace(/\.exe$/i, "");
  return terminalEditorCommands.has(name.toLocaleLowerCase()) ? name : undefined;
}

async function resolveConfiguredEditor(configured?: ConfiguredEditor): Promise<ResolvedEditor | undefined> {
  if (!configured?.command.trim() || terminalEditorName(configured)) return;
  let parts: string[];
  try { parts = editorCommandParts(configured.command); } catch { return; }
  const [command, ...args] = parts;
  if (!command) return;
  const executable = await findExecutable(command, configured.baseDirectory);
  if (!executable) return;
  return { id: configuredEditorId, label: configured.label, command: executable, args } satisfies ResolvedEditor;
}

async function resolveFileManager(): Promise<ResolvedEditor | undefined> {
  if (process.platform === "win32") {
    const executable = await findExecutable("explorer") ?? (windowsEnvironment("SystemRoot") ? path.join(windowsEnvironment("SystemRoot")!, "explorer.exe") : undefined);
    if (executable && await isExecutableFile(executable)) return { id: fileManagerId, label: "File Explorer", command: executable, args: [], fileManager: true };
  }
  if (process.platform === "darwin") return { id: fileManagerId, label: "Finder", command: "/usr/bin/open", args: [], fileManager: true };
  const executable = await findExecutable("xdg-open");
  if (executable) return { id: fileManagerId, label: "Files", command: executable, args: [], fileManager: true };
}

async function resolvedEditors(configured?: ConfiguredEditor) {
  const [known, custom, fileManager] = await Promise.all([staticEditors(), resolveConfiguredEditor(configured), resolveFileManager()]);
  const editors = custom ? [custom, ...known] : known;
  return [...editors, ...(fileManager ? [fileManager] : [])];
}

export function getConfiguredEditor(agentDir: string, executionPath: string): ConfiguredEditor | undefined {
  const trusted = new ProjectTrustStore(agentDir).getEntry(executionPath)?.decision === true;
  const settings = SettingsManager.create(executionPath, agentDir, { projectTrusted: trusted });
  const projectCommand = settings.getProjectSettings().externalEditor;
  if (projectCommand?.trim()) return { command: projectCommand, label: "Pi configured editor", baseDirectory: executionPath };
  const command = settings.getGlobalSettings().externalEditor;
  if (command?.trim()) return { command, label: "Pi configured editor" };
  if (process.env.VISUAL?.trim()) return { command: process.env.VISUAL, label: "Environment editor" };
  if (process.env.EDITOR?.trim()) return { command: process.env.EDITOR, label: "Environment editor" };
}

export async function getEditorState(preferred?: EditorId, configured?: ConfiguredEditor): Promise<EditorState> {
  const editors = await resolvedEditors(configured);
  const effective = preferred && editors.some(({ id }) => id === preferred) ? preferred : editors[0]?.id;
  const terminalEditor = terminalEditorName(configured);
  const configuredAvailable = editors.some(({ id }) => id === configuredEditorId);
  const notice = terminalEditor
    ? `${terminalEditor} needs an attached terminal, so choose a GUI editor here or open it from Pi.`
    : configured && !configuredAvailable ? `${configured.label} could not be found. Use an absolute executable path or a command available on PATH.` : undefined;
  return {
    available: editors.map(({ id, label, fileManager }) => ({ id, label, kind: fileManager ? "file-manager" as const : "editor" as const })),
    ...(effective ? { preferred: effective } : {}),
    ...(preferred ? { storedPreferred: preferred } : {}),
    ...(notice ? { notice } : {}),
  };
}

function launchDetached(command: string, args: string[], cwd: string, env = process.env) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, detached: true, env, shell: false, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

async function launchWindowsScript(command: string, args: string[], cwd: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, PILOT_EDITOR_COMMAND: command };
  const references = args.map((argument, index) => {
    const name = `PILOT_EDITOR_ARG_${index}`;
    env[name] = argument;
    return `"%${name}%"`;
  });
  const invocation = `""%PILOT_EDITOR_COMMAND%" ${references.join(" ")}"`;
  await launchDetached(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/v:off", "/c", invocation], cwd, env);
}

export async function launchEditor(editor: EditorId, target: string, cwd: string, configured?: ConfiguredEditor) {
  const resolved = (await resolvedEditors(configured)).find(({ id }) => id === editor);
  if (!resolved) throw new Error(`${editorDefinitions.find(({ id }) => id === editor)?.label ?? configured?.label ?? editor} is not available on this computer`);
  const directory = resolved.fileManager && (await lstat(target)).isDirectory();
  const args = resolved.fileManager
    ? process.platform === "darwin" ? directory ? [target] : ["-R", target]
      : process.platform === "win32" ? directory ? [target] : ["/select,", target]
        : [directory ? target : path.dirname(target)]
    : [...resolved.args, target];
  try {
    if (process.platform === "win32" && /\.(?:bat|cmd)$/i.test(resolved.command)) await launchWindowsScript(resolved.command, args, cwd);
    else await launchDetached(resolved.command, args, cwd);
  } catch (reason) {
    throw new Error(`Could not open ${target} in ${resolved.label}: ${reason instanceof Error ? reason.message : String(reason)}`);
  }
}
