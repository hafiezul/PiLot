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
import type { LiveInputMode, RunEvidence, RunEvidenceItem, RunStatus, TaskRunState } from "../shared/projects.js";
import { assertExecutionAllowed } from "./projects.js";
import { assertRunnableTask, withTaskWrite } from "./tasks.js";

const runMetadataType = "pilot.run";
const maximumOutputCharacters = 12_000;

type ActiveRun = {
  project: string;
  state: TaskRunState;
  runId: string;
  session?: AgentSession;
  abortRequested: boolean;
  accepted: boolean;
  lastError?: string;
  assistantSequence: number;
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

    if (entry.type === "custom" && entry.customType === runMetadataType && current && entry.data && typeof entry.data === "object") {
      const outcome = String((entry.data as { outcome?: unknown }).outcome);
      if (["settled", "failed", "aborted", "interrupted"].includes(outcome)) current.status = outcome as RunStatus;
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
      assistantSequence: 0,
    };
    this.activeProjects.add(project);
    this.activeTasks.set(file, active);
    this.emit(active.state);

    try {
      await withTaskWrite(file, async () => {
        const { session, manager } = await this.createSession(project, file, auth, models);
        active.session = session;
        const unsubscribe = session.subscribe((event) => this.handleEvent(active, event));
        try {
          if (active.abortRequested) {
            updateRun(active, (value) => ({ ...value, status: "aborted" }));
          } else {
            await session.prompt(text, { preflightResult: (accepted) => { active.accepted = accepted; } });
            updateRun(active, (value) => ({
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
      assistantSequence: 0,
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
        if (event.message.stopReason === "error") {
          active.lastError = event.message.errorMessage ?? "The provider failed";
          addNotice(active, `${active.runId}-provider`, "error", "Provider failed", active.lastError);
        }
        if (event.message.stopReason === "aborted") active.abortRequested = true;
        break;
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
      case "auto_retry_start":
        addNotice(active, `retry-${event.attempt}`, "attention", `Retrying provider request ${event.attempt} of ${event.maxAttempts}`, event.errorMessage);
        break;
      case "auto_retry_end":
        if (!event.success && event.finalError) addNotice(active, `retry-${event.attempt}`, "error", "Provider retry failed", event.finalError);
        break;
      case "queue_update":
        active.state = { ...active.state, queues: { steering: [...event.steering], followUp: [...event.followUp] } };
        break;
      case "compaction_start":
        addNotice(active, `compaction-${event.reason}`, "attention", "Compacting context", `Reason: ${event.reason}`);
        break;
      case "compaction_end":
        if (event.errorMessage) addNotice(active, `compaction-${event.reason}`, "error", "Compaction failed", event.errorMessage);
        break;
      default:
        return;
    }
    this.emit(active.state);
  }
}
