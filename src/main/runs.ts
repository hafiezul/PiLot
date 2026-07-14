import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  resizeImage,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { copyFile } from "node:fs/promises";
import path from "node:path";
import { builtInTuiCommand } from "../shared/actions.js";
import { detectSupportedImageMimeType, MAXIMUM_IMAGE_BYTES, MAXIMUM_IMAGES, type CommandEvidence, type CompactionEvidence, type ImageAttachment, type LiveInputMode, type RetryEvidence, type RunEvidence, type RunEvidenceItem, type RunStatus, type TaskRunState } from "../shared/projects.js";
import { assertExecutionAllowed } from "./projects.js";
import { loadTaskResources } from "./resources.js";
import { assertRunnableTask, forkChangedTask as forkTaskSnapshot, getTaskSessionSelection, withTaskWrite } from "./tasks.js";
import { assertTaskCurrent, getTaskContinuity, guardTaskManager, reloadTaskContinuity, watchTask } from "./continuity.js";
import { cloneActivePath, forkFromPrompt, historyLabel, historyNavigationType, navigateWithoutSummary, taskHistoryState } from "./history.js";

const runMetadataType = "pilot.run";
const retryMetadataType = "pilot.retry";
const compactionMetadataType = "pilot.compaction";
const maximumOutputCharacters = 12_000;

type PreparedImage = { type: "image"; data: string; mimeType: string };

function assertDesktopPrompt(text: string) {
  const tuiCommand = builtInTuiCommand(text);
  if (tuiCommand) throw new Error(`/${tuiCommand} is a Pi terminal command. Use PiLot's menus or Command Palette instead.`);
}

type ActiveRun = {
  project: string;
  executionPath: string;
  state: TaskRunState;
  runId: string;
  session?: AgentSession;
  abortRequested: boolean;
  accepted: boolean;
  settled: boolean;
  lastError?: string;
  assistantSequence: number;
  retrySequence?: number;
  activeRetryId?: string;
  compactionSequence: number;
  activeCompactionId?: string;
  manager?: SessionManager;
  externalChanged: boolean;
};

type ResultView = {
  output: string;
  details?: string;
  outputTruncated: boolean;
  fullOutputPath?: string;
};

async function prepareImages(images: ImageAttachment[]): Promise<PreparedImage[]> {
  if (images.length > MAXIMUM_IMAGES) throw new Error(`Attach no more than ${MAXIMUM_IMAGES} images at once`);
  return Promise.all(images.map(async (image) => {
    if (!image || typeof image.name !== "string" || typeof image.data !== "string" || typeof image.size !== "number") {
      throw new Error("An image attachment is malformed");
    }
    if (image.size <= 0 || image.size > MAXIMUM_IMAGE_BYTES || image.data.length > Math.ceil(MAXIMUM_IMAGE_BYTES / 3) * 4 + 4) {
      throw new Error(`${image.name || "Image"} must be 20 MB or smaller`);
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) throw new Error(`${image.name || "Image"} is malformed`);
    const bytes = Buffer.from(image.data, "base64");
    if (bytes.length !== image.size) throw new Error(`${image.name || "Image"} is malformed`);
    const mimeType = detectSupportedImageMimeType(bytes);
    if (!mimeType) throw new Error(`${image.name || "Image"} is not a supported PNG, JPEG, GIF, or WebP image`);
    const resized = await resizeImage(bytes, mimeType);
    if (!resized) throw new Error(`${image.name || "Image"} could not be prepared within Pi's image size limit`);
    return { type: "image", data: resized.data, mimeType: resized.mimeType };
  }));
}

function contentText(content: unknown, type = "text") {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => part && typeof part === "object" && (part as { type?: string }).type === type
    ? [type === "thinking" ? (part as { thinking?: unknown }).thinking : (part as { text?: unknown }).text]
    : []).filter((part): part is string => typeof part === "string").join("");
}

function boundedOutput(output: string) {
  return output.length <= maximumOutputCharacters
    ? { output, outputTruncated: false }
    : { output: output.slice(-maximumOutputCharacters), outputTruncated: true };
}

function resultView(value: unknown): ResultView {
  if (!value || typeof value !== "object") return { output: "", outputTruncated: false };
  const result = value as { content?: unknown; details?: unknown };
  const bounded = boundedOutput(contentText(result.content));
  const details = result.details && typeof result.details === "object"
    ? result.details as { fullOutputPath?: unknown; truncation?: { truncated?: unknown } }
    : undefined;
  return {
    ...bounded,
    ...(result.details === undefined ? {} : { details: printable(result.details) }),
    outputTruncated: bounded.outputTruncated || details?.truncation?.truncated === true,
    ...(typeof details?.fullOutputPath === "string" ? { fullOutputPath: details.fullOutputPath } : {}),
  };
}

function printable(value: unknown) {
  try { return JSON.stringify(value ?? {}, null, 2); } catch { return String(value); }
}

function toolSummary(name: string, args: unknown) {
  const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const subject = input.path ?? input.command ?? input.pattern ?? input.query;
  if (typeof subject !== "string" || !subject) return name;
  const compact = subject.replace(/\s+/g, " ").trim();
  return `${name} · ${compact.length > 90 ? `${compact.slice(0, 89)}…` : compact}`;
}

function toolChangedFiles(name: string, args: unknown, executionPath: string) {
  if (name !== "edit" && name !== "write") return;
  const value = args && typeof args === "object" ? (args as { path?: unknown }).path : undefined;
  if (typeof value !== "string" || !value) return;
  const relative = path.relative(executionPath, path.resolve(executionPath, value));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
  return [relative.split(path.sep).join("/")];
}

function currentRun(active: ActiveRun) {
  return active.state.runs.find(({ id }) => id === active.runId)!;
}

function hasExternalChange(active: ActiveRun) {
  const externalChange = getTaskContinuity(active.state.taskPath);
  if (!externalChange) return active.externalChanged;
  active.externalChanged = true;
  active.state = { ...active.state, externalChange };
  return true;
}

function runStatus(active: ActiveRun, status: RunStatus): RunStatus {
  return hasExternalChange(active) ? "interrupted" : status;
}

function persistRunOutcome(active: ActiveRun) {
  if (!active.accepted || hasExternalChange(active)) return;
  const run = currentRun(active);
  const failure = [...run.items].reverse().find((item) => item.kind === "notice" && item.tone === "error");
  active.manager?.appendCustomEntry(runMetadataType, {
    version: 1,
    runId: active.runId,
    outcome: run.status,
    ...(failure?.kind === "notice" && failure.detail ? { error: failure.detail } : {}),
  });
}

function interruptRun(run: RunEvidence): RunEvidence {
  return {
    ...run,
    status: "interrupted",
    items: run.items.map((item) => item.kind === "tool" && item.status === "running"
      ? { ...item, status: "interrupted" }
      : item.kind === "command" && item.status === "running" ? { ...item, status: "interrupted" } : item),
  };
}

function updateRun(active: ActiveRun, update: (run: RunEvidence) => RunEvidence) {
  active.state = {
    ...active.state,
    runs: active.state.runs.map((run) => run.id === active.runId ? update(run) : run),
  };
}

function appendItem(active: ActiveRun, item: RunEvidenceItem) {
  updateRun(active, (run) => ({ ...run, items: [...run.items, item] }));
}

function replaceItem(active: ActiveRun, id: string, update: (item: RunEvidenceItem) => RunEvidenceItem) {
  updateRun(active, (run) => ({
    ...run,
    items: run.items.map((item) => item.id === id ? update(item) : item),
  }));
}

function addNotice(active: ActiveRun, id: string, tone: "attention" | "error", title: string, detail?: string) {
  const existing = currentRun(active).items.some((item) => item.id === id);
  if (existing) replaceItem(active, id, () => ({ id, kind: "notice", tone, title, detail }));
  else appendItem(active, { id, kind: "notice", tone, title, detail });
}

function persistRetry(active: ActiveRun, retry: RetryEvidence) {
  if (hasExternalChange(active)) return;
  active.manager?.appendCustomEntry(retryMetadataType, {
    version: 1,
    attempt: retry.attempt,
    maxAttempts: retry.maxAttempts,
    delayMs: retry.delayMs,
    error: retry.error,
    status: retry.status,
    finalError: retry.finalError,
  });
}

function retryEvidence(id: string, data: Record<string, unknown>): RunEvidenceItem | undefined {
  if (typeof data.attempt !== "number" || typeof data.maxAttempts !== "number" || typeof data.delayMs !== "number"
    || typeof data.error !== "string" || (data.status !== "succeeded" && data.status !== "failed")) return;
  return {
    id,
    kind: "retry",
    attempt: data.attempt,
    maxAttempts: data.maxAttempts,
    delayMs: data.delayMs,
    error: data.error,
    status: data.status,
    ...(typeof data.finalError === "string" ? { finalError: data.finalError } : {}),
  };
}

function compactionEvidence(id: string, data: Record<string, unknown>): CompactionEvidence | undefined {
  const reason = data.reason;
  const status = data.status;
  if ((reason !== "manual" && reason !== "threshold" && reason !== "overflow")
    || (status !== "running" && status !== "succeeded" && status !== "failed" && status !== "aborted")) return;
  return {
    id,
    kind: "compaction",
    reason,
    status,
    ...(typeof data.summary === "string" ? { summary: data.summary } : {}),
    ...(typeof data.tokensBefore === "number" ? { tokensBefore: data.tokensBefore } : {}),
    ...(typeof data.estimatedTokensAfter === "number" ? { estimatedTokensAfter: data.estimatedTokensAfter } : {}),
    ...(typeof data.error === "string" ? { error: data.error } : {}),
  };
}

function savedState(taskPath: string, manager: SessionManager, executionPath: string): TaskRunState {
  const runs: RunEvidence[] = [];
  const started = new Set<string>();
  const completed = new Set<string>();
  const awaitingInput = new Set<string>();
  let current: RunEvidence | undefined;

  for (const entry of manager.getBranch()) {
    if (entry.type === "message") {
      const message = entry.message as unknown as {
        role?: string;
        content?: unknown;
        command?: string;
        output?: string;
        exitCode?: number;
        cancelled?: boolean;
        truncated?: boolean;
        fullOutputPath?: string;
        excludeFromContext?: boolean;
        toolCallId?: string;
        toolName?: string;
        details?: unknown;
        isError?: boolean;
        stopReason?: string;
        errorMessage?: string;
      };
      if (message.role === "user") {
        if (current?.input.kind === "prompt" && awaitingInput.delete(current.id)) {
          current.input = { kind: "prompt", text: contentText(message.content) };
        } else {
          current = {
            id: entry.id,
            status: "preparing",
            startedAt: entry.timestamp,
            input: { kind: "prompt", text: contentText(message.content) },
            items: [],
          };
          runs.push(current);
        }
      } else if (message.role === "bashExecution" && typeof message.command === "string") {
        const status = message.cancelled ? "aborted" : message.exitCode && message.exitCode !== 0 ? "failed" : "settled";
        const view = boundedOutput(message.output ?? "");
        const item: CommandEvidence = {
          id: entry.id,
          kind: "command",
          command: message.command,
          output: view.output,
          status: message.cancelled ? "aborted" : message.exitCode && message.exitCode !== 0 ? "failed" : "succeeded",
          includeInContext: !message.excludeFromContext,
          outputTruncated: view.outputTruncated || message.truncated,
          fullOutputPath: message.fullOutputPath,
        };
        if (current?.input.kind === "command" && awaitingInput.delete(current.id)) {
          current.status = status;
          current.input = { kind: "command", text: message.command, includeInContext: !message.excludeFromContext };
          current.items = [item];
        } else {
          current = {
            id: entry.id,
            status,
            startedAt: entry.timestamp,
            input: { kind: "command", text: message.command, includeInContext: !message.excludeFromContext },
            items: [item],
          };
          runs.push(current);
        }
      } else if (message.role === "assistant" && current) {
        const text = contentText(message.content);
        const thinking = contentText(message.content, "thinking");
        if (text || thinking) current.items.push({ id: entry.id, kind: "assistant", text, thinking });
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (!block || typeof block !== "object" || (block as { type?: string }).type !== "toolCall") continue;
            const tool = block as { id?: string; name?: string; arguments?: unknown };
            if (!tool.id || !tool.name) continue;
            const changedFiles = toolChangedFiles(tool.name, tool.arguments, executionPath);
            current.items.push({
              id: tool.id,
              kind: "tool",
              name: tool.name,
              summary: toolSummary(tool.name, tool.arguments),
              input: printable(tool.arguments),
              output: "",
              ...(changedFiles ? { changedFiles } : {}),
              status: "running",
            });
          }
        }
        if (message.stopReason === "error" && message.errorMessage) {
          current.items.push({ id: `${entry.id}-error`, kind: "notice", tone: "error", title: "Pi failed", detail: message.errorMessage });
          current.status = "failed";
        }
        if (message.stopReason === "aborted") current.status = "aborted";
      } else if (message.role === "toolResult" && current && message.toolCallId) {
        const view = resultView({ content: message.content, details: message.details });
        current.items = current.items.map((item) => item.kind === "tool" && item.id === message.toolCallId ? {
          ...item,
          ...view,
          name: message.toolName ?? item.name,
          status: message.isError ? "failed" : "succeeded",
        } : item);
      }
      continue;
    }

    if (entry.type !== "custom" || !entry.data || typeof entry.data !== "object") continue;
    const data = entry.data as Record<string, unknown>;
    if (entry.customType === runMetadataType) {
      const runId = typeof data.runId === "string" ? data.runId : undefined;
      const inputKind = data.inputKind;
      if (runId && (inputKind === "prompt" || inputKind === "command" || inputKind === "compaction") && !runs.some(({ id }) => id === runId)) {
        const input = typeof data.input === "string" ? data.input : inputKind === "compaction" ? "Compact context" : "Interrupted input";
        current = {
          id: runId,
          status: inputKind === "compaction" ? "compacting" : inputKind === "command" ? "running" : "preparing",
          startedAt: typeof data.startedAt === "string" ? data.startedAt : entry.timestamp,
          input: inputKind === "command"
            ? { kind: "command", text: input, includeInContext: data.includeInContext !== false }
            : { kind: inputKind, text: input },
          items: inputKind === "command" ? [{
            id: `${runId}-command`,
            kind: "command",
            command: input,
            output: "",
            status: "running",
            includeInContext: data.includeInContext !== false,
          }] : [],
        };
        runs.push(current);
        started.add(runId);
        if (inputKind !== "compaction") awaitingInput.add(runId);
      }
      const outcome = String(data.outcome);
      const target = runId ? runs.find(({ id }) => id === runId) : current;
      if (target && ["settled", "failed", "aborted", "interrupted"].includes(outcome)) {
        target.status = outcome as RunStatus;
        completed.add(target.id);
        if (typeof data.error === "string" && !target.items.some((item) => item.kind === "notice" && item.detail === data.error)) {
          target.items.push({
            id: `${entry.id}-failure`,
            kind: "notice",
            tone: "error",
            title: target.input.kind === "compaction" ? "Compaction failed" : "Run failed",
            detail: data.error,
          });
        }
      }
      continue;
    }
    if (entry.customType === retryMetadataType && current) {
      const item = retryEvidence(entry.id, data);
      if (item) current.items.push(item);
    } else if (entry.customType === compactionMetadataType && current) {
      const item = compactionEvidence(entry.id, data);
      if (item) current.items.push(item);
    }
  }

  for (const [index, run] of runs.entries()) {
    if (started.has(run.id) && !completed.has(run.id)) {
      runs[index] = interruptRun(run);
    } else if (run.status === "preparing") {
      run.status = run.items.some((item) => item.kind === "assistant" || item.kind === "tool") ? "settled" : "interrupted";
    }
  }
  return { taskPath, runs };
}

export class LocalRunCoordinator {
  private activeTasks = new Map<string, ActiveRun>();
  private activeProjects = new Set<string>();
  private observedTasks = new Set<string>();
  private taskStates = new Map<string, TaskRunState>();
  private taskHistories = new Map<string, ReturnType<typeof taskHistoryState>>();

  constructor(
    private userData: string,
    private agentDir: string,
    private emit: (state: TaskRunState) => void,
  ) {}

  private publish(state: TaskRunState) {
    this.taskStates.set(path.resolve(state.taskPath), state);
    this.emit(state);
  }

  private observe(file: string) {
    const resolved = path.resolve(file);
    if (!this.observedTasks.has(resolved)) {
      this.observedTasks.add(resolved);
      watchTask(resolved, () => this.handleExternalChange(resolved));
    }
    return getTaskContinuity(resolved);
  }

  private finishRun(file: string, project: string, active: ActiveRun) {
    this.activeTasks.delete(file);
    this.activeProjects.delete(project);
    if (!active.externalChanged && active.manager) this.taskHistories.set(file, taskHistoryState(file, active.manager));
    this.publish({ ...active.state, activeRunId: undefined });
  }

  private handleExternalChange(file: string) {
    const externalChange = getTaskContinuity(file);
    if (!externalChange) return;
    const active = this.activeTasks.get(file);
    if (active) {
      active.externalChanged = true;
      active.state = { ...active.state, externalChange };
      updateRun(active, interruptRun);
      active.session?.clearQueue();
      active.session?.abortRetry();
      active.session?.abortBash();
      active.session?.abortCompaction();
      void active.session?.abort().catch(() => undefined);
      this.publish(active.state);
      return;
    }
    const saved = this.taskStates.get(file);
    if (saved) this.publish({ ...saved, activeRunId: undefined, externalChange });
  }

  private async mutateTaskHistory<T>(projectPath: string, taskPath: string, operation: (context: { file: string; project: string; executionPath: string }) => Promise<T>) {
    const context = await assertRunnableTask(this.agentDir, projectPath, taskPath);
    SessionManager.open(context.file);
    this.observe(context.file);
    assertTaskCurrent(context.file);
    if (this.activeProjects.has(context.project)) throw new Error("Stop the active Run before changing Task history");
    this.activeProjects.add(context.project);
    try {
      return await withTaskWrite(context.file, () => operation(context));
    } finally {
      this.activeProjects.delete(context.project);
    }
  }

  async getTaskRun(projectPath: string, taskPath: string) {
    const active = this.activeTasks.get(path.resolve(taskPath));
    if (active) return active.state;
    const { file, executionPath } = await assertRunnableTask(this.agentDir, projectPath, taskPath);
    const manager = SessionManager.open(file);
    const externalChange = this.observe(file);
    const cached = this.taskStates.get(file);
    if (externalChange && cached) return { ...cached, activeRunId: undefined, externalChange };
    assertTaskCurrent(file);
    return withTaskWrite(file, async () => {
      const state = savedState(file, manager, executionPath);
      const changed = getTaskContinuity(file);
      const next = changed ? { ...state, externalChange: changed } : state;
      this.taskStates.set(file, next);
      return next;
    });
  }

  async reloadTask(projectPath: string, taskPath: string) {
    const { file, executionPath } = await assertRunnableTask(this.agentDir, projectPath, taskPath);
    if (this.activeTasks.has(file)) throw new Error("Wait for the interrupted Run to stop before reloading this Task");
    return withTaskWrite(file, async () => {
      const manager = SessionManager.open(file);
      reloadTaskContinuity(file);
      const state = savedState(file, manager, executionPath);
      this.taskStates.set(file, state);
      this.taskHistories.set(file, taskHistoryState(file, manager));
      this.publish(state);
      return state;
    });
  }

  async forkChangedTask(projectPath: string, taskPath: string) {
    await assertExecutionAllowed(this.userData, projectPath);
    const file = path.resolve(taskPath);
    if (this.activeTasks.has(file)) throw new Error("Wait for the interrupted Run to stop before forking this Task");
    return withTaskWrite(file, () => forkTaskSnapshot(this.agentDir, projectPath, file));
  }

  async getTaskHistory(projectPath: string, taskPath: string) {
    const { file, executionPath } = await assertRunnableTask(this.agentDir, projectPath, taskPath);
    const manager = SessionManager.open(file);
    const externalChange = this.observe(file);
    if (!this.taskStates.has(file)) {
      const state = savedState(file, manager, executionPath);
      const next = externalChange ? { ...state, externalChange } : state;
      this.taskStates.set(file, next);
      if (externalChange) this.publish(next);
    }
    if (externalChange && this.taskHistories.has(file)) return this.taskHistories.get(file)!;
    assertTaskCurrent(file);
    const active = this.activeTasks.get(file);
    const history = active?.manager
      ? taskHistoryState(file, active.manager)
      : active
        ? taskHistoryState(file, manager)
        : await withTaskWrite(file, async () => taskHistoryState(file, manager));
    this.taskHistories.set(file, history);
    return history;
  }

  async setTaskHistoryLabel(projectPath: string, taskPath: string, entryId: string, value?: string) {
    const label = historyLabel(value);
    return this.mutateTaskHistory(projectPath, taskPath, async ({ file }) => {
      const manager = guardTaskManager(file, SessionManager.open(file));
      if (!manager.getEntry(entryId)) throw new Error("Choose an available history entry");
      manager.appendLabelChange(entryId, label);
      const history = taskHistoryState(file, manager);
      this.taskHistories.set(file, history);
      return history;
    });
  }

  async forkTaskFromHistory(projectPath: string, taskPath: string, entryId: string) {
    await assertExecutionAllowed(this.userData, projectPath);
    return this.mutateTaskHistory(projectPath, taskPath, async ({ file, project }) =>
      forkFromPrompt(file, project, guardTaskManager(file, SessionManager.open(file)), entryId));
  }

  async cloneTaskHistory(projectPath: string, taskPath: string) {
    await assertExecutionAllowed(this.userData, projectPath);
    return this.mutateTaskHistory(projectPath, taskPath, async ({ file, project }) =>
      cloneActivePath(file, project, guardTaskManager(file, SessionManager.open(file))));
  }

  async navigateTaskHistory(projectPath: string, taskPath: string, entryId: string, summarize: boolean, customInstructions?: string) {
    const instructions = customInstructions?.trim();
    if (instructions && instructions.length > 2_000) throw new Error("Summary focus must be 2,000 characters or fewer");
    if (summarize) await assertExecutionAllowed(this.userData, projectPath);
    return this.mutateTaskHistory(projectPath, taskPath, async ({ file, executionPath }) => {
      if (!summarize) {
        const manager = guardTaskManager(file, SessionManager.open(file));
        const editorText = navigateWithoutSummary(manager, entryId);
        const history = taskHistoryState(file, manager);
        this.taskHistories.set(file, history);
        return { history, ...(editorText === undefined ? {} : { editorText }) };
      }

      const auth = AuthStorage.create(path.join(this.agentDir, "auth.json"));
      const models = ModelRegistry.create(auth, path.join(this.agentDir, "models.json"));
      if (models.getError()) throw new Error(`Fix models.json before summarizing Task history: ${models.getError()}`);
      if (!models.getAvailable().length) throw new Error("Connect a provider in Settings before summarizing Task history");
      const { session, manager } = await this.createSession(executionPath, file, auth, models);
      try {
        const result = await session.navigateTree(entryId, { summarize: true, ...(instructions ? { customInstructions: instructions } : {}) });
        if (result.cancelled) throw new Error(result.aborted ? "Branch summarization was stopped" : "History navigation was cancelled");
        if (!result.summaryEntry) manager.appendCustomEntry(historyNavigationType, { version: 1, targetId: entryId });
        const history = taskHistoryState(file, manager);
        this.taskHistories.set(file, history);
        return { history, ...(result.editorText === undefined ? {} : { editorText: result.editorText }) };
      } finally {
        session.dispose();
      }
    });
  }

  async submitPrompt(projectPath: string, taskPath: string, prompt: string, images: ImageAttachment[] = []) {
    const text = prompt.trim();
    if (!text) throw new Error("Enter a prompt");
    assertDesktopPrompt(text);
    await assertExecutionAllowed(this.userData, projectPath);
    const { file, project, executionPath } = await assertRunnableTask(this.agentDir, projectPath, taskPath);
    const manager = SessionManager.open(file);
    this.observe(file);
    assertTaskCurrent(file);
    const preparedImages = await prepareImages(images);
    if (this.activeProjects.has(project)) throw new Error("Another Local Task is already running in this Project");

    const auth = AuthStorage.create(path.join(this.agentDir, "auth.json"));
    const models = ModelRegistry.create(auth, path.join(this.agentDir, "models.json"));
    if (models.getError()) throw new Error(`Fix models.json before running this Task: ${models.getError()}`);
    if (!models.getAvailable().length) throw new Error("Connect a provider in Settings before running this Task");

    const run: RunEvidence = {
      id: randomUUID(),
      status: "preparing",
      startedAt: new Date().toISOString(),
      input: { kind: "prompt", text },
      items: [],
    };
    const saved = savedState(file, manager, executionPath);
    const active: ActiveRun = {
      project,
      executionPath,
      state: { ...saved, activeRunId: run.id, runs: [...saved.runs, run], queues: { steering: [], followUp: [] } },
      runId: run.id,
      abortRequested: false,
      accepted: false,
      settled: false,
      assistantSequence: 0,
      compactionSequence: 0,
      externalChanged: false,
    };
    this.activeProjects.add(project);
    this.activeTasks.set(file, active);
    this.publish(active.state);

    try {
      await withTaskWrite(file, async () => {
        const { session, manager } = await this.createSession(executionPath, file, auth, models);
        active.session = session;
        active.manager = manager;
        const unsubscribe = session.subscribe((event) => this.handleEvent(active, event));
        await session.bindExtensions({ onError: (error) => {
          addNotice(active, `resource-${randomUUID()}`, "attention", "Pi resource unavailable", error.error);
          this.publish(active.state);
        } });
        try {
          if (active.abortRequested) {
            updateRun(active, (value) => ({ ...value, status: runStatus(active, "aborted") }));
          } else {
            await session.prompt(text, { images: preparedImages, preflightResult: (accepted) => {
              if (!accepted || active.accepted) return;
              manager.appendCustomEntry(runMetadataType, {
                version: 1,
                runId: run.id,
                inputKind: "prompt",
                input: text,
                startedAt: run.startedAt,
                outcome: "running",
              });
              active.accepted = true;
            } });
            if (!active.settled) updateRun(active, (value) => ({
              ...value,
              status: runStatus(active, active.abortRequested ? "aborted" : active.lastError ? "failed" : "settled"),
            }));
          }
          persistRunOutcome(active);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          updateRun(active, (value) => ({ ...value, status: runStatus(active, active.abortRequested ? "aborted" : "failed") }));
          if (!hasExternalChange(active) && !active.abortRequested) addNotice(active, `${run.id}-failure`, "error", "Run failed", detail);
          persistRunOutcome(active);
        } finally {
          unsubscribe();
          session.dispose();
        }
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      updateRun(active, (value) => ({ ...value, status: runStatus(active, active.abortRequested ? "aborted" : "failed") }));
      if (!hasExternalChange(active) && !active.abortRequested) addNotice(active, `${run.id}-failure`, "error", "Run failed", detail);
    } finally {
      this.finishRun(file, project, active);
    }
  }

  async queuePrompt(taskPath: string, prompt: string, mode: LiveInputMode) {
    const text = prompt.trim();
    if (!text) throw new Error("Enter a prompt");
    assertDesktopPrompt(text);
    const file = path.resolve(taskPath);
    assertTaskCurrent(file);
    const active = this.activeTasks.get(file);
    if (!active || currentRun(active).input.kind !== "prompt") throw new Error("This Task has no active agent Run");
    if (!active.session || !active.session.isStreaming || active.abortRequested) throw new Error("The Run is not ready for live input");
    await (mode === "steer" ? active.session.steer(text) : active.session.followUp(text));
  }

  async executeCommand(projectPath: string, taskPath: string, command: string, includeInContext: boolean) {
    const text = command.trim();
    if (!text) throw new Error("Enter a command");
    await assertExecutionAllowed(this.userData, projectPath);
    const { file, project, executionPath } = await assertRunnableTask(this.agentDir, projectPath, taskPath);
    const manager = SessionManager.open(file);
    this.observe(file);
    assertTaskCurrent(file);
    if (this.activeProjects.has(project)) throw new Error("Another Local Task is already running in this Project");

    const run: RunEvidence = {
      id: randomUUID(),
      status: "running",
      startedAt: new Date().toISOString(),
      input: { kind: "command", text, includeInContext },
      items: [{ id: "command", kind: "command", command: text, output: "", status: "running", includeInContext }],
    };
    const saved = savedState(file, manager, executionPath);
    const active: ActiveRun = {
      project,
      executionPath,
      state: { ...saved, activeRunId: run.id, runs: [...saved.runs, run] },
      runId: run.id,
      abortRequested: false,
      accepted: true,
      settled: false,
      assistantSequence: 0,
      compactionSequence: 0,
      externalChanged: false,
    };
    this.activeProjects.add(project);
    this.activeTasks.set(file, active);
    this.publish(active.state);

    try {
      await withTaskWrite(file, async () => {
        const auth = AuthStorage.create(path.join(this.agentDir, "auth.json"));
        const models = ModelRegistry.create(auth, path.join(this.agentDir, "models.json"));
        const { session, manager } = await this.createSession(executionPath, file, auth, models);
        active.session = session;
        active.manager = manager;
        manager.appendCustomEntry(runMetadataType, {
          version: 1,
          runId: run.id,
          inputKind: "command",
          input: text,
          includeInContext,
          startedAt: run.startedAt,
          outcome: "running",
        });
        try {
          const result = await session.executeBash(text, (chunk) => {
            replaceItem(active, "command", (item) => {
              if (item.kind !== "command") return item;
              const view = boundedOutput(item.output + chunk);
              return { ...item, ...view };
            });
            this.publish(active.state);
          }, { excludeFromContext: !includeInContext });
          replaceItem(active, "command", (item) => item.kind === "command" ? {
            ...item,
            ...boundedOutput(result.output),
            status: result.cancelled ? "aborted" : result.exitCode && result.exitCode !== 0 ? "failed" : "succeeded",
            outputTruncated: result.truncated,
            fullOutputPath: result.fullOutputPath,
          } : item);
          updateRun(active, (value) => ({
            ...value,
            status: runStatus(active, result.cancelled ? "aborted" : result.exitCode && result.exitCode !== 0 ? "failed" : "settled"),
          }));
          persistRunOutcome(active);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          const output = currentRun(active).items.find((item) => item.kind === "command")?.output ?? "";
          if (!hasExternalChange(active)) session.recordBashResult(text, {
            output: [output, active.abortRequested ? "Command aborted" : detail].filter(Boolean).join("\n"),
            exitCode: undefined,
            cancelled: active.abortRequested,
            truncated: false,
          }, { excludeFromContext: !includeInContext });
          replaceItem(active, "command", (item) => item.kind === "command" ? {
            ...item,
            output: hasExternalChange(active) ? item.output : [item.output, active.abortRequested ? "Command aborted" : detail].filter(Boolean).join("\n"),
            status: hasExternalChange(active) ? item.status : active.abortRequested ? "aborted" : "failed",
          } : item);
          updateRun(active, (value) => ({ ...value, status: runStatus(active, active.abortRequested ? "aborted" : "failed") }));
          persistRunOutcome(active);
        } finally {
          session.dispose();
        }
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (!hasExternalChange(active)) replaceItem(active, "command", (item) => item.kind === "command" ? { ...item, output: detail, status: "failed" } : item);
      updateRun(active, (value) => ({ ...value, status: runStatus(active, "failed") }));
    } finally {
      this.finishRun(file, project, active);
    }
  }

  async compactTask(projectPath: string, taskPath: string) {
    await assertExecutionAllowed(this.userData, projectPath);
    const { file, project, executionPath } = await assertRunnableTask(this.agentDir, projectPath, taskPath);
    const manager = SessionManager.open(file);
    this.observe(file);
    assertTaskCurrent(file);
    if (this.activeProjects.has(project)) throw new Error("Another Local Task is already running in this Project");

    const auth = AuthStorage.create(path.join(this.agentDir, "auth.json"));
    const models = ModelRegistry.create(auth, path.join(this.agentDir, "models.json"));
    if (models.getError()) throw new Error(`Fix models.json before compacting this Task: ${models.getError()}`);
    if (!models.getAvailable().length) throw new Error("Connect a provider in Settings before compacting this Task");

    const run: RunEvidence = {
      id: randomUUID(),
      status: "compacting",
      startedAt: new Date().toISOString(),
      input: { kind: "compaction", text: "Compact context" },
      items: [],
    };
    const saved = savedState(file, manager, executionPath);
    const active: ActiveRun = {
      project,
      executionPath,
      state: { ...saved, activeRunId: run.id, runs: [...saved.runs, run] },
      runId: run.id,
      abortRequested: false,
      accepted: true,
      settled: false,
      assistantSequence: 0,
      compactionSequence: 0,
      externalChanged: false,
    };
    this.activeProjects.add(project);
    this.activeTasks.set(file, active);
    this.publish(active.state);

    try {
      await withTaskWrite(file, async () => {
        const { session, manager } = await this.createSession(executionPath, file, auth, models);
        active.session = session;
        active.manager = manager;
        const unsubscribe = session.subscribe((event) => this.handleEvent(active, event));
        manager.appendCustomEntry(runMetadataType, {
          version: 1,
          runId: run.id,
          inputKind: "compaction",
          input: "Compact context",
          startedAt: run.startedAt,
          outcome: "running",
        });
        try {
          const branch = manager.getBranch();
          const lastCompaction = branch.map(({ type }) => type).lastIndexOf("compaction");
          if (lastCompaction >= 0 && !branch.slice(lastCompaction + 1).some(({ type }) =>
            type === "message" || type === "custom_message" || type === "branch_summary")) {
            throw new Error("Already compacted; add more Task history before compacting again");
          }
          await session.compact();
          updateRun(active, (value) => ({ ...value, status: runStatus(active, "settled") }));
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          updateRun(active, (value) => ({ ...value, status: runStatus(active, active.abortRequested ? "aborted" : "failed") }));
          if (!hasExternalChange(active) && !currentRun(active).items.some((item) => item.kind === "compaction" && item.status === "failed")) {
            addNotice(active, `${run.id}-failure`, "error", "Compaction failed", detail);
          }
        } finally {
          persistRunOutcome(active);
          unsubscribe();
          session.dispose();
        }
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      updateRun(active, (value) => ({ ...value, status: runStatus(active, active.abortRequested ? "aborted" : "failed") }));
      if (!hasExternalChange(active) && !active.abortRequested) addNotice(active, `${run.id}-failure`, "error", "Compaction failed", detail);
    } finally {
      this.finishRun(file, project, active);
    }
  }

  async exportTask(projectPath: string, taskPath: string, format: "jsonl" | "html", outputPath: string) {
    const { file, executionPath } = await assertRunnableTask(this.agentDir, projectPath, taskPath);
    if (this.activeTasks.has(file)) throw new Error("Stop the active Run before exporting this Task");
    if (format === "jsonl") {
      await copyFile(file, outputPath);
      return;
    }
    const auth = AuthStorage.create(path.join(this.agentDir, "auth.json"));
    const models = ModelRegistry.create(auth, path.join(this.agentDir, "models.json"));
    const { session } = await this.createSession(executionPath, file, auth, models);
    try {
      await session.exportToHtml(outputPath);
    } finally {
      session.dispose();
    }
  }

  async abortRetry(taskPath: string) {
    this.activeTasks.get(path.resolve(taskPath))?.session?.abortRetry();
  }

  async abortTask(taskPath: string) {
    const active = this.activeTasks.get(path.resolve(taskPath));
    if (!active) return;
    active.abortRequested = true;
    const queued = active.session?.clearQueue();
    const recoveredInput = queued ? [...queued.steering, ...queued.followUp].join("\n\n") : "";
    if (recoveredInput) {
      active.state = { ...active.state, recoveredInput };
      this.publish(active.state);
      active.state = { ...active.state, recoveredInput: undefined };
    }
    active.session?.abortRetry();
    active.session?.abortBash();
    active.session?.abortCompaction();
    await active.session?.abort();
    updateRun(active, (run) => ({ ...run, status: runStatus(active, "aborted") }));
  }

  async abortAll() {
    await Promise.all([...this.activeTasks].map(([taskPath]) => this.abortTask(taskPath)));
  }

  private async createSession(executionPath: string, file: string, auth: AuthStorage, models: ModelRegistry) {
    const { loader: resources, settings } = await loadTaskResources(this.agentDir, executionPath);
    const manager = guardTaskManager(file, SessionManager.open(file));
    const { session } = await createAgentSession({
      cwd: executionPath,
      agentDir: this.agentDir,
      authStorage: auth,
      modelRegistry: models,
      settingsManager: settings,
      resourceLoader: resources,
      sessionManager: manager,
      ...getTaskSessionSelection(manager, models),
    });
    return { session, manager };
  }

  private ensureAssistant(active: ActiveRun, message: unknown) {
    const timestamp = message && typeof message === "object" && typeof (message as { timestamp?: unknown }).timestamp === "number"
      ? (message as { timestamp: number }).timestamp
      : Date.now();
    const id = `assistant-${timestamp}-${active.assistantSequence}`;
    const existing = currentRun(active).items.find((item) => item.id === id);
    if (existing) return id;
    active.assistantSequence += 1;
    appendItem(active, { id, kind: "assistant", text: "", thinking: "" });
    return id;
  }

  private handleEvent(active: ActiveRun, event: AgentSessionEvent) {
    if (hasExternalChange(active)) {
      updateRun(active, interruptRun);
      this.publish(active.state);
      return;
    }
    switch (event.type) {
      case "agent_start":
        updateRun(active, (run) => ({ ...run, status: runStatus(active, "running") }));
        break;
      case "message_start":
        if (event.message.role !== "assistant") return;
        this.ensureAssistant(active, event.message);
        break;
      case "message_update": {
        const update = event.assistantMessageEvent;
        if (update.type !== "text_delta" && update.type !== "thinking_delta") return;
        const id = [...currentRun(active).items].reverse().find((item) => item.kind === "assistant")?.id ?? this.ensureAssistant(active, event.message);
        replaceItem(active, id, (item) => item.kind === "assistant" ? update.type === "text_delta"
          ? { ...item, text: item.text + update.delta }
          : { ...item, thinking: item.thinking + update.delta }
          : item);
        break;
      }
      case "message_end":
        if (event.message.role !== "assistant") return;
        if (event.message.stopReason === "error") active.lastError = event.message.errorMessage ?? "The provider failed";
        else if (event.message.stopReason === "aborted") active.abortRequested = true;
        else active.lastError = undefined;
        break;
      case "agent_settled": {
        active.settled = true;
        const hasLifecycleFailure = currentRun(active).items.some((item) =>
          (item.kind === "retry" || item.kind === "compaction") && item.status === "failed");
        if (!hasExternalChange(active) && active.lastError && !hasLifecycleFailure) {
          addNotice(active, `${active.runId}-provider`, "error", "Provider failed", active.lastError);
        }
        updateRun(active, (run) => ({
          ...run,
          status: runStatus(active, active.abortRequested ? "aborted" : active.lastError ? "failed" : "settled"),
        }));
        break;
      }
      case "tool_execution_start": {
        const changedFiles = toolChangedFiles(event.toolName, event.args, active.executionPath);
        appendItem(active, {
          id: event.toolCallId,
          kind: "tool",
          name: event.toolName,
          summary: toolSummary(event.toolName, event.args),
          input: printable(event.args),
          output: "",
          ...(changedFiles ? { changedFiles } : {}),
          status: "running",
        });
        break;
      }
      case "tool_execution_update": {
        const view = resultView(event.partialResult);
        replaceItem(active, event.toolCallId, (item) => item.kind === "tool" ? { ...item, ...view } : item);
        break;
      }
      case "tool_execution_end": {
        const view = resultView(event.result);
        replaceItem(active, event.toolCallId, (item) => item.kind === "tool" ? {
          ...item,
          ...view,
          status: event.isError ? "failed" : "succeeded",
        } : item);
        break;
      }
      case "auto_retry_start": {
        const previous = active.activeRetryId
          ? currentRun(active).items.find((item) => item.id === active.activeRetryId)
          : undefined;
        if (previous?.kind === "retry") {
          const failed: RetryEvidence = { ...previous, status: "failed", finalError: event.errorMessage };
          replaceItem(active, previous.id, () => failed);
          persistRetry(active, failed);
        }
        const id = `retry-${active.retrySequence ?? 0}`;
        active.retrySequence = (active.retrySequence ?? 0) + 1;
        active.activeRetryId = id;
        appendItem(active, {
          id,
          kind: "retry",
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          error: event.errorMessage,
          status: "waiting",
        });
        updateRun(active, (run) => ({ ...run, status: runStatus(active, "retrying") }));
        break;
      }
      case "auto_retry_end": {
        const id = active.activeRetryId;
        if (id) replaceItem(active, id, (item) => item.kind === "retry" ? {
          ...item,
          status: event.success ? "succeeded" : "failed",
          ...(event.finalError ? { finalError: event.finalError } : {}),
        } : item);
        if (event.success) active.lastError = undefined;
        else active.lastError = event.finalError ?? active.lastError ?? "Provider retry failed";
        const retry = id ? currentRun(active).items.find((item) => item.kind === "retry" && item.id === id) : undefined;
        if (retry?.kind === "retry") persistRetry(active, retry);
        active.activeRetryId = undefined;
        break;
      }
      case "queue_update":
        active.state = { ...active.state, queues: { steering: [...event.steering], followUp: [...event.followUp] } };
        break;
      case "compaction_start": {
        const id = `compaction-${event.reason}-${active.compactionSequence++}`;
        active.activeCompactionId = id;
        appendItem(active, { id, kind: "compaction", reason: event.reason, status: "running" });
        updateRun(active, (run) => ({ ...run, status: runStatus(active, "compacting") }));
        break;
      }
      case "compaction_end": {
        const id = active.activeCompactionId
          ?? [...currentRun(active).items].reverse().find((item) => item.kind === "compaction" && item.reason === event.reason)?.id;
        const status = event.aborted ? "aborted" : event.result ? "succeeded" : "failed";
        const item: CompactionEvidence = {
          id: id ?? `compaction-${event.reason}-${active.compactionSequence++}`,
          kind: "compaction",
          reason: event.reason,
          status,
          ...(event.result ? {
            summary: event.result.summary,
            tokensBefore: event.result.tokensBefore,
            ...(event.result.estimatedTokensAfter === undefined ? {} : { estimatedTokensAfter: event.result.estimatedTokensAfter }),
          } : {}),
          ...(event.errorMessage ? { error: event.errorMessage } : {}),
        };
        if (id) replaceItem(active, id, () => item);
        else appendItem(active, item);
        active.activeCompactionId = undefined;
        if (status === "failed") active.lastError = event.errorMessage ?? "Compaction failed";
        if (event.reason !== "manual") updateRun(active, (run) => ({
          ...run,
          status: runStatus(active, status === "failed" ? "failed" : event.willRetry ? "running" : run.status),
        }));
        if (!hasExternalChange(active)) active.manager?.appendCustomEntry(compactionMetadataType, {
          version: 1,
          reason: item.reason,
          status: item.status,
          summary: item.summary,
          tokensBefore: item.tokensBefore,
          estimatedTokensAfter: item.estimatedTokensAfter,
          error: item.error,
        });
        break;
      }
      default:
        return;
    }
    this.publish(active.state);
  }
}
