import { ProjectTrustStore, SettingsManager } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { shell } from "electron";
import { configuredEditorId, editorDefinitions, fileManagerId, terminalDefinitions, terminalIds, type ApplicationId, type ApplicationState, type TerminalId, type TerminalState } from "../shared/editors.js";
import { environmentValue } from "./environment.js";

export type ConfiguredEditor = { command: string; label: string; baseDirectory?: string };
type ResolvedApplication = { id: ApplicationId; label: string; command: string; args: string[]; fileManager?: boolean };
const terminalEditorCommands = new Set(["emacs", "helix", "hx", "micro", "nano", "nvim", "pico", "vi", "vim"]);

let editorCache: { expiresAt: number; editors: ResolvedApplication[]; environmentKey: string } | undefined;

async function isExecutableFile(file: string, environment: NodeJS.ProcessEnv = process.env) {
  const details = await stat(file).catch(() => undefined);
  if (!details?.isFile()) return false;
  if (process.platform === "win32") {
    const extensions = (environmentValue(environment, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").toLocaleLowerCase().split(";");
    if (!extensions.includes(path.extname(file).toLocaleLowerCase())) return false;
  }
  return access(file, process.platform === "win32" ? constants.F_OK : constants.X_OK).then(() => true, () => false);
}

async function isApplicationBundle(file: string) {
  return stat(file).then((details) => details.isDirectory(), () => false);
}

async function findExecutable(command: string, baseDirectory?: string, environment: NodeJS.ProcessEnv = process.env) {
  const extensions = process.platform === "win32"
    ? (environmentValue(environment, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
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
      if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && await isExecutableFile(executable, environment)) return executable;
    }
    return;
  }
  if (path.isAbsolute(command)) {
    for (const candidate of candidates) if (await isExecutableFile(candidate, environment)) return candidate;
    return;
  }
  const directories = (environmentValue(environment, "PATH") ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter((entry) => path.isAbsolute(entry));
  for (const directory of directories) {
    for (const candidate of candidates) {
      const target = path.join(directory, candidate);
      if (await isExecutableFile(target, environment)) return target;
    }
  }
}

function windowsEnvironment(name: string, environment: NodeJS.ProcessEnv = process.env) {
  return environmentValue(environment, name, "win32");
}

async function findWindowsApplication(definition: typeof editorDefinitions[number], environment: NodeJS.ProcessEnv) {
  if ("windowsPaths" in definition) {
    for (const template of definition.windowsPaths) {
      const expanded = template.replace(/^%([^%]+)%/, (_match, name: string) => windowsEnvironment(name, environment) ?? "");
      if (path.isAbsolute(expanded) && await isExecutableFile(expanded, environment)) return expanded;
    }
  }
  if (!("windowsDirectory" in definition)) return;
  const localPrograms = windowsEnvironment("LOCALAPPDATA", environment) && path.join(windowsEnvironment("LOCALAPPDATA", environment)!, "Programs");
  const roots = [windowsEnvironment("ProgramFiles", environment) && path.join(windowsEnvironment("ProgramFiles", environment)!, "JetBrains"), localPrograms && path.join(localPrograms, "JetBrains"), localPrograms]
    .filter((root): root is string => Boolean(root));
  for (const root of roots) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const installations = entries.filter((entry) => entry.isDirectory() && entry.name.toLocaleLowerCase().startsWith(definition.windowsDirectory.toLocaleLowerCase())).sort((left, right) => right.name.localeCompare(left.name));
    for (const installation of installations) {
      const executable = path.join(root, installation.name, "bin", definition.windowsExecutable);
      if (await isExecutableFile(executable, environment)) return executable;
    }
  }
}

async function resolveEditor(definition: typeof editorDefinitions[number], environment: NodeJS.ProcessEnv): Promise<ResolvedApplication | undefined> {
  for (const command of definition.commands) {
    const executable = await findExecutable(command, undefined, environment);
    if (executable) return { id: definition.id, label: definition.label, command: executable, args: "baseArgs" in definition ? [...definition.baseArgs] : [] };
  }
  if (process.platform === "darwin" && "macApplications" in definition) {
    for (const application of definition.macApplications) {
      const installed = await isApplicationBundle(`/Applications/${application}.app`) || await isApplicationBundle(path.join(homedir(), "Applications", `${application}.app`));
      if (installed) return { id: definition.id, label: definition.label, command: "/usr/bin/open", args: ["-a", application] };
    }
  }
  if (process.platform === "win32") {
    const executable = await findWindowsApplication(definition, environment);
    if (executable) return { id: definition.id, label: definition.label, command: executable, args: [] };
  }
}

async function staticEditors(environment: NodeJS.ProcessEnv) {
  const environmentKey = ["PATH", "PATHEXT", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"]
    .map((name) => environmentValue(environment, name) ?? "").join("\0");
  if (editorCache && editorCache.expiresAt > Date.now() && editorCache.environmentKey === environmentKey) return editorCache.editors;
  const editors = (await Promise.all(editorDefinitions.map((definition) => resolveEditor(definition, environment)))).filter((editor): editor is ResolvedApplication => Boolean(editor));
  editorCache = { expiresAt: Date.now() + 5_000, editors, environmentKey };
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
  const [command, ...args] = parts;
  const name = path.basename(command ?? "").replace(/\.exe$/i, "");
  const normalized = name.toLocaleLowerCase();
  if (normalized === "emacs" && !args.some((argument) => ["-nw", "--no-window-system", "-t", "--terminal"].includes(argument))) return;
  if (["vi", "vim", "nvim"].includes(normalized)
    && (args.includes("-g") || args.some((argument) => argument === "--server" || argument.startsWith("--remote")))) return;
  return terminalEditorCommands.has(normalized) ? name : undefined;
}

async function resolveConfiguredEditor(configured: ConfiguredEditor | undefined, environment: NodeJS.ProcessEnv): Promise<ResolvedApplication | undefined> {
  if (!configured?.command.trim() || terminalEditorName(configured)) return;
  let parts: string[];
  try { parts = editorCommandParts(configured.command); } catch { return; }
  const [command, ...args] = parts;
  if (!command) return;
  const executable = await findExecutable(command, configured.baseDirectory, environment);
  if (!executable) return;
  return { id: configuredEditorId, label: configured.label, command: executable, args } satisfies ResolvedApplication;
}

function fileManager(): ResolvedApplication {
  const label = process.platform === "darwin" ? "Finder" : process.platform === "win32" ? "File Explorer" : "Files";
  return { id: fileManagerId, label, command: "", args: [], fileManager: true };
}

async function resolvedApplications(configured?: ConfiguredEditor, environment: NodeJS.ProcessEnv = process.env) {
  const [known, custom] = await Promise.all([staticEditors(environment), resolveConfiguredEditor(configured, environment)]);
  return [...(custom ? [custom, ...known] : known), fileManager()];
}

export function getConfiguredEditor(agentDir: string, executionPath: string, projectPath = executionPath, environment: NodeJS.ProcessEnv = process.env): ConfiguredEditor | undefined {
  const trusted = new ProjectTrustStore(agentDir).getEntry(projectPath)?.decision === true;
  const settings = SettingsManager.create(executionPath, agentDir, { projectTrusted: trusted });
  const projectCommand = settings.getProjectSettings().externalEditor;
  if (projectCommand?.trim()) return { command: projectCommand, label: "Pi configured editor", baseDirectory: executionPath };
  const command = settings.getGlobalSettings().externalEditor;
  if (command?.trim()) return { command, label: "Pi configured editor" };
  const visual = environmentValue(environment, "VISUAL");
  if (visual?.trim()) return { command: visual, label: "Environment editor" };
  const editor = environmentValue(environment, "EDITOR");
  if (editor?.trim()) return { command: editor, label: "Environment editor" };
}

export async function getApplicationState(preferred?: ApplicationId, configured?: ConfiguredEditor, environment: NodeJS.ProcessEnv = process.env): Promise<ApplicationState> {
  const applications = await resolvedApplications(configured, environment);
  const effective = preferred && applications.some(({ id }) => id === preferred) ? preferred : applications[0]?.id;
  const terminalEditor = terminalEditorName(configured);
  const configuredAvailable = applications.some(({ id }) => id === configuredEditorId);
  const notice = terminalEditor
    ? `${terminalEditor} needs an attached terminal, so choose a GUI editor here or open it from Pi.`
    : configured && !configuredAvailable ? `${configured.label} could not be found. Use an absolute executable path or a command available on PATH.` : undefined;
  return {
    available: applications.map(({ id, label, fileManager }) => ({ id, label, kind: fileManager ? "file-manager" as const : "editor" as const })),
    ...(effective ? { preferred: effective } : {}),
    ...(preferred ? { storedPreferred: preferred } : {}),
    ...(notice ? { notice } : {}),
  };
}

function launchDetached(command: string, args: string[], cwd: string, env = process.env, windowsHide = true) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, detached: true, env, shell: false, stdio: "ignore", windowsHide });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

async function launchWindowsScript(command: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv = process.env) {
  const env: NodeJS.ProcessEnv = { ...environment, PILOT_EDITOR_COMMAND: command };
  const references = args.map((argument, index) => {
    const name = `PILOT_EDITOR_ARG_${index}`;
    env[name] = argument;
    return `"%${name}%"`;
  });
  const invocation = `""%PILOT_EDITOR_COMMAND%" ${references.join(" ")}"`;
  await launchDetached(environmentValue(environment, "ComSpec") || "cmd.exe", ["/d", "/s", "/v:off", "/c", invocation], cwd, env);
}

type ResolvedTerminal = { id: TerminalId; label: string; command: string; args: string[]; env?: NodeJS.ProcessEnv; windowsHide?: boolean };

function terminalLabel(id: TerminalId) {
  return terminalDefinitions.find((terminal) => terminal.id === id)!.label;
}

async function resolveTerminal(id: TerminalId, cwd: string, environment: NodeJS.ProcessEnv = process.env): Promise<ResolvedTerminal | undefined> {
  const testId = environmentValue(environment, "PILOT_TEST_TERMINAL_ID");
  const testCommand = environmentValue(environment, "PILOT_TEST_PROJECT_DIR") && environmentValue(environment, "PILOT_TEST_TERMINAL_COMMAND");
  if (testCommand && testId === id && terminalIds.has(id)) return { id, label: terminalLabel(id), command: testCommand, args: [] };
  if (id === "system") return;

  if (process.platform === "darwin") {
    const applications: Partial<Record<TerminalId, string>> = {
      iterm: "iTerm", warp: "Warp", ghostty: "Ghostty", kitty: "kitty", wezterm: "WezTerm", alacritty: "Alacritty",
    };
    const application = applications[id];
    if (!application || !await isApplicationBundle(`/Applications/${application}.app`) && !await isApplicationBundle(path.join(homedir(), "Applications", `${application}.app`))) return;
    return { id, label: terminalLabel(id), command: "/usr/bin/open", args: ["-a", application, cwd] };
  }

  if (process.platform === "win32") {
    if (id === "windows-terminal") {
      const command = await findExecutable("wt.exe", undefined, environment);
      if (command) return { id, label: terminalLabel(id), command, args: ["-d", cwd] };
    }
    if (id === "powershell") {
      const command = await findExecutable("powershell.exe", undefined, environment);
      if (command) return {
        id,
        label: terminalLabel(id),
        command,
        args: ["-NoExit", "-Command", "Set-Location -LiteralPath $env:PILOT_TERMINAL_CWD"],
        env: { ...environment, PILOT_TERMINAL_CWD: cwd },
        windowsHide: false,
      };
    }
    return;
  }

  const commands: Partial<Record<TerminalId, { command: string; args: string[] }>> = {
    "gnome-terminal": { command: "gnome-terminal", args: [`--working-directory=${cwd}`] },
    konsole: { command: "konsole", args: ["--workdir", cwd] },
    kitty: { command: "kitty", args: ["--directory", cwd] },
    wezterm: { command: "wezterm", args: ["start", "--cwd", cwd] },
    alacritty: { command: "alacritty", args: ["--working-directory", cwd] },
  };
  const candidate = commands[id];
  if (!candidate) return;
  const command = await findExecutable(candidate.command, undefined, environment);
  return command ? { id, label: terminalLabel(id), command, args: candidate.args } : undefined;
}

export async function getTerminalState(preferred: TerminalId = "system", environment: NodeJS.ProcessEnv = process.env): Promise<TerminalState> {
  const systemLabel = process.platform === "darwin" ? "System default (Terminal)" : process.platform === "win32" ? "System default (Windows Terminal)" : "System default";
  const detected = (await Promise.all(terminalDefinitions.filter(({ id }) => id !== "system").map(({ id }) => resolveTerminal(id, homedir(), environment))))
    .filter((terminal): terminal is ResolvedTerminal => Boolean(terminal));
  const available = [{ id: "system" as const, label: systemLabel }, ...detected.map(({ id, label }) => ({ id, label }))];
  const effective = available.some(({ id }) => id === preferred) ? preferred : "system";
  return {
    available,
    preferred: effective,
    storedPreferred: preferred,
    ...(effective !== preferred ? { notice: `${terminalLabel(preferred)} is not available. PiLot will use ${systemLabel}.` } : {}),
  };
}

export async function launchTerminal(cwd: string, terminal: TerminalId = "system", environment: NodeJS.ProcessEnv = process.env) {
  const resolved = terminal === "system" ? undefined : await resolveTerminal(terminal, cwd, environment);
  const effective = resolved ? terminal : "system";
  const testCommand = environmentValue(environment, "PILOT_TEST_PROJECT_DIR") && environmentValue(environment, "PILOT_TEST_TERMINAL_COMMAND");
  if (testCommand) {
    const expected = environmentValue(environment, "PILOT_TEST_TERMINAL_ID");
    if (expected && effective !== expected) throw new Error(`Expected terminal ${expected}, received ${effective}`);
    if (process.platform === "win32" && /\.(?:bat|cmd)$/i.test(testCommand)) return launchWindowsScript(testCommand, [], cwd, environment);
    return launchDetached(testCommand, [], cwd, environment);
  }
  if (resolved) return launchDetached(resolved.command, resolved.args, cwd, resolved.env ?? environment, resolved.windowsHide);
  if (process.platform === "darwin") return launchDetached("/usr/bin/open", ["-a", "Terminal", cwd], cwd, environment);
  if (process.platform === "win32") {
    try { return await launchDetached("wt.exe", ["-d", cwd], cwd, environment); }
    catch {
      return launchDetached("powershell.exe", ["-NoExit", "-Command", "Set-Location -LiteralPath $env:PILOT_TERMINAL_CWD"], cwd, {
        ...environment,
        PILOT_TERMINAL_CWD: cwd,
      }, false);
    }
  }
  for (const command of ["x-terminal-emulator", "gnome-terminal", "konsole"]) {
    try { return await launchDetached(command, [], cwd, environment); } catch { /* try the next installed terminal */ }
  }
  throw new Error("No supported terminal application was found");
}

export async function launchApplication(application: ApplicationId, target: string, cwd: string, configured?: ConfiguredEditor, environment: NodeJS.ProcessEnv = process.env) {
  const resolved = (await resolvedApplications(configured, environment)).find(({ id }) => id === application);
  if (!resolved) throw new Error(`${editorDefinitions.find(({ id }) => id === application)?.label ?? configured?.label ?? application} is not available on this computer`);
  const args = [...resolved.args, target];
  try {
    if (resolved.fileManager) {
      if ((await lstat(target)).isDirectory()) {
        const error = await shell.openPath(target);
        if (error) throw new Error(error);
      } else shell.showItemInFolder(target);
    } else if (process.platform === "win32" && /\.(?:bat|cmd)$/i.test(resolved.command)) await launchWindowsScript(resolved.command, args, cwd, environment);
    else await launchDetached(resolved.command, args, cwd, environment);
  } catch (reason) {
    throw new Error(`Could not open ${target} in ${resolved.label}: ${reason instanceof Error ? reason.message : String(reason)}`);
  }
}
