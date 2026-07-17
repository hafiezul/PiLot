import {
  AuthStorage,
  createAgentSession,
  createBashToolDefinition,
  createLocalBashOperations,
  ModelRegistry,
  resizeImage,
  resolveModelScopeWithDiagnostics,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type BashOperations,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { copyFile } from "node:fs/promises";
import path from "node:path";
import { builtInTuiCommand } from "../shared/actions.js";
import { DEFAULT_GLOBAL_RUN_CAP, MAXIMUM_GLOBAL_RUN_CAP, MINIMUM_GLOBAL_RUN_CAP } from "../shared/preferences.js";
import { detectSupportedImageMimeType, MAXIMUM_IMAGE_BYTES, MAXIMUM_IMAGES, type CommandEvidence, type CompactionEvidence, type ImageAttachment, type LiveInputMode, type RetryEvidence, type RunEvidence, type RunEvidenceItem, type RunStatus, type TaskExecutionLocation, type TaskRunState, type TaskSetupState } from "../shared/projects.js";
import { assertExecutionAllowed } from "./projects.js";
import { loadTaskResources } from "./resources.js";
import { assertReadableTask, assertRunnableTask, forkChangedTask as forkTaskSnapshot, getTaskSessionSelection, withTaskWrite } from "./tasks.js";
import { assertTaskCurrent, getTaskContinuity, guardTaskManager, reloadTaskContinuity, watchTask } from "./continuity.js";
import { cloneCurrentPath, forkFromPrompt, historyLabel, historyNavigationType, navigateWithoutSummary, taskHistoryEntryDetail, taskHistoryState } from "./history.js";
import { mergeEnvironments, prepareProjectShellRuntime, withBashEnvironment, type PreparedShellRuntime } from "./environment.js";

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
  persisted: boolean;
  settled: boolean;
  lastError?: string;
  assistantSequence: number;
  retrySequence?: number;
  activeRetryId?: string;
  compactionSequence: number;
  activeCompactionId?: string;
  manager?: SessionManager;
  externalChanged: boolean;
  commandAbort?: AbortController;
};

type ScheduledRun = {
  file: string;
  active: ActiveRun;
  startingStatus: RunStatus;
  operation(): Promise<void>;
  resolve(): void;
};

type ResultView = {
  output: string;
  details?: string;
  outputTruncated: boolean;
  fullOutputPath?: string;
};

function withRunAbort(operations: BashOperations | undefined, signal: AbortSignal): BashOperations | undefined {
  if (!operations) return;
  return {
    exec: (command, cwd, options) => operations.exec(command, cwd, {
      ...options,
      signal: options.signal ? AbortSignal.any([options.signal, signal]) : signal,
    }),
  };
}

function abortRunProcesses(active: ActiveRun) {
  active.commandAbort?.abort();
  active.session?.abortRetry();
  active.session?.abortBash();
  active.session?.abortCompaction();
  return active.session?.abort() ?? Promise.resolve();
}

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

function assertSetupReady(setup?: Omit<TaskSetupState, "taskPath">) {
  if (setup && setup.status !== "succeeded" && setup.status !== "bypassed") {
    throw new Error("Finish Worktree setup or deliberately continue without it before the first Run");
  }
}

function taskSetup(command?: string): Omit<TaskSetupState, "taskPath"> | undefined {
  return command ? { command, status: "pending", output: "", outputTruncated: false } : undefined;
}

function persistRunOutcome(active: ActiveRun) {
  if (!active.persisted || hasExternalChange(active)) return;
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
      : item.kind === "command" && (item.status === "running" || item.status === "queued") ? { ...item, status: "interrupted" } : item),
  };
}

function updateRun(active: ActiveRun, update: (run: RunEvidence) => RunEvidence) {
  active.state = {
    ...active.state,
    runs: active.state.runs.map((run) => run.id === active.runId ? update(run) : run),
    evidenceRevision: active.state.evidenceRevision + 1,
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
        if (outcome === "aborted") {
          target.items = target.items.map((item) => item.kind === "command" && (item.status === "running" || item.status === "queued")
            ? { ...item, status: "aborted" }
            : item);
        } else if (outcome === "interrupted") {
          target.items = interruptRun(target).items;
        }
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
  return { taskPath, runs, evidenceRevision: 0 };
}

export class RunCoordinator {
  private activeTasks = new Map<string, ActiveRun>();
  private activeExecutionLocations = new Set<string>();
  private observedTasks = new Set<string>();
  private taskStates = new Map<string, TaskRunState>();
  private taskHistories = new Map<string, ReturnType<typeof taskHistoryState>>();
  private pendingRuns: ScheduledRun[] = [];
  private runningRuns = 0;
  private idleWaiters = new Set<() => void>();

  constructor(
    private userData: string,
    private agentDir: string,
    private emit: (state: TaskRunState) => void,
    private environmentForProject: (projectPath: string) => Promise<NodeJS.ProcessEnv>,
    private runLimit = DEFAULT_GLOBAL_RUN_CAP,
  ) {}

  getLiveRunStatus(taskPath: string) {
    const active = this.activeTasks.get(path.resolve(taskPath));
    return active ? currentRun(active).status : undefined;
  }

  getActivity() {
    const runCount = this.activeTasks.size;
    const waitingCount = this.pendingRuns.length;
    return {
      runCount,
      activeCount: Math.max(0, runCount - waitingCount),
      waitingCount,
    };
  }

  setRunLimit(limit: number) {
    if (!Number.isInteger(limit) || limit < MINIMUM_GLOBAL_RUN_CAP || limit > MAXIMUM_GLOBAL_RUN_CAP) {
      throw new Error(`Active Run limit must be between ${MINIMUM_GLOBAL_RUN_CAP} and ${MAXIMUM_GLOBAL_RUN_CAP}`);
    }
    this.runLimit = limit;
    for (const active of this.activeTasks.values()) {
      active.state = { ...active.state, runLimit: limit };
      this.publish(active.state);
    }
    this.dispatchRuns();
  }

  private publish(state: TaskRunState) {
    const next = state.activeRunId ? { ...state, runLimit: this.runLimit } : state;
    this.taskStates.set(path.resolve(next.taskPath), next);
    this.emit(next);
  }

  private observe(file: string) {
    const resolved = path.resolve(file);
    if (!this.observedTasks.has(resolved)) {
      this.observedTasks.add(resolved);
      watchTask(resolved, () => this.handleExternalChange(resolved));
    }
    return getTaskContinuity(resolved);
  }

  private assertExecutionAvailable(executionPath: string, kind: "local" | "worktree") {
    if (this.activeExecutionLocations.has(executionPath)) {
      throw new Error(kind === "local" ? "Another Local Task is already running in this Project" : "Another Task is already running in this Worktree");
    }
  }

  private claimExecution(executionPath: string, kind: "local" | "worktree") {
    this.assertExecutionAvailable(executionPath, kind);
    this.activeExecutionLocations.add(executionPath);
  }

  private runnableTask(projectPath: string, taskPath: string) {
    return this.environmentForProject(projectPath).then((environment) =>
      assertRunnableTask(this.agentDir, projectPath, taskPath, environment));
  }

  private async revalidateExecutionClaim(
    projectPath: string,
    taskPath: string,
    executionPath: string,
    validate?: (context: Awaited<ReturnType<typeof assertRunnableTask>>) => void,
  ) {
    const current = await this.runnableTask(projectPath, taskPath);
    if (current.executionPath !== executionPath) throw new Error("This Task's Execution location changed while starting");
    this.observe(current.file);
    assertTaskCurrent(current.file);
    validate?.(current);
    return current;
  }

  private async persistScheduledRun(active: ActiveRun) {
    const file = path.resolve(active.state.taskPath);
    await withTaskWrite(file, async () => {
      assertTaskCurrent(file);
      const manager = guardTaskManager(file, SessionManager.open(file));
      const run = currentRun(active);
      manager.appendCustomEntry(runMetadataType, {
        version: 1,
        runId: run.id,
        inputKind: run.input.kind,
        input: run.input.text,
        ...(run.input.kind === "command" ? { includeInContext: run.input.includeInContext !== false } : {}),
        startedAt: run.startedAt,
        outcome: "queued",
      });
      active.manager = manager;
      active.persisted = true;
    });
  }

  private async persistStartedRun(active: ActiveRun) {
    const file = path.resolve(active.state.taskPath);
    await withTaskWrite(file, async () => {
      assertTaskCurrent(file);
      const manager = guardTaskManager(file, SessionManager.open(file));
      manager.appendCustomEntry(runMetadataType, { version: 1, runId: active.runId, outcome: "running" });
      active.manager = manager;
    });
  }

  private async scheduleRun(active: ActiveRun, executionKind: "local" | "worktree", startingStatus: RunStatus, operation: () => Promise<void>) {
    const file = path.resolve(active.state.taskPath);
    if (this.activeTasks.has(file)) throw new Error("This Task already has an active or waiting Run");
    this.claimExecution(active.executionPath, executionKind);
    this.activeTasks.set(file, active);
    try {
      await this.persistScheduledRun(active);
    } catch (error) {
      this.activeTasks.delete(file);
      this.activeExecutionLocations.delete(active.executionPath);
      throw error;
    }

    return new Promise<void>((resolve) => {
      updateRun(active, (run) => ({
        ...run,
        status: "queued",
        items: run.items.map((item) => item.kind === "command" && item.status === "running" ? { ...item, status: "queued" } : item),
      }));
      const scheduled: ScheduledRun = { file, active, startingStatus, operation, resolve };
      this.pendingRuns.push(scheduled);
      this.updateQueuePositions();
      this.dispatchRuns();
    });
  }

  private updateQueuePositions() {
    for (const [index, scheduled] of this.pendingRuns.entries()) {
      scheduled.active.state = { ...scheduled.active.state, queuePosition: index + 1, runLimit: this.runLimit };
      this.publish(scheduled.active.state);
    }
  }

  private dispatchRuns() {
    while (this.runningRuns < this.runLimit && this.pendingRuns.length) {
      const scheduled = this.pendingRuns.shift()!;
      this.runningRuns += 1;
      updateRun(scheduled.active, (run) => ({
        ...run,
        status: scheduled.startingStatus,
        items: run.items.map((item) => item.kind === "command" && item.status === "queued" ? { ...item, status: "running" } : item),
      }));
      const { queuePosition: _queuePosition, ...state } = scheduled.active.state;
      scheduled.active.state = { ...state, runLimit: this.runLimit };
      this.publish(scheduled.active.state);
      void assertExecutionAllowed(this.userData, scheduled.active.project)
        .then(() => this.persistStartedRun(scheduled.active))
        .then(() => scheduled.operation())
        .catch((error) => {
          const detail = error instanceof Error ? error.message : String(error);
          updateRun(scheduled.active, (run) => ({ ...run, status: runStatus(scheduled.active, scheduled.active.abortRequested ? "aborted" : "failed") }));
          if (!hasExternalChange(scheduled.active) && !scheduled.active.abortRequested) {
            addNotice(scheduled.active, `${scheduled.active.runId}-scheduler-failure`, "error", "Run failed", detail);
          }
          persistRunOutcome(scheduled.active);
        }).finally(() => {
        this.runningRuns -= 1;
        try {
          this.finishRun(scheduled.file, scheduled.active);
        } finally {
          scheduled.resolve();
          this.updateQueuePositions();
          this.dispatchRuns();
        }
      });
    }
    this.updateQueuePositions();
  }

  private cancelPendingRun(file: string, status: "aborted" | "interrupted") {
    const index = this.pendingRuns.findIndex((scheduled) => scheduled.file === file);
    if (index < 0) return false;
    const [scheduled] = this.pendingRuns.splice(index, 1);
    updateRun(scheduled.active, (run) => ({
      ...run,
      status,
      items: run.items.map((item) => item.kind === "command" && item.status === "queued" ? { ...item, status } : item),
    }));
    persistRunOutcome(scheduled.active);
    this.finishRun(file, scheduled.active);
    scheduled.resolve();
    this.updateQueuePositions();
    this.dispatchRuns();
    return true;
  }

  private finishRun(file: string, active: ActiveRun) {
    this.activeTasks.delete(file);
    this.activeExecutionLocations.delete(active.executionPath);
    if (!active.externalChanged && active.manager) this.taskHistories.set(file, taskHistoryState(file, active.manager));
    const { queuePosition: _queuePosition, ...state } = active.state;
    active.state = { ...state, activeRunId: undefined };
    this.publish(active.state);
    if (!this.activeTasks.size) {
      for (const resolve of this.idleWaiters) resolve();
      this.idleWaiters.clear();
    }
  }

  private handleExternalChange(file: string) {
    const externalChange = getTaskContinuity(file);
    if (!externalChange) return;
    const active = this.activeTasks.get(file);
    if (active) {
      active.externalChanged = true;
      active.state = { ...active.state, externalChange };
      updateRun(active, interruptRun);
      if (this.cancelPendingRun(file, "interrupted")) return;
      active.session?.clearQueue();
      void abortRunProcesses(active).catch(() => undefined);
      this.publish(active.state);
      return;
    }
    const saved = this.taskStates.get(file);
    if (saved) this.publish({ ...saved, activeRunId: undefined, externalChange });
  }

  async withIdleExecution<T>(projectPath: string, taskPath: string, operation: () => Promise<T>) {
    const { file, executionPath, execution } = await this.runnableTask(projectPath, taskPath);
    this.observe(file);
    assertTaskCurrent(file);
    this.claimExecution(executionPath, execution.kind);
    try {
      await this.revalidateExecutionClaim(projectPath, taskPath, executionPath);
      return await operation();
    } finally {
      this.activeExecutionLocations.delete(executionPath);
    }
  }

  private async mutateTaskHistory<T>(projectPath: string, taskPath: string, operation: (context: Awaited<ReturnType<typeof assertRunnableTask>>) => Promise<T>) {
    const context = await this.runnableTask(projectPath, taskPath);
    SessionManager.open(context.file);
    this.observe(context.file);
    assertTaskCurrent(context.file);
    if (this.activeExecutionLocations.has(context.executionPath)) throw new Error("Stop the active Run in this Execution location before changing Task history");
    this.activeExecutionLocations.add(context.executionPath);
    try {
      return await withTaskWrite(context.file, () => operation(context));
    } finally {
      this.activeExecutionLocations.delete(context.executionPath);
    }
  }

  async getTaskRun(projectPath: string, taskPath: string) {
    const active = this.activeTasks.get(path.resolve(taskPath));
    if (active) return active.state;
    const { file, executionPath } = await this.runnableTask(projectPath, taskPath);
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
    const { file, executionPath } = await this.runnableTask(projectPath, taskPath);
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

  async forkChangedTask(projectPath: string, taskPath: string, execution: TaskExecutionLocation, setupCommand?: string) {
    await assertExecutionAllowed(this.userData, projectPath);
    const file = path.resolve(taskPath);
    if (this.activeTasks.has(file)) throw new Error("Wait for the interrupted Run to stop before forking this Task");
    const environment = await this.environmentForProject(projectPath);
    return withTaskWrite(file, () => forkTaskSnapshot(this.agentDir, projectPath, file, execution, setupCommand, environment));
  }

  async getTaskHistory(projectPath: string, taskPath: string) {
    const readable = await assertReadableTask(this.agentDir, projectPath, taskPath);
    if (readable.task.execution.kind === "worktree" && readable.task.execution.removedAt) {
      const manager = SessionManager.open(readable.file);
      const externalChange = this.observe(readable.file);
      if (externalChange && this.taskHistories.has(readable.file)) return this.taskHistories.get(readable.file)!;
      assertTaskCurrent(readable.file);
      const history = await withTaskWrite(readable.file, async () => taskHistoryState(readable.file, manager));
      this.taskHistories.set(readable.file, history);
      return history;
    }
    const { file, executionPath } = await this.runnableTask(projectPath, taskPath);
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

  async getTaskHistoryEntry(projectPath: string, taskPath: string, entryId: string) {
    await this.getTaskHistory(projectPath, taskPath);
    const readable = await assertReadableTask(this.agentDir, projectPath, taskPath);
    assertTaskCurrent(readable.file);
    const manager = this.activeTasks.get(readable.file)?.manager ?? SessionManager.open(readable.file);
    const detail = taskHistoryEntryDetail(readable.file, manager, entryId);
    assertTaskCurrent(readable.file);
    return detail;
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

  async forkTaskFromHistory(projectPath: string, taskPath: string, entryId: string, execution: TaskExecutionLocation, setupCommand?: string) {
    await assertExecutionAllowed(this.userData, projectPath);
    return this.mutateTaskHistory(projectPath, taskPath, async ({ file, project }) =>
      forkFromPrompt(file, project, execution, taskSetup(setupCommand), guardTaskManager(file, SessionManager.open(file)), entryId));
  }

  async cloneTaskHistory(projectPath: string, taskPath: string, execution: TaskExecutionLocation, setupCommand?: string) {
    await assertExecutionAllowed(this.userData, projectPath);
    return this.mutateTaskHistory(projectPath, taskPath, async ({ file, project }) =>
      cloneCurrentPath(file, project, execution, taskSetup(setupCommand), guardTaskManager(file, SessionManager.open(file))));
  }

  async navigateTaskHistory(projectPath: string, taskPath: string, entryId: string, summarize: boolean, customInstructions?: string) {
    const instructions = customInstructions?.trim();
    if (instructions && instructions.length > 2_000) throw new Error("Summary focus must be 2,000 characters or fewer");
    if (summarize) await assertExecutionAllowed(this.userData, projectPath);
    return this.mutateTaskHistory(projectPath, taskPath, async ({ file, project, executionPath }) => {
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
      const { session, manager } = await this.createSession(project, executionPath, file, auth, models);
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

  private async taskShellRuntime(projectPath: string, executionPath: string) {
    return (await prepareProjectShellRuntime(this.agentDir, projectPath, executionPath, this.environmentForProject)).runtime;
  }

  async submitPrompt(projectPath: string, taskPath: string, prompt: string, images: ImageAttachment[] = []) {
    const text = prompt.trim();
    if (!text) throw new Error("Enter a prompt");
    assertDesktopPrompt(text);
    await assertExecutionAllowed(this.userData, projectPath);
    const { file, project, executionPath, execution, setup } = await this.runnableTask(projectPath, taskPath);
    assertSetupReady(setup);
    const manager = SessionManager.open(file);
    this.observe(file);
    assertTaskCurrent(file);
    const preparedImages = await prepareImages(images);
    this.assertExecutionAvailable(executionPath, execution.kind);
    const shellRuntime = await this.taskShellRuntime(project, executionPath);

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
      persisted: false,
      settled: false,
      assistantSequence: 0,
      compactionSequence: 0,
      externalChanged: false,
    };

    await this.scheduleRun(active, execution.kind, "preparing", async () => {
      try {
        await this.revalidateExecutionClaim(projectPath, taskPath, executionPath, ({ setup: currentSetup }) => assertSetupReady(currentSetup));
        if (active.abortRequested) {
          updateRun(active, (value) => ({ ...value, status: runStatus(active, "aborted") }));
          persistRunOutcome(active);
          return;
        }
        await withTaskWrite(file, async () => {
          const { session, manager } = await this.createSession(project, executionPath, file, auth, models, shellRuntime);
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
              await session.prompt(text, { images: preparedImages });
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
        persistRunOutcome(active);
      }
    });
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
    const { file, project, executionPath, execution, setup } = await this.runnableTask(projectPath, taskPath);
    assertSetupReady(setup);
    const manager = SessionManager.open(file);
    this.observe(file);
    assertTaskCurrent(file);
    this.assertExecutionAvailable(executionPath, execution.kind);
    const shellRuntime = await this.taskShellRuntime(project, executionPath);

    const run: RunEvidence = {
      id: randomUUID(),
      status: "running",
      startedAt: new Date().toISOString(),
      input: { kind: "command", text, includeInContext },
      items: [{ id: "command", kind: "command", command: text, output: "", status: "running", includeInContext }],
    };
    const saved = savedState(file, manager, executionPath);
    const commandAbort = new AbortController();
    const active: ActiveRun = {
      project,
      executionPath,
      state: { ...saved, activeRunId: run.id, runs: [...saved.runs, run] },
      runId: run.id,
      abortRequested: false,
      persisted: false,
      settled: false,
      assistantSequence: 0,
      compactionSequence: 0,
      externalChanged: false,
      commandAbort,
    };

    await this.scheduleRun(active, execution.kind, "running", async () => {
      try {
        await this.revalidateExecutionClaim(projectPath, taskPath, executionPath, ({ setup: currentSetup }) => assertSetupReady(currentSetup));
        if (active.abortRequested) {
          replaceItem(active, "command", (item) => item.kind === "command" ? { ...item, status: "aborted" } : item);
          updateRun(active, (value) => ({ ...value, status: runStatus(active, "aborted") }));
          persistRunOutcome(active);
          return;
        }
        await withTaskWrite(file, async () => {
          const auth = AuthStorage.create(path.join(this.agentDir, "auth.json"));
          const models = ModelRegistry.create(auth, path.join(this.agentDir, "models.json"));
          const { session, manager, bashOperations } = await this.createSession(project, executionPath, file, auth, models, shellRuntime);
          active.session = session;
          active.manager = manager;
          try {
            if (active.abortRequested) {
              replaceItem(active, "command", (item) => item.kind === "command" ? { ...item, status: "aborted" } : item);
              updateRun(active, (value) => ({ ...value, status: runStatus(active, "aborted") }));
              persistRunOutcome(active);
              return;
            }
            const result = await session.executeBash(text, (chunk) => {
              replaceItem(active, "command", (item) => {
                if (item.kind !== "command") return item;
                const view = boundedOutput(item.output + chunk);
                return { ...item, ...view };
              });
              this.publish(active.state);
            }, { excludeFromContext: !includeInContext, operations: withRunAbort(bashOperations, commandAbort.signal) });
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
        updateRun(active, (value) => ({ ...value, status: runStatus(active, active.abortRequested ? "aborted" : "failed") }));
        persistRunOutcome(active);
      }
    });
  }

  async compactTask(projectPath: string, taskPath: string) {
    await assertExecutionAllowed(this.userData, projectPath);
    const { file, project, executionPath, execution, setup } = await this.runnableTask(projectPath, taskPath);
    assertSetupReady(setup);
    const manager = SessionManager.open(file);
    this.observe(file);
    assertTaskCurrent(file);
    this.assertExecutionAvailable(executionPath, execution.kind);
    const shellRuntime = await this.taskShellRuntime(project, executionPath);

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
      persisted: false,
      settled: false,
      assistantSequence: 0,
      compactionSequence: 0,
      externalChanged: false,
    };

    await this.scheduleRun(active, execution.kind, "compacting", async () => {
      try {
        await this.revalidateExecutionClaim(projectPath, taskPath, executionPath, ({ setup: currentSetup }) => assertSetupReady(currentSetup));
        if (active.abortRequested) {
          updateRun(active, (value) => ({ ...value, status: runStatus(active, "aborted") }));
          persistRunOutcome(active);
          return;
        }
        await withTaskWrite(file, async () => {
          const { session, manager } = await this.createSession(project, executionPath, file, auth, models, shellRuntime);
          active.session = session;
          active.manager = manager;
          const unsubscribe = session.subscribe((event) => this.handleEvent(active, event));
          try {
            if (active.abortRequested) {
              updateRun(active, (value) => ({ ...value, status: runStatus(active, "aborted") }));
              return;
            }
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
        persistRunOutcome(active);
      }
    });
  }

  async exportTask(projectPath: string, taskPath: string, format: "jsonl" | "html", outputPath: string) {
    const { file, project, executionPath } = await this.runnableTask(projectPath, taskPath);
    if (this.activeTasks.has(file)) throw new Error("Stop the active Run before exporting this Task");
    if (format === "jsonl") {
      await copyFile(file, outputPath);
      return;
    }
    const auth = AuthStorage.create(path.join(this.agentDir, "auth.json"));
    const models = ModelRegistry.create(auth, path.join(this.agentDir, "models.json"));
    const { session } = await this.createSession(project, executionPath, file, auth, models);
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
    const file = path.resolve(taskPath);
    const active = this.activeTasks.get(file);
    if (!active) return;
    active.abortRequested = true;
    if (this.cancelPendingRun(file, "aborted")) return;
    const queued = active.session?.clearQueue();
    const recoveredInput = queued ? [...queued.steering, ...queued.followUp].join("\n\n") : "";
    if (recoveredInput) {
      active.state = { ...active.state, recoveredInput };
      this.publish(active.state);
      active.state = { ...active.state, recoveredInput: undefined };
    }
    await abortRunProcesses(active);
    updateRun(active, (run) => ({ ...run, status: runStatus(active, "aborted") }));
  }

  async abortProject(projectPath: string) {
    const project = path.resolve(projectPath);
    await Promise.all([...this.activeTasks]
      .filter(([, active]) => path.resolve(active.project) === project)
      .map(([taskPath]) => this.abortTask(taskPath)));
  }

  async abortAll() {
    await Promise.allSettled([...this.activeTasks].map(([taskPath]) => this.abortTask(taskPath)));
    if (!this.activeTasks.size) return;
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  private async createSession(
    projectPath: string,
    executionPath: string,
    file: string,
    auth: AuthStorage,
    models: ModelRegistry,
    shellRuntime?: PreparedShellRuntime,
  ) {
    const { loader: resources, settings } = await loadTaskResources(this.agentDir, projectPath, executionPath);
    const manager = guardTaskManager(file, SessionManager.open(file));
    const configuredScope = settings.getEnabledModels();
    const { scopedModels } = Array.isArray(configuredScope) && configuredScope.length
      ? await resolveModelScopeWithDiagnostics(configuredScope, models)
      : { scopedModels: [] };
    const bashOperations = shellRuntime
      ? withBashEnvironment(createLocalBashOperations({ shellPath: shellRuntime.shellPath }), shellRuntime.environment)
      : undefined;
    const customTools: CreateAgentSessionOptions["customTools"] = shellRuntime ? [createBashToolDefinition(executionPath, {
      shellPath: shellRuntime.shellPath,
      commandPrefix: settings.getShellCommandPrefix(),
      spawnHook: (context) => ({ ...context, env: mergeEnvironments(context.env, shellRuntime.environment) }),
    }) as unknown as NonNullable<CreateAgentSessionOptions["customTools"]>[number]] : undefined;
    const { session } = await createAgentSession({
      cwd: executionPath,
      agentDir: this.agentDir,
      authStorage: auth,
      modelRegistry: models,
      settingsManager: settings,
      resourceLoader: resources,
      sessionManager: manager,
      scopedModels,
      ...(customTools ? { customTools } : {}),
      ...getTaskSessionSelection(manager, models),
    });
    return { session, manager, bashOperations };
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
