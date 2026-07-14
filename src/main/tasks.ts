import { AuthStorage, CURRENT_SESSION_VERSION, estimateTokens, ModelRegistry, ProjectTrustStore, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { mkdir, open, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { createReadStream, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { ProjectDiagnostic, TaskModelState, TaskSummary, ThinkingLevel } from "../shared/projects.js";
import { BUILT_IN_PROVIDER_IDS } from "../shared/providers.js";
import { guardTaskManager, taskSnapshot } from "./continuity.js";

const metadataType = "pilot.task";
const maximumTasks = 500;

type Header = { type?: string; version?: number; id?: string; cwd?: string; timestamp?: unknown };
type TaskMetadata = { title?: string; lifecycle?: "active" | "archived" };
type Inspection = { task?: TaskSummary; incompatible?: boolean; malformed?: boolean; enrichmentFailed?: boolean };
type TaskRead = Inspection & { header?: Header; hasMetadata?: boolean };

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

function appendMetadata(file: string, data: Required<TaskMetadata>) {
  guardTaskManager(file, SessionManager.open(file)).appendCustomEntry(metadataType, { version: 1, ...data });
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

async function readTask(file: string, projectPath: string): Promise<TaskRead> {
  let header: Header | undefined;
  let malformed = false;
  let firstMessage = "";
  let sessionName = "";
  let metadata: TaskMetadata | undefined;
  let lastActivity: number | undefined;

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
        if (await normalize(header.cwd) !== projectPath) return {};
        if ((header.version ?? 1) > CURRENT_SESSION_VERSION) return { incompatible: true };
        continue;
      }
      if (entry.type === "session_info") sessionName = typeof entry.name === "string" ? entry.name : "";
      if (entry.type === "custom" && entry.customType === metadataType && entry.data && typeof entry.data === "object") {
        const data = entry.data as TaskMetadata;
        metadata = {
          title: typeof data.title === "string" ? data.title : undefined,
          lifecycle: data.lifecycle === "archived" ? "archived" : "active",
        };
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

    const headerActivity = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : NaN;
    const modified = lastActivity ?? (Number.isFinite(headerActivity) ? headerActivity : fileStat.mtimeMs);
    const title = safeTaskTitle(sessionName || metadata?.title || firstMessage);
    const lifecycle = metadata?.lifecycle ?? "active";
    return {
      task: { id: header.id!, path: file, title, lifecycle, modified: new Date(modified).toISOString() },
      malformed,
      header,
      hasMetadata: metadata !== undefined,
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
      manager.appendCustomEntry(metadataType, { version: 1, title: live.task.title, lifecycle: live.task.lifecycle });
      return live;
    });
  } catch {
    return { ...inspection, enrichmentFailed: true };
  }
}

export async function createLocalTask(agentDir: string, projectPath: string) {
  const project = await normalize(projectPath);
  const directory = getProjectSessionDirectory(agentDir, project);
  const manager = SessionManager.create(project, directory);
  const file = manager.getSessionFile();
  const header = manager.getHeader();
  if (!file || !header) throw new Error("Pi could not create this Task");
  await mkdir(directory, { recursive: true });
  await writeFile(file, `${JSON.stringify(header)}\n`, { flag: "wx" });
  const opened = SessionManager.open(file);
  opened.appendCustomEntry(metadataType, { version: 1, title: "Untitled task", lifecycle: "active" });
  return { id: header.id, path: file, title: "Untitled task", lifecycle: "active" as const, modified: header.timestamp };
}

export async function assertRunnableTask(agentDir: string, projectPath: string, taskPath: string) {
  const file = path.resolve(taskPath);
  const relative = path.relative(path.resolve(agentDir, "sessions"), file);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("This Task does not belong to the admitted Project");
  }
  const project = await normalize(projectPath);
  const task = await readTask(file, project);
  if (task.incompatible) throw new Error("Update PiLot before running this newer Task");
  if (task.malformed) throw new Error("Repair this Task's unreadable history before running it");
  if (!task.task) throw new Error("This Task does not belong to the admitted Project");
  return { file, project, executionPath: project };
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
    if (await normalize(header.cwd!) === projectPath) {
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

function modelServices(agentDir: string, projectPath: string) {
  const auth = AuthStorage.create(path.join(agentDir, "auth.json"));
  const models = ModelRegistry.create(auth, path.join(agentDir, "models.json"));
  if (models.getError()) throw new Error(`Fix models.json before configuring this Task: ${models.getError()}`);
  const trusted = new ProjectTrustStore(agentDir).getEntry(projectPath)?.decision === true;
  return { auth, models, settings: SettingsManager.create(projectPath, agentDir, { projectTrusted: trusted }) };
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

function taskModelState(file: string, projectPath: string, agentDir: string, manager: SessionManager): TaskModelState {
  const { auth, models, settings } = modelServices(agentDir, projectPath);
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
  const { file, project } = await assertRunnableTask(agentDir, projectPath, taskPath);
  return withTaskWrite(file, async () => taskModelState(file, project, agentDir, SessionManager.open(file)));
}

export async function setTaskModel(agentDir: string, projectPath: string, taskPath: string, provider: string, modelId: string) {
  const { file, project } = await assertRunnableTask(agentDir, projectPath, taskPath);
  return withTaskWrite(file, async () => {
    const manager = guardTaskManager(file, SessionManager.open(file));
    const before = taskModelState(file, project, agentDir, manager);
    const { models } = modelServices(agentDir, project);
    const model = models.getAvailable().find((candidate) => candidate.provider === provider && candidate.id === modelId);
    if (!model) throw new Error("Connect this model's provider in Settings before selecting it");
    const saved = manager.buildSessionContext().model;
    if (saved?.provider !== provider || saved.modelId !== modelId) manager.appendModelChange(provider, modelId);
    const thinking = clampThinkingLevel(model, before.thinkingLevel);
    if (thinking !== before.thinkingLevel) manager.appendThinkingLevelChange(thinking);
    return taskModelState(file, project, agentDir, manager);
  });
}

export async function setTaskThinking(agentDir: string, projectPath: string, taskPath: string, requested: ThinkingLevel) {
  if (!allThinkingLevels.includes(requested)) throw new Error("Choose a valid thinking level");
  const { file, project } = await assertRunnableTask(agentDir, projectPath, taskPath);
  return withTaskWrite(file, async () => {
    const manager = guardTaskManager(file, SessionManager.open(file));
    const before = taskModelState(file, project, agentDir, manager);
    if (!before.selected) throw new Error("Connect a provider before choosing a thinking level");
    const { models } = modelServices(agentDir, project);
    const model = models.find(before.selected.provider, before.selected.id);
    if (!model) throw new Error("Choose an available model first");
    const thinking = clampThinkingLevel(model, requested);
    if (thinking !== before.thinkingLevel) manager.appendThinkingLevelChange(thinking);
    return taskModelState(file, project, agentDir, manager);
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
    const relative = path.relative(path.resolve(agentDir, "sessions"), file);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("This Task does not belong to the admitted Project");
    }
    const task = await readTask(file, await normalize(projectPath));
    if (!task.task) throw new Error("This Task does not belong to the admitted Project");
    if (task.malformed) throw new Error("Repair this Task's unreadable history before changing its lifecycle");
    const version = task.header?.version ?? 1;
    if (version < 2 || version > CURRENT_SESSION_VERSION) {
      throw new Error("Update this Task's Pi format before changing its lifecycle");
    }
    appendMetadata(file, { title: task.task.title, lifecycle });
  });
}

export async function forkChangedTask(agentDir: string, projectPath: string, taskPath: string) {
  const file = path.resolve(taskPath);
  const relative = path.relative(path.resolve(agentDir, "sessions"), file);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("This Task does not belong to the admitted Project");
  }
  const project = await normalize(projectPath);
  const source = taskSnapshot(file).toString("utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const sourceHeader = source[0] as Header | undefined;
  if (!sourceHeader || sourceHeader.type !== "session" || typeof sourceHeader.id !== "string" || typeof sourceHeader.cwd !== "string"
    || await normalize(sourceHeader.cwd) !== project || (sourceHeader.version ?? 1) !== CURRENT_SESSION_VERSION) {
    throw new Error("The last PiLot path cannot be forked safely");
  }

  const created = SessionManager.create(project, path.dirname(file), { parentSession: file });
  const output = created.getSessionFile();
  const header = created.getHeader();
  if (!output || !header) throw new Error("Pi could not fork this Task");
  await writeFile(output, `${[header, ...source.slice(1)].map((entry) => JSON.stringify(entry)).join("\n")}\n`, { flag: "wx" });
  const copied = await readTask(output, project);
  if (!copied.task || copied.malformed) throw new Error("The last PiLot path cannot be forked safely");
  SessionManager.open(output).appendCustomEntry(metadataType, { version: 1, title: copied.task.title, lifecycle: "active" });
  return { ...copied.task, id: header.id, path: output, lifecycle: "active" as const, modified: header.timestamp };
}
