import { appendFile, chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DiagnosticBundle, DiagnosticCategory, DiagnosticEvent, DiagnosticOperation, DiagnosticSeverity } from "../shared/diagnostics.js";

const maximumLogBytes = 64 * 1024;
const maximumLogFiles = 3;
const currentLogName = "pilot-diagnostics.jsonl";

const operationDefinitions = {
  "app.start": {
    category: "packaging", severity: "info", summary: "PiLot started.",
    guidance: "Include this event when reporting launch or packaging behavior.",
  },
  "app.bootstrap": {
    category: "packaging", severity: "error", summary: "PiLot could not finish application startup.",
    guidance: "Reopen PiLot. If startup still fails, export the local diagnostic bundle after the app opens.",
  },
  "app.window-load": {
    category: "packaging", severity: "error", summary: "PiLot could not load its application window.",
    guidance: "Reinstall the same PiLot release and try again.",
  },
  "app.notification": {
    category: "packaging", severity: "warning", summary: "PiLot could not present a desktop notification.",
    guidance: "Check operating-system notification permissions for PiLot.",
  },
  "app.lifecycle": {
    category: "runtime", severity: "error", summary: "PiLot could not finish a desktop lifecycle operation.",
    guidance: "Reopen PiLot and review active Tasks before continuing.",
  },
  "diagnostics.preview": {
    category: "packaging", severity: "error", summary: "PiLot could not read its local diagnostic preview.",
    guidance: "Check PiLot application-data permissions and try again.",
  },
  "diagnostics.export": {
    category: "packaging", severity: "info", summary: "A local diagnostic bundle was explicitly exported.",
    guidance: "Preview the bundle before sharing it with support.",
  },
  "diagnostics.export-failed": {
    category: "packaging", severity: "error", summary: "PiLot could not export the local diagnostic bundle.",
    guidance: "Choose a writable local destination and try again.",
  },
  "auth.read": {
    category: "auth", severity: "error", summary: "PiLot could not read provider authentication state.",
    guidance: "Open Provider Settings, review credential status, and try again.",
  },
  "auth.write": {
    category: "auth", severity: "error", summary: "PiLot could not update provider authentication.",
    guidance: "Check Pi credential-store access, then retry the provider action.",
  },
  "auth.login": {
    category: "auth", severity: "error", summary: "Provider authentication did not complete.",
    guidance: "Open Provider Settings and restart the sign-in flow.",
  },
  "preferences.read": {
    category: "preferences", severity: "error", summary: "PiLot could not read its desktop preferences.",
    guidance: "Check PiLot application-data permissions, then reopen the app.",
  },
  "preferences.write": {
    category: "preferences", severity: "error", summary: "PiLot could not save its desktop preferences.",
    guidance: "Check PiLot application-data permissions, then try the preference change again.",
  },
  "settings.read": {
    category: "settings-lock", severity: "error", summary: "PiLot could not read shared Pi settings.",
    guidance: "Check settings-file access and retry after other Pi processes finish writing.",
  },
  "settings.write": {
    category: "settings-lock", severity: "error", summary: "PiLot could not save shared Pi settings or acquire the settings lock.",
    guidance: "Wait for other Pi processes to finish their settings change, then try again.",
  },
  "session.compatibility": {
    category: "session-compatibility", severity: "error", summary: "One or more Task histories are newer, malformed, or unreadable.",
    guidance: "Review the Project diagnostic; update PiLot for newer formats and leave unsupported history untouched.",
  },
  "session.read": {
    category: "session-compatibility", severity: "error", summary: "PiLot could not read compatible Task history.",
    guidance: "Review Task compatibility and file access before retrying.",
  },
  "session.write": {
    category: "session-compatibility", severity: "error", summary: "PiLot could not safely update Task history.",
    guidance: "Stop other writers, reload the Task, and retry only after its history is current.",
  },
  "runtime.run": {
    category: "runtime", severity: "error", summary: "A Pi Run failed or could not start.",
    guidance: "Open the Task to review its visible Run evidence, provider state, and retry guidance.",
  },
  "runtime.setup": {
    category: "runtime", severity: "error", summary: "A Worktree setup operation failed or was interrupted.",
    guidance: "Review the visible setup output before retrying or bypassing setup.",
  },
  "runtime.command": {
    category: "runtime", severity: "error", summary: "A local command operation failed or could not start.",
    guidance: "Review the visible command block and shell readiness before retrying.",
  },
  "shell.capture": {
    category: "shell", severity: "warning", summary: "PiLot could not capture the configured login-shell environment.",
    guidance: "Fix shell startup configuration, then relaunch PiLot.",
  },
  "shell.resolve": {
    category: "shell", severity: "error", summary: "PiLot could not resolve a compatible shell.",
    guidance: "Configure Pi's shell path or install a supported Bash shell, then relaunch PiLot.",
  },
  "shell.launch": {
    category: "shell", severity: "error", summary: "PiLot could not launch a configured local application or shell.",
    guidance: "Check the configured application and captured PATH, then try again.",
  },
} as const satisfies Record<string, {
  category: DiagnosticCategory;
  severity: DiagnosticSeverity;
  summary: string;
  guidance: string;
}>;

const safeErrorCodes = new Set([
  "EACCES", "EBUSY", "ECONNREFUSED", "ECONNRESET", "EIO", "ELOCKED", "EMFILE", "ENFILE", "ENOENT",
  "ENOSPC", "ENOTFOUND", "EPERM", "EROFS", "ETIMEDOUT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
  "ERR_INVALID_ARG_TYPE", "ERR_INVALID_ARG_VALUE", "UNSUPPORTED_SESSION",
]);

type DiagnosticApplication = DiagnosticBundle["application"];

type StoredEvent = {
  timestamp: string;
  operation: DiagnosticOperation;
  category: DiagnosticCategory;
  severity: DiagnosticSeverity;
  summary: string;
  guidance: string;
  code?: string;
};

function errorCode(error: unknown) {
  const candidate = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  if (typeof candidate === "string" && safeErrorCodes.has(candidate)) return candidate;
  const message = error instanceof Error ? error.message : "";
  if (/locked by another process/i.test(message)) return "ELOCKED";
  if (/newer Task|newer Pi format/i.test(message)) return "UNSUPPORTED_SESSION";
  return undefined;
}

function safeStoredCode(value: unknown) {
  return typeof value === "string" && safeErrorCodes.has(value) ? value : undefined;
}

function safeTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && new Date(value).toISOString() === value;
}

function eventFor(operation: DiagnosticOperation, timestamp: string, code?: string): DiagnosticEvent & { operation: DiagnosticOperation } {
  return { timestamp, operation, ...operationDefinitions[operation], ...(code ? { code } : {}) };
}

function storedEvent(operation: DiagnosticOperation, error?: unknown): StoredEvent {
  return eventFor(operation, new Date().toISOString(), errorCode(error));
}

function isErrno(error: unknown, code: string) {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

async function moveIfPresent(source: string, destination: string) {
  try {
    await rename(source, destination);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

export class LocalDiagnostics {
  private readonly directory: string;
  private writes: Promise<void> = Promise.resolve();

  constructor(userDataDirectory: string, private readonly application: DiagnosticApplication) {
    this.directory = path.join(userDataDirectory, "diagnostics");
  }

  record(operation: DiagnosticOperation, error?: unknown): Promise<void> {
    const event = storedEvent(operation, error);
    const pending = this.writes.then(() => this.append(event));
    this.writes = pending.catch(() => undefined);
    return pending.catch(() => undefined);
  }

  private logPath(generation = 0) {
    return path.join(this.directory, generation === 0 ? currentLogName : `pilot-diagnostics.${generation}.jsonl`);
  }

  private async append(event: StoredEvent) {
    const line = `${JSON.stringify(event)}\n`;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const current = this.logPath();
    const size = await stat(current).then((value) => value.size).catch((error) => {
      if (isErrno(error, "ENOENT")) return 0;
      throw error;
    });
    if (size > 0 && size + Buffer.byteLength(line) > maximumLogBytes) {
      await rm(this.logPath(maximumLogFiles - 1), { force: true });
      for (let generation = maximumLogFiles - 2; generation >= 1; generation -= 1) {
        await moveIfPresent(this.logPath(generation), this.logPath(generation + 1));
      }
      await moveIfPresent(current, this.logPath(1));
    }
    await appendFile(current, line, { encoding: "utf8", mode: 0o600 });
    await chmod(current, 0o600);
  }

  flush() {
    return this.writes;
  }

  private async events(): Promise<DiagnosticEvent[]> {
    await this.flush();
    const events: DiagnosticEvent[] = [];
    for (let generation = maximumLogFiles - 1; generation >= 0; generation -= 1) {
      const content = await readFile(this.logPath(generation), "utf8").catch((error) => {
        if (isErrno(error, "ENOENT")) return "";
        throw error;
      });
      for (const line of content.split("\n")) {
        if (!line) continue;
        try {
          const value = JSON.parse(line) as { timestamp?: unknown; operation?: unknown; code?: unknown };
          if (!safeTimestamp(value.timestamp)) continue;
          if (typeof value.operation !== "string" || !Object.hasOwn(operationDefinitions, value.operation)) continue;
          const operation = value.operation as DiagnosticOperation;
          events.push(eventFor(operation, value.timestamp, safeStoredCode(value.code)));
        } catch {
          // Ignore incomplete or locally modified lines rather than exporting their content.
        }
      }
    }
    return events.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }

  async bundle(): Promise<DiagnosticBundle> {
    return {
      format: "pilot-diagnostics",
      version: 1,
      generatedAt: new Date().toISOString(),
      application: { ...this.application },
      privacy: {
        localOnly: true,
        analytics: false,
        automaticCrashUploads: false,
        excludedContent: ["secrets", "Task transcripts", "source content", "file and Project paths", "diff content"],
      },
      events: await this.events(),
    };
  }

  async export(destination: string) {
    const temporary = `${destination}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(await this.bundle(), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, destination);
      await this.record("diagnostics.export");
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
