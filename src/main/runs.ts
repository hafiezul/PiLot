import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CompactionEvidence, LiveInputMode, RetryEvidence, RunEvidence, RunEvidenceItem, RunStatus, TaskRunState } from "../shared/projects.js";
import { assertExecutionAllowed } from "./projects.js";
import { assertRunnableTask, getTaskSessionSelection, withTaskWrite } from "./tasks.js";

const runMetadataType = "pilot.run";
const retryMetadataType = "pilot.retry";
const compactionMetadataType = "pilot.compaction";
const maximumOutputCharacters = 12_000;

type ActiveRun = {
  project: string;
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
};

type ResultView = {
  output: string;
  details?: string;
  outputTruncated: boolean;
  fullOutputPath?: string;
};

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

function currentRun(active: ActiveRun) {
  return active.state.runs.find(({ id }) => id === active.runId)!;
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

function savedState(taskPath: string, manager: SessionManager): TaskRunState {
  const runs: RunEvidence[] = [];
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
        timestamp?: number;
      };
      if (message.role === "user") {
        current = {
          id: entry.id,
          status: "preparing",
          startedAt: entry.timestamp,
          input: { kind: "prompt", text: contentText(message.content) },
          items: [],
        };
        runs.push(current);
      } else if (message.role === "bashExecution" && typeof message.command === "string") {
        const status = message.cancelled ? "aborted" : message.exitCode && message.exitCode !== 0 ? "failed" : "settled";
        const view = boundedOutput(message.output ?? "");
        current = {
          id: entry.id,
          status,
          startedAt: entry.timestamp,
          input: { kind: "command", text: message.command, includeInContext: !message.excludeFromContext },
          items: [{
            id: entry.id,
            kind: "command",
            command: message.command,
            output: view.output,
            status: message.cancelled ? "aborted" : message.exitCode && message.exitCode !== 0 ? "failed" : "succeeded",
            includeInContext: !message.excludeFromContext,
            outputTruncated: view.outputTruncated || message.truncated,
            fullOutputPath: message.fullOutputPath,
          }],
        };
        runs.push(current);
      } else if (message.role === "assistant" && current) {
        const text = contentText(message.content);
        const thinking = contentText(message.content, "thinking");
        if (text || thinking) current.items.push({ id: entry.id, kind: "assistant", text, thinking });
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (!block || typeof block !== "object" || (block as { type?: string }).type !== "toolCall") continue;
            const tool = block as { id?: string; name?: string; arguments?: unknown };
            if (!tool.id || !tool.name) continue;
            current.items.push({
              id: tool.id,
              kind: "tool",
              name: tool.name,
              summary: toolSummary(tool.name, tool.arguments),
              input: printable(tool.arguments),
              output: "",
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
      if (data.inputKind === "compaction" && typeof data.runId === "string" && !runs.some(({ id }) => id === data.runId)) {
        current = {
          id: data.runId,
          status: "compacting",
          startedAt: typeof data.startedAt === "string" ? data.startedAt : entry.timestamp,
          input: { kind: "compaction", text: "Compact context" },
          items: [],
        };
        runs.push(current);
      }
      const outcome = String(data.outcome);
      if (current && ["settled", "failed", "aborted", "interrupted"].includes(outcome)) current.status = outcome as RunStatus;
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

  for (const run of runs) {
    if (run.status !== "preparing") continue;
    run.status = run.items.some((item) => item.kind === "assistant" || item.kind === "tool") ? "settled" : "interrupted";
  }
  return { taskPath, runs };
}

export class LocalRunCoordinator {
  private activeTasks = new Map<string, ActiveRun>();
  private activeProjects = new Set<string>();

  constructor(
    private userData: string,
    private agentDir: string,
    private emit: (state: TaskRunState) => void,
  ) {}

  async getTaskRun(projectPath: string, taskPath: string) {
    const active = this.activeTasks.get(path.resolve(taskPath));
    if (active) return active.state;
    const { file } = await assertRunnableTask(this.agentDir, projectPath, taskPath);
    return withTaskWrite(file, async () => savedState(file, SessionManager.open(file)));
  }

  async submitPrompt(projectPath: string, taskPath: string, prompt: string) {
    const text = prompt.trim();
    if (!text) throw new Error("Enter a prompt");
    await assertExecutionAllowed(this.userData, projectPath);
    const { file, project } = await assertRunnableTask(this.agentDir, projectPath, taskPath);
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
    const saved = savedState(file, SessionManager.open(file));
    const active: ActiveRun = {
      project,
      state: { ...saved, activeRunId: run.id, runs: [...saved.runs, run], queues: { steering: [], followUp: [] } },
      runId: run.id,
      abortRequested: false,
      accepted: false,
      settled: false,
      assistantSequence: 0,
      compactionSequence: 0,
    };
    this.activeProjects.add(project);
    this.activeTasks.set(file, active);
    this.emit(active.state);

    try {
      await withTaskWrite(file, async () => {
        const { session, manager } = await this.createSession(project, file, auth, models);
        active.session = session;
        active.manager = manager;
        const unsubscribe = session.subscribe((event) => this.handleEvent(active, event));
        try {
          if (active.abortRequested) {
            updateRun(active, (value) => ({ ...value, status: "aborted" }));
          } else {
            await session.prompt(text, { preflightResult: (accepted) => { active.accepted = accepted; } });
            if (!active.settled) updateRun(active, (value) => ({
              ...value,
              status: active.abortRequested ? "aborted" : active.lastError ? "failed" : "settled",
            }));
          }
          if (active.accepted) manager.appendCustomEntry(runMetadataType, { version: 1, outcome: currentRun(active).status });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          updateRun(active, (value) => ({ ...value, status: active.abortRequested ? "aborted" : "failed" }));
          if (!active.abortRequested) addNotice(active, `${run.id}-failure`, "error", "Run failed", detail);
          if (active.accepted) manager.appendCustomEntry(runMetadataType, { version: 1, outcome: currentRun(active).status });
        } finally {
          unsubscribe();
          session.dispose();
        }
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      updateRun(active, (value) => ({ ...value, status: active.abortRequested ? "aborted" : "failed" }));
      if (!active.abortRequested) addNotice(active, `${run.id}-failure`, "error", "Run failed", detail);
    } finally {
      this.activeTasks.delete(file);
      this.activeProjects.delete(project);
      this.emit({ ...active.state, activeRunId: undefined });
    }
  }

  async queuePrompt(taskPath: string, prompt: string, mode: LiveInputMode) {
    const text = prompt.trim();
    if (!text) throw new Error("Enter a prompt");
    const active = this.activeTasks.get(path.resolve(taskPath));
    if (!active || currentRun(active).input.kind !== "prompt") throw new Error("This Task has no active agent Run");
    if (!active.session || !active.session.isStreaming || active.abortRequested) throw new Error("The Run is not ready for live input");
    await (mode === "steer" ? active.session.steer(text) : active.session.followUp(text));
  }

  async executeCommand(projectPath: string, taskPath: string, command: string, includeInContext: boolean) {
    const text = command.trim();
    if (!text) throw new Error("Enter a command");
    await assertExecutionAllowed(this.userData, projectPath);
    const { file, project } = await assertRunnableTask(this.agentDir, projectPath, taskPath);
    if (this.activeProjects.has(project)) throw new Error("Another Local Task is already running in this Project");

    const run: RunEvidence = {
      id: randomUUID(),
      status: "running",
      startedAt: new Date().toISOString(),
      input: { kind: "command", text, includeInContext },
      items: [{ id: "command", kind: "command", command: text, output: "", status: "running", includeInContext }],
    };
    const saved = savedState(file, SessionManager.open(file));
    const active: ActiveRun = {
      project,
      state: { ...saved, activeRunId: run.id, runs: [...saved.runs, run] },
      runId: run.id,
      abortRequested: false,
      accepted: true,
      settled: false,
      assistantSequence: 0,
      compactionSequence: 0,
    };
    this.activeProjects.add(project);
    this.activeTasks.set(file, active);
    this.emit(active.state);

    try {
      await withTaskWrite(file, async () => {
        const auth = AuthStorage.create(path.join(this.agentDir, "auth.json"));
        const models = ModelRegistry.create(auth, path.join(this.agentDir, "models.json"));
        const { session, manager } = await this.createSession(project, file, auth, models);
        active.session = session;
        try {
          const result = await session.executeBash(text, (chunk) => {
            replaceItem(active, "command", (item) => {
              if (item.kind !== "command") return item;
              const view = boundedOutput(item.output + chunk);
              return { ...item, ...view };
            });
            this.emit(active.state);
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
            status: result.cancelled ? "aborted" : result.exitCode && result.exitCode !== 0 ? "failed" : "settled",
          }));
          manager.appendCustomEntry(runMetadataType, { version: 1, outcome: currentRun(active).status });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          const output = currentRun(active).items.find((item) => item.kind === "command")?.output ?? "";
          session.recordBashResult(text, {
            output: [output, active.abortRequested ? "Command aborted" : detail].filter(Boolean).join("\n"),
            exitCode: undefined,
            cancelled: active.abortRequested,
            truncated: false,
          }, { excludeFromContext: !includeInContext });
          replaceItem(active, "command", (item) => item.kind === "command" ? {
            ...item,
            output: [item.output, active.abortRequested ? "Command aborted" : detail].filter(Boolean).join("\n"),
            status: active.abortRequested ? "aborted" : "failed",
          } : item);
          updateRun(active, (value) => ({ ...value, status: active.abortRequested ? "aborted" : "failed" }));
          manager.appendCustomEntry(runMetadataType, { version: 1, outcome: currentRun(active).status });
        } finally {
          session.dispose();
        }
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      replaceItem(active, "command", (item) => item.kind === "command" ? { ...item, output: detail, status: "failed" } : item);
      updateRun(active, (value) => ({ ...value, status: "failed" }));
    } finally {
      this.activeTasks.delete(file);
      this.activeProjects.delete(project);
      this.emit({ ...active.state, activeRunId: undefined });
    }
  }

  async compactTask(projectPath: string, taskPath: string) {
    await assertExecutionAllowed(this.userData, projectPath);
    const { file, project } = await assertRunnableTask(this.agentDir, projectPath, taskPath);
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
    const saved = savedState(file, SessionManager.open(file));
    const active: ActiveRun = {
      project,
      state: { ...saved, activeRunId: run.id, runs: [...saved.runs, run] },
      runId: run.id,
      abortRequested: false,
      accepted: true,
      settled: false,
      assistantSequence: 0,
      compactionSequence: 0,
    };
    this.activeProjects.add(project);
    this.activeTasks.set(file, active);
    this.emit(active.state);

    try {
      await withTaskWrite(file, async () => {
        const { session, manager } = await this.createSession(project, file, auth, models);
        active.session = session;
        active.manager = manager;
        const unsubscribe = session.subscribe((event) => this.handleEvent(active, event));
        manager.appendCustomEntry(runMetadataType, {
          version: 1,
          runId: run.id,
          inputKind: "compaction",
          startedAt: run.startedAt,
          outcome: "compacting",
        });
        try {
          const branch = manager.getBranch();
          const lastCompaction = branch.map(({ type }) => type).lastIndexOf("compaction");
          if (lastCompaction >= 0 && !branch.slice(lastCompaction + 1).some(({ type }) =>
            type === "message" || type === "custom_message" || type === "branch_summary")) {
            throw new Error("Already compacted; add more Task history before compacting again");
          }
          await session.compact();
          updateRun(active, (value) => ({ ...value, status: "settled" }));
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          updateRun(active, (value) => ({ ...value, status: active.abortRequested ? "aborted" : "failed" }));
          if (!currentRun(active).items.some((item) => item.kind === "compaction" && item.status === "failed")) {
            addNotice(active, `${run.id}-failure`, "error", "Compaction failed", detail);
          }
        } finally {
          manager.appendCustomEntry(runMetadataType, { version: 1, outcome: currentRun(active).status });
          unsubscribe();
          session.dispose();
        }
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      updateRun(active, (value) => ({ ...value, status: active.abortRequested ? "aborted" : "failed" }));
      if (!active.abortRequested) addNotice(active, `${run.id}-failure`, "error", "Compaction failed", detail);
    } finally {
      this.activeTasks.delete(file);
      this.activeProjects.delete(project);
      this.emit({ ...active.state, activeRunId: undefined });
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
      this.emit(active.state);
      active.state = { ...active.state, recoveredInput: undefined };
    }
    active.session?.abortBash();
    active.session?.abortCompaction();
    await active.session?.abort();
    updateRun(active, (run) => ({ ...run, status: "aborted" }));
  }

  async abortAll() {
    await Promise.all([...this.activeTasks].map(([taskPath]) => this.abortTask(taskPath)));
  }

  private async createSession(project: string, file: string, auth: AuthStorage, models: ModelRegistry) {
    const trusted = new ProjectTrustStore(this.agentDir).getEntry(project)?.decision === true;
    const settings = SettingsManager.create(project, this.agentDir, { projectTrusted: trusted });
    const resources = new DefaultResourceLoader({
      cwd: project,
      agentDir: this.agentDir,
      settingsManager: settings,
      noExtensions: true,
      noThemes: true,
    });
    await resources.reload();
    const manager = SessionManager.open(file);
    const { session } = await createAgentSession({
      cwd: project,
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
    switch (event.type) {
      case "agent_start":
        updateRun(active, (run) => ({ ...run, status: "running" }));
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
        if (active.lastError && !hasLifecycleFailure) {
          addNotice(active, `${active.runId}-provider`, "error", "Provider failed", active.lastError);
        }
        updateRun(active, (run) => ({
          ...run,
          status: active.abortRequested ? "aborted" : active.lastError ? "failed" : "settled",
        }));
        break;
      }
      case "tool_execution_start":
        appendItem(active, {
          id: event.toolCallId,
          kind: "tool",
          name: event.toolName,
          summary: toolSummary(event.toolName, event.args),
          input: printable(event.args),
          output: "",
          status: "running",
        });
        break;
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
        updateRun(active, (run) => ({ ...run, status: "retrying" }));
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
        updateRun(active, (run) => ({ ...run, status: "compacting" }));
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
          status: status === "failed" ? "failed" : event.willRetry ? "running" : run.status,
        }));
        active.manager?.appendCustomEntry(compactionMetadataType, {
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
    this.emit(active.state);
  }
}
