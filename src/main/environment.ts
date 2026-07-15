import { ProjectTrustStore, SettingsManager, type BashOperations } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import path from "node:path";

const maximumCaptureBytes = 4 * 1024 * 1024;
const captureTimeoutMs = 15_000;

export type CapturedShellEnvironment = {
  environment: NodeJS.ProcessEnv;
  shell?: string;
  error?: string;
};

export type PreparedShellRuntime = {
  environment: NodeJS.ProcessEnv;
  shellPath: string;
};

function environmentKey(environment: NodeJS.ProcessEnv, name: string, platform = process.platform) {
  return platform === "win32"
    ? Object.keys(environment).find((candidate) => candidate.toLocaleLowerCase() === name.toLocaleLowerCase())
    : Object.prototype.hasOwnProperty.call(environment, name) ? name : undefined;
}

export function environmentValue(environment: NodeJS.ProcessEnv, name: string, platform = process.platform) {
  const key = environmentKey(environment, name, platform);
  return key ? environment[key] : undefined;
}

function setEnvironmentValue(environment: NodeJS.ProcessEnv, name: string, value: string, platform = process.platform) {
  const existing = environmentKey(environment, name, platform);
  if (existing && existing !== name) delete environment[existing];
  environment[name] = value;
}

export function mergeEnvironments(...sources: NodeJS.ProcessEnv[]): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {};
  for (const source of sources) {
    for (const [name, value] of Object.entries(source)) {
      if (value !== undefined) setEnvironmentValue(merged, name, value);
    }
  }
  return merged;
}

function parseNullEnvironment(output: Buffer, start: string, end: string) {
  const startMarker = Buffer.from(`${start}\0`);
  const endMarker = Buffer.from(`${end}\0`);
  const beginning = output.indexOf(startMarker);
  const ending = beginning < 0 ? -1 : output.indexOf(endMarker, beginning + startMarker.length);
  if (beginning < 0 || ending < 0) throw new Error("The login shell did not return a readable environment");
  const environment: NodeJS.ProcessEnv = {};
  for (const entry of output.subarray(beginning + startMarker.length, ending).toString("utf8").split("\0")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const name = entry.slice(0, separator);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    setEnvironmentValue(environment, name, entry.slice(separator + 1));
  }
  return environment;
}

function parseLineValue(output: Buffer, start: string, end: string) {
  const text = output.toString("utf8");
  const beginning = text.indexOf(`${start}\n`);
  const ending = beginning < 0 ? -1 : text.indexOf(`\n${end}`, beginning + start.length + 1);
  return beginning < 0 || ending < 0 ? undefined : text.slice(beginning + start.length + 1, ending).replace(/\r/g, "");
}

function parseLineEnvironment(output: Buffer, start: string, end: string) {
  const text = output.toString("utf8");
  const beginning = text.indexOf(`${start}\n`);
  const ending = beginning < 0 ? -1 : text.indexOf(`\n${end}`, beginning + start.length + 1);
  if (beginning < 0 || ending < 0) return {};
  const environment: NodeJS.ProcessEnv = {};
  for (const raw of text.slice(beginning + start.length + 1, ending).split(/\r?\n/)) {
    const separator = raw.indexOf("=");
    if (separator <= 0) continue;
    const name = raw.slice(0, separator);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    setEnvironmentValue(environment, name, raw.slice(separator + 1), "win32");
  }
  return environment;
}

async function executable(file: string, platform = process.platform) {
  const details = await stat(file).catch(() => undefined);
  if (!details?.isFile()) return false;
  return access(file, platform === "win32" ? constants.F_OK : constants.X_OK).then(() => true, () => false);
}

function pathDirectories(environment: NodeJS.ProcessEnv, platform = process.platform) {
  const value = environmentValue(environment, "PATH", platform) ?? "";
  const delimiter = platform === "win32" ? ";" : ":";
  return value.split(delimiter).map((entry) => entry.trim().replace(/^"|"$/g, "")).filter(Boolean);
}

async function executableOnPath(command: string, environment: NodeJS.ProcessEnv, platform = process.platform) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  for (const directory of pathDirectories(environment, platform)) {
    const candidate = pathApi.join(directory, command);
    if (await executable(candidate, platform)) return candidate;
  }
}

function legacyWslBash(file: string) {
  return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/i.test(file.replace(/\//g, "\\"));
}

export async function resolveBashShell(
  environment: NodeJS.ProcessEnv,
  configuredShellPath?: string,
  settingsPath = "settings.json",
  platform = process.platform,
): Promise<{ shell: string; commandTransport?: "stdin" }> {
  if (configuredShellPath) {
    if (await executable(configuredShellPath, platform)) {
      return { shell: configuredShellPath, ...(platform === "win32" && legacyWslBash(configuredShellPath) ? { commandTransport: "stdin" as const } : {}) };
    }
    const windowsHelp = platform === "win32"
      ? " Install Git for Windows from https://git-scm.com/download/win, add bash.exe to PATH, or choose another Windows shell path."
      : "";
    throw new Error(`The configured Pi shell was not found at ${configuredShellPath}. Update shellPath in ${settingsPath} before starting a Run.${windowsHelp}`);
  }

  if (platform === "win32") {
    const candidates = [
      environmentValue(environment, "ProgramFiles", platform),
      environmentValue(environment, "ProgramFiles(x86)", platform),
    ].filter((directory): directory is string => Boolean(directory))
      .map((directory) => path.win32.join(directory, "Git", "bin", "bash.exe"));
    for (const candidate of candidates) if (await executable(candidate, platform)) return { shell: candidate };
    const discovered = await executableOnPath("bash.exe", environment, platform);
    if (discovered) return { shell: discovered, ...(legacyWslBash(discovered) ? { commandTransport: "stdin" as const } : {}) };
    throw new Error(`Bash is required before starting a Run on Windows. Install Git for Windows from https://git-scm.com/download/win, add bash.exe to PATH, or set shellPath in ${settingsPath}.`);
  }

  if (await executable("/bin/bash", platform)) return { shell: "/bin/bash" };
  const bash = await executableOnPath("bash", environment, platform);
  if (bash) return { shell: bash };
  if (await executable("/bin/sh", platform)) return { shell: "/bin/sh" };
  const shell = await executableOnPath("sh", environment, platform);
  if (shell) return { shell };
  throw new Error("No compatible shell was found. Install Bash or make sh available on PATH before starting a Run.");
}

function killProcessTree(pid: number) {
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { detached: true, stdio: "ignore", windowsHide: true });
    killer.unref();
    return;
  }
  try { process.kill(-pid, "SIGKILL"); }
  catch {
    try { process.kill(pid, "SIGKILL"); } catch { /* Process already exited. */ }
  }
}

async function runLoginShell(shell: { shell: string; commandTransport?: "stdin" }, environment: NodeJS.ProcessEnv) {
  const token = randomBytes(12).toString("hex");
  const rawStart = `__PILOT_ENV_${token}_RAW_START__`;
  const rawEnd = `__PILOT_ENV_${token}_RAW_END__`;
  const hostStart = `__PILOT_ENV_${token}_HOST_START__`;
  const hostEnd = `__PILOT_ENV_${token}_HOST_END__`;
  const pathStart = `__PILOT_ENV_${token}_PATH_START__`;
  const pathEnd = `__PILOT_ENV_${token}_PATH_END__`;
  const hostCapture = process.platform === "win32"
    ? `printf '${hostStart}\\n'; if command -v cmd.exe >/dev/null 2>&1; then cmd.exe /d /s /c 'chcp 65001>nul & set'; fi; printf '\\n${hostEnd}\\n${pathStart}\\n'; if command -v cygpath >/dev/null 2>&1; then cygpath -wp "$PATH"; fi; printf '\\n${pathEnd}\\n';`
    : "";
  const command = `printf '${rawStart}\\0'; command env -0; printf '${rawEnd}\\0'; ${hostCapture}`;
  const args = shell.commandTransport ? ["-i", "-l", "-s"] : ["-i", "-l", "-c", command];
  const cwd = environmentValue(environment, "HOME") || homedir();
  const output = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(shell.shell, args, {
      cwd,
      env: environment,
      detached: process.platform !== "win32",
      stdio: [shell.commandTransport ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let size = 0;
    let failure = "";
    const timeout = setTimeout(() => {
      failure = "Timed out while reading the login-shell environment";
      if (child.pid) killProcessTree(child.pid);
    }, captureTimeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maximumCaptureBytes) {
        failure = "The login-shell environment exceeded 4 MB";
        if (child.pid) killProcessTree(child.pid);
        return;
      }
      chunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (errors.reduce((total, value) => total + value.length, 0) < 16_384) errors.push(chunk);
    });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (failure) { reject(new Error(failure)); return; }
      const combined = Buffer.concat(chunks);
      if (code !== 0 && combined.indexOf(Buffer.from(`${rawStart}\0`)) < 0) {
        const detail = Buffer.concat(errors).toString("utf8").trim();
        reject(new Error(detail || `Login shell exited with code ${code ?? "unknown"}`));
        return;
      }
      resolve(combined);
    });
    if (shell.commandTransport) child.stdin?.end(command);
  });
  const shellEnvironment = parseNullEnvironment(output, rawStart, rawEnd);
  if (process.platform !== "win32") return shellEnvironment;
  const hostEnvironment = parseLineEnvironment(output, hostStart, hostEnd);
  const capturedEnvironment = mergeEnvironments(hostEnvironment, shellEnvironment);
  const nativePath = parseLineValue(output, pathStart, pathEnd)?.trim() || environmentValue(hostEnvironment, "PATH", "win32");
  if (nativePath) setEnvironmentValue(capturedEnvironment, "PATH", nativePath, "win32");
  return capturedEnvironment;
}

export async function captureLoginShellEnvironment(
  launchEnvironment: NodeJS.ProcessEnv,
  configuredWindowsShell?: string,
): Promise<CapturedShellEnvironment> {
  let shell: { shell: string; commandTransport?: "stdin" } | undefined;
  try {
    if (process.platform === "win32") {
      shell = await resolveBashShell(launchEnvironment, configuredWindowsShell);
    } else {
      const candidate = environmentValue(launchEnvironment, "SHELL") || userInfo().shell || undefined;
      shell = candidate && await executable(candidate) ? { shell: candidate } : await resolveBashShell(launchEnvironment);
    }
    return { environment: await runLoginShell(shell, launchEnvironment), shell: shell.shell };
  } catch (error) {
    return {
      environment: mergeEnvironments(launchEnvironment),
      ...(shell ? { shell: shell.shell } : {}),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function installCapturedEnvironment(captured: CapturedShellEnvironment, launchEnvironment: NodeJS.ProcessEnv) {
  const protectedEnvironment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(launchEnvironment)) {
    if (value !== undefined && (name.startsWith("PILOT_") || name === "PI_CODING_AGENT_DIR" || name === "ELECTRON_RUN_AS_NODE")) {
      setEnvironmentValue(protectedEnvironment, name, value);
    }
  }
  const installed = mergeEnvironments(captured.environment, protectedEnvironment);
  for (const name of Object.keys(process.env)) {
    const replacement = environmentKey(installed, name);
    if (!replacement || replacement !== name) delete process.env[name];
  }
  for (const [name, value] of Object.entries(installed)) if (value !== undefined) process.env[name] = value;
  return installed;
}

export function projectEnvironment(base: NodeJS.ProcessEnv, overrides: Record<string, string>, agentDir: string) {
  const environment = mergeEnvironments(base, overrides);
  const pathKey = environmentKey(environment, "PATH") ?? "PATH";
  const delimiter = process.platform === "win32" ? ";" : ":";
  const binDirectory = path.join(agentDir, "bin");
  const entries = (environment[pathKey] ?? "").split(delimiter).filter(Boolean);
  const includesBin = entries.some((entry) => process.platform === "win32"
    ? entry.toLocaleLowerCase() === binDirectory.toLocaleLowerCase()
    : entry === binDirectory);
  if (!includesBin) setEnvironmentValue(environment, pathKey, [binDirectory, ...entries].join(delimiter));
  return environment;
}

export async function prepareShellRuntime(
  agentDir: string,
  executionPath: string,
  settings: SettingsManager,
  environment: NodeJS.ProcessEnv,
): Promise<PreparedShellRuntime> {
  const projectConfigured = typeof settings.getProjectSettings().shellPath === "string";
  const settingsPath = projectConfigured
    ? path.join(executionPath, ".pi", "settings.json")
    : path.join(agentDir, "settings.json");
  const shell = await resolveBashShell(environment, settings.getShellPath(), settingsPath);
  return { environment, shellPath: shell.shell };
}

export async function prepareProjectShellRuntime(
  agentDir: string,
  projectPath: string,
  executionPath: string,
  environmentForProject: (projectPath: string) => Promise<NodeJS.ProcessEnv>,
) {
  const trusted = new ProjectTrustStore(agentDir).getEntry(projectPath)?.decision === true;
  const settings = SettingsManager.create(executionPath, agentDir, { projectTrusted: trusted });
  const errors = settings.drainErrors();
  if (errors.length) {
    const first = errors[0];
    const settingsPath = first.scope === "global" ? path.join(agentDir, "settings.json") : path.join(executionPath, ".pi", "settings.json");
    throw new Error(`Pi ${first.scope} settings could not be read from ${settingsPath}: ${first.error.message}`);
  }
  const runtime = await prepareShellRuntime(agentDir, executionPath, settings, await environmentForProject(projectPath));
  return { runtime, settings };
}

export function withBashEnvironment(operations: BashOperations, environment: NodeJS.ProcessEnv): BashOperations {
  return {
    exec: (command, cwd, options) => operations.exec(command, cwd, { ...options, env: environment }),
  };
}
