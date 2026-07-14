import { AuthStorage, CURRENT_SESSION_VERSION, estimateTokens, ModelRegistry, ProjectTrustStore, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import type { ProjectDiagnostic, RunStatus, TaskExecutionLocation, TaskModelState, TaskSetupState, TaskSetupStatus, TaskSummary, ThinkingLevel } from "../shared/projects.js";
import { BUILT_IN_PROVIDER_IDS } from "../shared/providers.js";
import { guardTaskManager, taskSnapshot } from "./continuity.js";

const metadataType = "pilot.task";
const runMetadataType = "pilot.run";
const maximumTasks = 500;
const setupStatuses = new Set<TaskSetupStatus>(["pending", "running", "succeeded", "failed", "aborted", "interrupted", "bypassed"]);

type Header = { type?: string; version?: number; id?: string; cwd?: string; timestamp?: unknown };
type WorktreeRemovalJournal = {
  version: 1;
  taskPath: string;
  projectPath: string;
  worktreePath: string;
  removedAt: string;
  previousLifecycle: "active" | "archived";
  operationStartedAt?: string;
};

type TaskMetadata = {
  title?: string;
  lifecycle?: "active" | "archived";
  projectPath?: string;
  execution?: Partial<TaskExecutionLocation>;
  setup?: Partial<Omit<TaskSetupState, "taskPath">>;
};
type ResolvedTaskMetadata = {
  title: string;
  lifecycle: "active" | "archived";
  projectPath: string;
  execution: TaskExecutionLocation;
  setup?: Omit<TaskSetupState, "taskPath">;
};
type Inspection = { task?: TaskSummary; incompatible?: boolean; malformed?: boolean; enrichmentFailed?: boolean };
type TaskRead = Inspection & { header?: Header; hasMetadata?: boolean; metadata?: ResolvedTaskMetadata };

const taskWrites = new Map<string, Promise<void>>();

export async function withTaskWrite<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const previous = taskWrites.get(file) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => turn);
  taskWrites.set(file, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (taskWrites.get(file) === queued) taskWrites.delete(file);
  }
}

export function getProjectSessionDirectory(agentDir: string, projectPath: string) {
  const encoded = path.resolve(projectPath).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
  return path.join(agentDir, "sessions", `--${encoded}--`);
}

function text(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => part && typeof part === "object" && (part as { type?: string }).type === "text"
    ? [(part as { text?: unknown }).text]
    : []).filter((part): part is string => typeof part === "string").join(" ");
}

export function safeTaskTitle(value: string) {
  const title = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!title) return "Untitled task";
  return title.length > 80 ? `${title.slice(0, 79).trimEnd()}…` : title;
}

async function normalize(value: string) {
  return realpath(value).catch(() => path.resolve(value));
}

function metadataData(data: ResolvedTaskMetadata) {
  return { version: 1, ...data };
}

function worktreeExecution(value: unknown): Extract<TaskExecutionLocation, { kind: "worktree" }> | undefined {
  if (!value || typeof value !== "object") return;
  const data = value as Record<string, unknown>;
  if (data.kind !== "worktree" || typeof data.path !== "string" || typeof data.worktreePath !== "string"
    || typeof data.ref !== "string" || typeof data.commit !== "string"
    || (data.removedAt !== undefined && (typeof data.removedAt !== "string" || !Number.isFinite(Date.parse(data.removedAt))))) return;
  return {
    kind: "worktree",
    path: data.path,
    worktreePath: data.worktreePath,
    ref: data.ref,
    commit: data.commit,
    ...(typeof data.removedAt === "string" ? { removedAt: data.removedAt } : {}),
  };
}

function appendMetadata(file: string, data: ResolvedTaskMetadata) {
  guardTaskManager(file, SessionManager.open(file)).appendCustomEntry(metadataType, metadataData(data));
}

function git(cwd: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    execFile("git", ["--no-optional-locks", ...args], { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

async function gitCommonDirectory(cwd: string) {
  const value = (await git(cwd, ["rev-parse", "--git-common-dir"])).trim();
  return realpath(path.resolve(cwd, value));
}

async function readHeader(file: string): Promise<Header | undefined> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
    const header = JSON.parse(line) as Header;
    return header.type === "session" && typeof header.id === "string" && typeof header.cwd === "string" ? header : undefined;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

function runStatusOnActiveBranch(entries: Record<string, unknown>[]): RunStatus | undefined {
  const entriesById = new Map(entries.flatMap((entry) => typeof entry.id === "string" ? [[entry.id, entry] as const] : []));
  const leaf = [...entries].reverse().find((entry) => typeof entry.id === "string");
  const activeIds = new Set<string>();
  let entry = leaf;
  while (entry && typeof entry.id === "string" && !activeIds.has(entry.id)) {
    activeIds.add(entry.id);
    entry = typeof entry.parentId === "string" ? entriesById.get(entry.parentId) : undefined;
  }

  let latestRunId: string | undefined;
  let latestRunStatus: RunStatus | undefined;
  for (const candidate of entries) {
    if (typeof candidate.id !== "string" || !activeIds.has(candidate.id)) continue;
    if (candidate.type === "custom" && candidate.customType === runMetadataType && candidate.data && typeof candidate.data === "object") {
      const data = candidate.data as Record<string, unknown>;
      const runId = typeof data.runId === "string" ? data.runId : undefined;
      const outcome = typeof data.outcome === "string" ? data.outcome : undefined;
      if (runId && (data.inputKind === "prompt" || data.inputKind === "command" || data.inputKind === "compaction")) {
        latestRunId = runId;
        latestRunStatus = outcome === "queued" ? "queued" : outcome === "running"
          ? data.inputKind === "compaction" ? "compacting" : data.inputKind === "command" ? "running" : "preparing"
          : undefined;
      }
      if (runId === latestRunId && outcome && ["settled", "failed", "aborted", "interrupted"].includes(outcome)) {
        latestRunStatus = outcome as RunStatus;
      }
    } else if (candidate.type === "message" && latestRunStatus && ["settled", "failed", "aborted", "interrupted"].includes(latestRunStatus)) {
      latestRunId = undefined;
      latestRunStatus = undefined;
    }
  }
  return latestRunStatus && ["queued", "preparing", "running", "retrying", "compacting"].includes(latestRunStatus)
    ? "interrupted"
    : latestRunStatus;
}

async function readTask(file: string, projectPath: string): Promise<TaskRead> {
  let header: Header | undefined;
  let malformed = false;
  let firstMessage = "";
  let sessionName = "";
  let metadata: TaskMetadata | undefined;
  let lastActivity: number | undefined;
  const sessionEntries: Record<string, unknown>[] = [];

  try {
    const fileStat = await stat(file);
    const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        malformed = true;
        continue;
      }
      if (!header) {
        header = entry;
        if (header.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") return { malformed: true };
        if ((header.version ?? 1) > CURRENT_SESSION_VERSION) return { incompatible: true };
        continue;
      }
      sessionEntries.push(entry);
      if (entry.type === "session_info") sessionName = typeof entry.name === "string" ? entry.name : "";
      if (entry.type === "custom" && entry.customType === metadataType && entry.data && typeof entry.data === "object") {
        const data = entry.data as TaskMetadata;
        metadata = {
          title: typeof data.title === "string" ? data.title : undefined,
          lifecycle: data.lifecycle === "archived" ? "archived" : "active",
          projectPath: typeof data.projectPath === "string" ? data.projectPath : undefined,
          execution: data.execution && typeof data.execution === "object" ? data.execution : undefined,
          setup: data.setup && typeof data.setup === "object" ? data.setup : undefined,
        };
      }
      if (entry.type === "custom" && entry.customType === runMetadataType) {
        const timestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
        if (Number.isFinite(timestamp)) lastActivity = Math.max(lastActivity ?? 0, timestamp);
      }
      if (entry.type === "message" && entry.message && typeof entry.message === "object") {
        const message = entry.message as { role?: unknown; content?: unknown; timestamp?: unknown };
        if (!firstMessage && message.role === "user") firstMessage = text(message.content);
        if ((message.role === "user" || message.role === "assistant") && "content" in message) {
          const timestamp = typeof message.timestamp === "number"
            ? message.timestamp
            : typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
          if (Number.isFinite(timestamp)) lastActivity = Math.max(lastActivity ?? 0, timestamp);
        }
      }
    }
    if (!header) return { malformed: true };

    const canonicalProject = await normalize(metadata?.projectPath ?? header.cwd!);
    if (canonicalProject !== projectPath) return {};
    const storedWorktree = metadata?.execution?.kind === "worktree";
    const worktree = worktreeExecution(metadata?.execution);
    if (storedWorktree && !worktree) return { malformed: true, header, hasMetadata: true };
    const execution = worktree ?? { kind: "local" as const, path: projectPath };
    const setupStatus = typeof metadata?.setup?.status === "string" && setupStatuses.has(metadata.setup.status as TaskSetupStatus)
      ? metadata.setup.status as TaskSetupStatus
      : undefined;
    const setup = typeof metadata?.setup?.command === "string" && metadata.setup.command && setupStatus
      ? {
        command: metadata.setup.command,
        status: setupStatus,
        output: typeof metadata.setup.output === "string" ? metadata.setup.output : "",
        outputTruncated: metadata.setup.outputTruncated === true,
        ...(typeof metadata.setup.exitCode === "number" ? { exitCode: metadata.setup.exitCode } : {}),
      }
      : undefined;
    if (metadata?.setup && !setup) return { malformed: true, header, hasMetadata: true };
    const headerActivity = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : NaN;
    const modified = lastActivity ?? (Number.isFinite(headerActivity) ? headerActivity : fileStat.mtimeMs);
    const runStatus = runStatusOnActiveBranch(sessionEntries);
    const resolved: ResolvedTaskMetadata = {
      title: safeTaskTitle(sessionName || metadata?.title || firstMessage),
      lifecycle: metadata?.lifecycle ?? "active",
      projectPath,
      execution,
      ...(setup ? { setup } : {}),
    };
    return {
      task: { id: header.id!, path: file, title: resolved.title, lifecycle: resolved.lifecycle, modified: new Date(modified).toISOString(), execution, ...(setup ? { setup } : {}), ...(runStatus ? { runStatus } : {}) },
      malformed,
      header,
      hasMetadata: metadata !== undefined,
      metadata: resolved,
    };
  } catch {
    return { malformed: true };
  }
}

async function inspect(file: string, projectPath: string): Promise<Inspection> {
  const inspection = await readTask(file, projectPath);
  if (!inspection.task || inspection.hasMetadata || inspection.malformed
    || (inspection.header?.version ?? 1) !== CURRENT_SESSION_VERSION) return inspection;

  try {
    return await withTaskWrite(file, async () => {
      const live = await readTask(file, projectPath);
      if (!live.task || live.hasMetadata || live.malformed
        || (live.header?.version ?? 1) !== CURRENT_SESSION_VERSION) return live;
      const manager = guardTaskManager(file, SessionManager.open(file));
      if (manager.getEntries().some((entry) => entry.type === "custom" && entry.customType === metadataType)) {
        return readTask(file, projectPath);
      }
      manager.appendCustomEntry(metadataType, metadataData(live.metadata!));
      return live;
    });
  } catch {
    return { ...inspection, enrichmentFailed: true };
  }
}

export async function createTaskAtExecution(agentDir: string, projectPath: string, execution: TaskExecutionLocation, setupCommand?: string) {
  const project = await normalize(projectPath);
  const directory = getProjectSessionDirectory(agentDir, project);
  const manager = SessionManager.create(execution.path, directory);
  const file = manager.getSessionFile();
  const header = manager.getHeader();
  if (!file || !header) throw new Error("Pi could not create this Task");
  await mkdir(directory, { recursive: true });
  await writeFile(file, `${JSON.stringify(header)}\n`, { flag: "wx" });
  const metadata: ResolvedTaskMetadata = {
    title: "Untitled task",
    lifecycle: "active",
    projectPath: project,
    execution,
    ...(setupCommand ? { setup: { command: setupCommand, status: "pending", output: "", outputTruncated: false } } : {}),
  };
  guardTaskManager(file, SessionManager.open(file)).appendCustomEntry(metadataType, metadataData(metadata));
  return { id: header.id, path: file, title: metadata.title, lifecycle: metadata.lifecycle, modified: header.timestamp, execution, ...(metadata.setup ? { setup: metadata.setup } : {}) };
}

export async function createLocalTask(agentDir: string, projectPath: string) {
  const project = await normalize(projectPath);
  return createTaskAtExecution(agentDir, project, { kind: "local", path: project });
}

function assertOwnedTaskPath(agentDir: string, file: string) {
  const relative = path.relative(path.resolve(agentDir, "sessions"), file);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("This Task does not belong to the admitted Project");
  }
}

async function readOwnedTask(agentDir: string, projectPath: string, taskPath: string) {
  const file = path.resolve(taskPath);
  assertOwnedTaskPath(agentDir, file);
  const project = await normalize(projectPath);
  return { file, project, result: await readTask(file, project) };
}

async function readMutableTask(agentDir: string, projectPath: string, taskPath: string, purpose: string, missingMessage: string) {
  const context = await readOwnedTask(agentDir, projectPath, taskPath);
  const task = context.result;
  if (task.malformed) throw new Error(`Repair this Task's unreadable history before ${purpose}`);
  if (!task.task || !task.header || !task.metadata) throw new Error(missingMessage);
  const version = task.header.version ?? 1;
  if (version < 2 || version > CURRENT_SESSION_VERSION) throw new Error(`Update this Task's Pi format before ${purpose}`);
  return { ...context, task: task.task, metadata: task.metadata };
}

function removalJournal(value: unknown): WorktreeRemovalJournal | undefined {
  if (!value || typeof value !== "object") return;
  const data = value as Partial<WorktreeRemovalJournal>;
  if (data.version !== 1 || typeof data.taskPath !== "string" || typeof data.projectPath !== "string"
    || typeof data.worktreePath !== "string" || typeof data.removedAt !== "string" || !Number.isFinite(Date.parse(data.removedAt))
    || (data.previousLifecycle !== "active" && data.previousLifecycle !== "archived")
    || (data.operationStartedAt !== undefined && (typeof data.operationStartedAt !== "string" || !Number.isFinite(Date.parse(data.operationStartedAt))))) return;
  return data as WorktreeRemovalJournal;
}

function removalJournalDirectory(userData: string) {
  return path.join(userData, "pending-worktree-removals");
}

async function flushFile(file: string) {
  const handle = await open(file, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function flushDirectory(directory: string) {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeRemovalJournal(file: string, journal: WorktreeRemovalJournal) {
  const temporary = `${file}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx");
    await handle.writeFile(JSON.stringify(journal));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
    await flushDirectory(path.dirname(file));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function createRemovalJournal(userData: string, journal: WorktreeRemovalJournal) {
  const directory = removalJournalDirectory(userData);
  const target = path.join(directory, `${randomUUID()}.json`);
  await mkdir(directory, { recursive: true });
  await flushDirectory(path.dirname(directory));
  await writeRemovalJournal(target, journal);
  return target;
}

async function removeRemovalJournal(file: string) {
  await rm(file, { force: true });
  await flushDirectory(path.dirname(file));
}

async function worktreeExists(file: string) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function reconcileRemovalJournal(userData: string, agentDir: string, journal: WorktreeRemovalJournal, recovering = false) {
  const root = await realpath(path.join(userData, "worktrees"));
  let exists = await worktreeExists(journal.worktreePath);
  if (recovering && exists && journal.operationStartedAt) {
    for (let attempt = 0; attempt < 300 && exists; attempt++) {
      await delay(100);
      exists = await worktreeExists(journal.worktreePath);
    }
    if (exists && Date.now() - Date.parse(journal.operationStartedAt) < 5 * 60_000) {
      throw new Error("The interrupted Git Worktree removal may still be finishing");
    }
  }
  const target = exists ? await realpath(journal.worktreePath) : path.resolve(journal.worktreePath);
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Pending Worktree cleanup points outside PiLot-managed storage");
  }
  const task = await readMutableTask(agentDir, journal.projectPath, journal.taskPath, "recovering Worktree cleanup", "Pending Worktree cleanup does not identify a Task");
  if (task.task.execution.kind !== "worktree" || path.resolve(task.task.execution.worktreePath) !== path.resolve(journal.worktreePath)) {
    throw new Error("Pending Worktree cleanup no longer matches its Task");
  }
  const marked = task.task.execution.removedAt === journal.removedAt;
  if (exists && marked) {
    const execution = { ...task.task.execution };
    delete execution.removedAt;
    appendMetadata(task.file, { ...task.metadata, lifecycle: journal.previousLifecycle, execution });
    await flushFile(task.file);
  } else if (!exists && (!marked || task.metadata.lifecycle !== "archived")) {
    const execution = { ...task.task.execution, removedAt: journal.removedAt };
    appendMetadata(task.file, { ...task.metadata, lifecycle: "archived", execution });
    await flushFile(task.file);
  }
}

export async function recoverTaskWorktreeRemovals(userData: string, agentDir: string) {
  const directory = removalJournalDirectory(userData);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith(".tmp")) {
      await rm(file, { force: true }).catch(() => undefined);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const journal = removalJournal(JSON.parse(await readFile(file, "utf8")));
      if (!journal) throw new Error("Pending Worktree cleanup journal is invalid");
      await withTaskWrite(path.resolve(journal.taskPath), () => reconcileRemovalJournal(userData, agentDir, journal, true));
      await removeRemovalJournal(file);
    } catch (error) {
      console.error(`Could not recover pending Worktree cleanup ${entry.name}:`, error);
    }
  }
}

export async function assertReadableTask(agentDir: string, projectPath: string, taskPath: string) {
  const { file, project, result } = await readOwnedTask(agentDir, projectPath, taskPath);
  if (result.incompatible) throw new Error("Update PiLot before reading this newer Task");
  if (result.malformed) throw new Error("Repair this Task's unreadable history before reading it");
  if (!result.task || !result.header) throw new Error("This Task does not belong to the admitted Project");
  return { file, project, task: result.task, header: result.header, metadata: result.metadata };
}

export async function assertRunnableTask(agentDir: string, projectPath: string, taskPath: string) {
  const context = await assertReadableTask(agentDir, projectPath, taskPath);
  const { file, project, task, header } = context;
  const execution = task.execution;
  if (execution.kind === "worktree" && execution.removedAt) {
    throw new Error("This managed Worktree was removed; its Task history remains archived");
  }
  if (task.lifecycle !== "active") throw new Error("Restore this archived Task before running it");
  const executionPath = await normalize(execution.path);
  if (await normalize(header.cwd!) !== executionPath) throw new Error("This Task's Execution location does not match its Pi history");
  if (execution.kind === "local") {
    if (executionPath !== project) throw new Error("This Local Task does not belong to the admitted Project");
  } else {
    const worktreePath = await normalize(execution.worktreePath);
    const relative = path.relative(worktreePath, executionPath);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("This managed Worktree Task has an invalid Execution location");
    }
    try {
      const [projectGit, worktreeGit] = await Promise.all([gitCommonDirectory(project), gitCommonDirectory(executionPath)]);
      if (projectGit !== worktreeGit) throw new Error("mismatch");
    } catch {
      throw new Error("This managed Worktree is unavailable or no longer belongs to the Project");
    }
  }
  return { file, project, executionPath, execution, setup: context.metadata?.setup };
}

export async function getTaskSetupState(agentDir: string, projectPath: string, taskPath: string): Promise<TaskSetupState | undefined> {
  const context = await assertRunnableTask(agentDir, projectPath, taskPath);
  return context.setup ? { taskPath: context.file, ...context.setup } : undefined;
}

export async function setTaskSetupState(
  agentDir: string,
  projectPath: string,
  taskPath: string,
  setup: Omit<TaskSetupState, "taskPath">,
): Promise<TaskSetupState> {
  const context = await assertRunnableTask(agentDir, projectPath, taskPath);
  if (!context.setup) throw new Error("This Task has no setup command");
  return withTaskWrite(context.file, async () => {
    const task = await readTask(context.file, context.project);
    if (!task.metadata?.setup) throw new Error("This Task has no setup command");
    appendMetadata(context.file, { ...task.metadata, setup });
    return { taskPath: context.file, ...setup };
  });
}

export async function discoverTasks(agentDir: string, projectPath: string) {
  const diagnostics: ProjectDiagnostic[] = [];
  const sessionRoot = path.join(agentDir, "sessions");
  const canonicalDirectory = getProjectSessionDirectory(agentDir, projectPath);
  let files: string[] = [];
  try {
    const directories = (await readdir(sessionRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    for (const directory of directories) {
      const child = path.join(sessionRoot, directory.name);
      try {
        files.push(...(await readdir(child, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
          .map((entry) => path.join(child, entry.name)));
      } catch {
        if (child === canonicalDirectory) diagnostics.push({
          title: "Task history is unavailable",
          detail: "PiLot could not read this Project's Pi task folder. Check its permissions and try again.",
        });
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.push({
      title: "Task history is unavailable",
      detail: "PiLot could not read Pi task folders. Check their permissions and try again.",
    });
    return { tasks: [], diagnostics };
  }

  const malformedByDirectory = new Map<string, number>();
  const matchingDirectories = new Set<string>([canonicalDirectory]);
  const matching: string[] = [];
  for (const file of files) {
    const directory = path.dirname(file);
    const header = await readHeader(file);
    if (!header) {
      malformedByDirectory.set(directory, (malformedByDirectory.get(directory) ?? 0) + 1);
      continue;
    }
    if (directory === canonicalDirectory || await normalize(header.cwd!) === projectPath) {
      matching.push(file);
      matchingDirectories.add(directory);
    }
  }
  const malformedInProjectDirectory = [...malformedByDirectory]
    .filter(([directory]) => matchingDirectories.has(directory))
    .reduce((sum, [, count]) => sum + count, 0);
  files = matching.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
  if (files.length > maximumTasks) diagnostics.push({
    title: "Some Tasks are not shown",
    detail: `This Project has ${files.length} Pi task files. PiLot loaded the newest ${maximumTasks}; archive or move older history to inspect it here.`,
  });

  const inspections = [];
  for (const file of files.slice(0, maximumTasks)) inspections.push(await inspect(file, projectPath));
  for (let count = 0; count < malformedInProjectDirectory; count++) inspections.push({ malformed: true });
  const incompatible = inspections.filter((item) => item.incompatible).length;
  const malformed = inspections.filter((item) => item.malformed).length;
  const enrichmentFailed = inspections.filter((item) => item.enrichmentFailed).length;
  if (incompatible) diagnostics.push({
    title: "Update PiLot to open newer Tasks",
    detail: `${incompatible} Task${incompatible === 1 ? " uses" : "s use"} a newer Pi format and remains untouched.`,
  });
  if (malformed) diagnostics.push({
    title: "Review unreadable Task history",
    detail: `${malformed} Pi task file${malformed === 1 ? " could" : "s could"} not be read safely and remains untouched.`,
  });
  if (enrichmentFailed) diagnostics.push({
    title: "Some Task details could not be saved",
    detail: `PiLot found ${enrichmentFailed} Task${enrichmentFailed === 1 ? "" : "s"}, but could not append its compatibility metadata. Check file permissions.`,
  });
  return {
    tasks: inspections.flatMap((item) => item.task ? [item.task] : []).sort((a, b) => b.modified.localeCompare(a.modified)),
    diagnostics,
  };
}

type RegisteredModel = ReturnType<ModelRegistry["getAll"]>[number];

const allThinkingLevels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function supportedThinkingLevels(model: RegisteredModel): ThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return allThinkingLevels.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    return mapped !== null && ((level !== "xhigh" && level !== "max") || mapped !== undefined);
  });
}

function clampThinkingLevel(model: RegisteredModel, requested: ThinkingLevel) {
  const supported = supportedThinkingLevels(model);
  if (supported.includes(requested)) return requested;
  const index = allThinkingLevels.indexOf(requested);
  return allThinkingLevels.slice(index).find((level) => supported.includes(level))
    ?? allThinkingLevels.slice(0, index).reverse().find((level) => supported.includes(level))
    ?? "off";
}

function modelServices(agentDir: string, projectPath: string, executionPath = projectPath) {
  const auth = AuthStorage.create(path.join(agentDir, "auth.json"));
  const models = ModelRegistry.create(auth, path.join(agentDir, "models.json"));
  if (models.getError()) throw new Error(`Fix models.json before configuring this Task: ${models.getError()}`);
  const trusted = new ProjectTrustStore(agentDir).getEntry(projectPath)?.decision === true;
  return { auth, models, settings: SettingsManager.create(executionPath, agentDir, { projectTrusted: trusted }) };
}

function usage(manager: SessionManager, model?: RegisteredModel): TaskModelState["usage"] {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let totalTokens = 0;
  let cost = 0;
  for (const entry of manager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const value = entry.message.usage;
    if (!value) continue;
    input += value.input ?? 0;
    output += value.output ?? 0;
    cacheRead += value.cacheRead ?? 0;
    cacheWrite += value.cacheWrite ?? 0;
    totalTokens += (value.input ?? 0) + (value.output ?? 0) + (value.cacheRead ?? 0) + (value.cacheWrite ?? 0);
    cost += value.cost?.total ?? 0;
  }
  const branch = manager.getBranch();
  const lastIndex = (predicate: (entry: (typeof branch)[number]) => boolean) => {
    for (let index = branch.length - 1; index >= 0; index--) if (predicate(branch[index])) return index;
    return -1;
  };
  const compactionIndex = lastIndex((entry) => entry.type === "compaction");
  const currentIndex = lastIndex((entry) => entry.type === "message" && entry.message.role === "assistant"
    && entry.message.stopReason !== "aborted" && entry.message.stopReason !== "error"
    && Boolean(entry.message.usage?.totalTokens || entry.message.usage?.input || entry.message.usage?.output || entry.message.usage?.cacheRead || entry.message.usage?.cacheWrite));
  const messages = manager.buildSessionContext().messages;
  const currentMessageIndex = (() => {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.role === "assistant" && message.stopReason !== "aborted" && message.stopReason !== "error"
        && Boolean(message.usage?.totalTokens || message.usage?.input || message.usage?.output || message.usage?.cacheRead || message.usage?.cacheWrite)) return index;
    }
    return -1;
  })();
  const current = currentMessageIndex >= 0 && messages[currentMessageIndex].role === "assistant"
    ? messages[currentMessageIndex]
    : undefined;
  const contextTokens = compactionIndex >= 0 && currentIndex < compactionIndex ? null : current
    ? (current.usage.totalTokens || current.usage.input + current.usage.output + current.usage.cacheRead + current.usage.cacheWrite)
      + messages.slice(currentMessageIndex + 1).reduce((total, message) => total + estimateTokens(message), 0)
    : messages.reduce((total, message) => total + estimateTokens(message), 0);
  const contextWindow = model?.contextWindow;
  return {
    contextTokens,
    ...(contextWindow ? { contextWindow, contextPercent: contextTokens === null ? null : contextTokens / contextWindow * 100 } : {}),
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost,
  };
}

function customEndpointProviders(agentDir: string) {
  try {
    const input = readFileSync(path.join(agentDir, "models.json"), "utf8")
      .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => match[0] === '"' ? match : "")
      .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail) => tail ?? (match[0] === '"' ? match : ""));
    const providers = JSON.parse(input).providers ?? {};
    return new Set(Object.entries(providers).filter(([, value]) => {
      if (!value || typeof value !== "object") return false;
      const config = value as { baseUrl?: unknown; models?: Array<{ baseUrl?: unknown }> };
      return typeof config.baseUrl === "string" || config.models?.some((model) => typeof model.baseUrl === "string");
    }).map(([id]) => id));
  } catch {
    return new Set<string>();
  }
}

function taskModelState(file: string, projectPath: string, executionPath: string, agentDir: string, manager: SessionManager): TaskModelState {
  const { auth, models, settings } = modelServices(agentDir, projectPath, executionPath);
  const customEndpoints = customEndpointProviders(agentDir);
  const available = models.getAvailable();
  const availableByKey = new Map(available.map((model) => [`${model.provider}/${model.id}`, model]));
  const context = manager.buildSessionContext();
  const savedKey = context.model ? `${context.model.provider}/${context.model.modelId}` : undefined;
  const saved = savedKey ? availableByKey.get(savedKey) : undefined;
  const configuredDefault = settings.getDefaultProvider() && settings.getDefaultModel()
    ? availableByKey.get(`${settings.getDefaultProvider()}/${settings.getDefaultModel()}`)
    : undefined;
  const selected = saved ?? configuredDefault ?? available[0];
  const hasThinkingEntry = manager.getBranch().some((entry) => entry.type === "thinking_level_change");
  const requested = (hasThinkingEntry ? context.thinkingLevel : settings.getDefaultThinkingLevel() ?? "medium") as ThinkingLevel;
  const thinkingLevel = selected ? clampThinkingLevel(selected, requested) : "off";
  const providerIds = new Set([...models.getAll().map((model) => model.provider), ...auth.list()]);
  const providers = [...providerIds].map((id) => {
    const status = models.getProviderAuthStatus(id);
    const displayName = models.getProviderDisplayName(id);
    return {
      id,
      name: displayName === id ? id[0]?.toUpperCase() + id.slice(1) : displayName,
      builtIn: BUILT_IN_PROVIDER_IDS.has(id) && !customEndpoints.has(id),
      configured: Boolean(status.source),
      credentialStatus: status.source ? "Credentials configured" : "Credentials not configured",
      models: available.filter((model) => model.provider === id).map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name || model.id,
      })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return {
    taskPath: file,
    ...(selected ? { selected: { provider: selected.provider, id: selected.id, name: selected.name || selected.id } } : {}),
    thinkingLevel,
    thinkingLevels: selected ? supportedThinkingLevels(selected) : ["off"],
    ...(savedKey && !saved ? {
      fallback: selected
        ? `Could not restore ${savedKey}. Using ${selected.provider}/${selected.id}.`
        : `Could not restore ${savedKey}. Connect a provider in Settings.`,
    } : {}),
    providers,
    usage: usage(manager, selected),
  };
}

export async function getTaskModelState(agentDir: string, projectPath: string, taskPath: string) {
  const { file, project, executionPath } = await assertRunnableTask(agentDir, projectPath, taskPath);
  return withTaskWrite(file, async () => taskModelState(file, project, executionPath, agentDir, SessionManager.open(file)));
}

export async function setTaskModel(agentDir: string, projectPath: string, taskPath: string, provider: string, modelId: string) {
  const { file, project, executionPath } = await assertRunnableTask(agentDir, projectPath, taskPath);
  return withTaskWrite(file, async () => {
    const manager = guardTaskManager(file, SessionManager.open(file));
    const before = taskModelState(file, project, executionPath, agentDir, manager);
    const { models } = modelServices(agentDir, project, executionPath);
    const model = models.getAvailable().find((candidate) => candidate.provider === provider && candidate.id === modelId);
    if (!model) throw new Error("Connect this model's provider in Settings before selecting it");
    const saved = manager.buildSessionContext().model;
    if (saved?.provider !== provider || saved.modelId !== modelId) manager.appendModelChange(provider, modelId);
    const thinking = clampThinkingLevel(model, before.thinkingLevel);
    if (thinking !== before.thinkingLevel) manager.appendThinkingLevelChange(thinking);
    return taskModelState(file, project, executionPath, agentDir, manager);
  });
}

export async function setTaskThinking(agentDir: string, projectPath: string, taskPath: string, requested: ThinkingLevel) {
  if (!allThinkingLevels.includes(requested)) throw new Error("Choose a valid thinking level");
  const { file, project, executionPath } = await assertRunnableTask(agentDir, projectPath, taskPath);
  return withTaskWrite(file, async () => {
    const manager = guardTaskManager(file, SessionManager.open(file));
    const before = taskModelState(file, project, executionPath, agentDir, manager);
    if (!before.selected) throw new Error("Connect a provider before choosing a thinking level");
    const { models } = modelServices(agentDir, project, executionPath);
    const model = models.find(before.selected.provider, before.selected.id);
    if (!model) throw new Error("Choose an available model first");
    const thinking = clampThinkingLevel(model, requested);
    if (thinking !== before.thinkingLevel) manager.appendThinkingLevelChange(thinking);
    return taskModelState(file, project, executionPath, agentDir, manager);
  });
}

export function getTaskSessionSelection(manager: SessionManager, models: ModelRegistry) {
  const context = manager.buildSessionContext();
  const hasModelEntry = manager.getBranch().some((entry) => entry.type === "model_change");
  const hasThinkingEntry = manager.getBranch().some((entry) => entry.type === "thinking_level_change");
  const model = hasModelEntry && context.model
    ? models.getAvailable().find((candidate) => candidate.provider === context.model!.provider && candidate.id === context.model!.modelId)
    : undefined;
  return {
    ...(model ? { model } : {}),
    ...(hasThinkingEntry ? { thinkingLevel: context.thinkingLevel as ThinkingLevel } : {}),
  };
}

export function setTaskLifecycle(agentDir: string, projectPath: string, taskPath: string, lifecycle: "active" | "archived") {
  const file = path.resolve(taskPath);
  return withTaskWrite(file, async () => {
    const task = await readMutableTask(agentDir, projectPath, file, "changing its lifecycle", "This Task does not belong to the admitted Project");
    if (lifecycle === "active" && task.task.execution.kind === "worktree" && task.task.execution.removedAt) {
      throw new Error("A Task whose managed Worktree was removed cannot be restored");
    }
    appendMetadata(file, { ...task.metadata, title: task.task.title, lifecycle });
  });
}

export function withTaskWorktreeRemoval<T>(
  userData: string,
  agentDir: string,
  projectPath: string,
  taskPath: string,
  removedAt: string,
  operation: (markStarted: () => Promise<void>) => Promise<T>,
) {
  const file = path.resolve(taskPath);
  return withTaskWrite(file, async () => {
    const task = await readMutableTask(agentDir, projectPath, file, "removing its Worktree", "This Task does not use a managed Worktree");
    if (task.task.execution.kind !== "worktree") throw new Error("This Task does not use a managed Worktree");
    const previous = { ...task.metadata, title: task.task.title };
    const journal: WorktreeRemovalJournal = {
      version: 1,
      taskPath: file,
      projectPath: task.project,
      worktreePath: task.task.execution.worktreePath,
      removedAt,
      previousLifecycle: previous.lifecycle,
    };
    const journalFile = await createRemovalJournal(userData, journal);
    try {
      appendMetadata(file, {
        ...previous,
        lifecycle: "archived",
        execution: { ...task.task.execution, removedAt },
      });
      await flushFile(file);
      const markStarted = async () => {
        if (journal.operationStartedAt) return;
        journal.operationStartedAt = new Date().toISOString();
        await writeRemovalJournal(journalFile, journal);
      };
      const result = await operation(markStarted);
      await removeRemovalJournal(journalFile).catch(() => undefined);
      return result;
    } catch (error) {
      try {
        await reconcileRemovalJournal(userData, agentDir, journal);
        await removeRemovalJournal(journalFile);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Worktree removal failed and Task metadata could not be reconciled");
      }
      throw error;
    }
  });
}

export async function forkChangedTask(
  agentDir: string,
  projectPath: string,
  taskPath: string,
  targetExecution: TaskExecutionLocation,
  setupCommand?: string,
) {
  const file = path.resolve(taskPath);
  const { project, executionPath } = await assertRunnableTask(agentDir, projectPath, file);
  const source = taskSnapshot(file).toString("utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const sourceHeader = source[0] as Header | undefined;
  if (!sourceHeader || sourceHeader.type !== "session" || typeof sourceHeader.id !== "string" || typeof sourceHeader.cwd !== "string"
    || await normalize(sourceHeader.cwd) !== executionPath || (sourceHeader.version ?? 1) !== CURRENT_SESSION_VERSION) {
    throw new Error("The last PiLot path cannot be forked safely");
  }

  const created = SessionManager.create(targetExecution.path, path.dirname(file), { parentSession: file });
  const output = created.getSessionFile();
  const header = created.getHeader();
  if (!output || !header) throw new Error("Pi could not fork this Task");
  await writeFile(output, `${[header, ...source.slice(1)].map((entry) => JSON.stringify(entry)).join("\n")}\n`, { flag: "wx" });
  const copied = await readTask(output, project);
  if (!copied.task || copied.malformed) throw new Error("The last PiLot path cannot be forked safely");
  const setup = setupCommand ? { command: setupCommand, status: "pending" as const, output: "", outputTruncated: false } : undefined;
  appendMetadata(output, { ...copied.metadata!, title: copied.task.title, lifecycle: "active", execution: targetExecution, setup });
  return {
    ...copied.task,
    id: header.id,
    path: output,
    lifecycle: "active" as const,
    modified: header.timestamp,
    execution: targetExecution,
    setup,
  };
}
