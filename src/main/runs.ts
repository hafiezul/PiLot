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
import path from "node:path";
import type { TaskRunState } from "../shared/projects.js";
import { assertExecutionAllowed } from "./projects.js";
import { assertRunnableTask, withTaskWrite } from "./tasks.js";

const runMetadataType = "pilot.run";

type ActiveRun = {
  project: string;
  state: TaskRunState;
  session?: AgentSession;
  abortRequested: boolean;
  accepted: boolean;
  lastError?: string;
};

function messageText(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => part && typeof part === "object" && (part as { type?: string }).type === "text"
    ? [(part as { text?: unknown }).text]
    : []).filter((part): part is string => typeof part === "string").join("");
}

function savedState(taskPath: string, manager: SessionManager): TaskRunState {
  const messages = manager.buildSessionContext().messages;
  const outcomeEntry = manager.getEntries().reverse().find((entry) => entry.type === "custom" && entry.customType === runMetadataType);
  const outcome = outcomeEntry?.type === "custom" ? outcomeEntry.data : undefined;
  const savedStatus = outcome && typeof outcome === "object" && ["settled", "failed", "aborted"].includes(String((outcome as { outcome?: unknown }).outcome))
    ? (outcome as { outcome: "settled" | "failed" | "aborted" }).outcome
    : "idle";
  let prompt = "";
  let assistantText = "";
  for (const message of messages) {
    if (message.role === "user") {
      prompt = messageText(message.content);
      assistantText = "";
    } else if (message.role === "assistant" && prompt) {
      assistantText += messageText(message.content);
    }
  }
  return { taskPath, status: savedStatus, prompt, assistantText };
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
    if (active) return { ...active.state };
    const { file } = await assertRunnableTask(this.agentDir, projectPath, taskPath);
    return withTaskWrite(file, async () => savedState(file, SessionManager.open(file)));
  }

  async submitPrompt(projectPath: string, taskPath: string, prompt: string) {
    const text = prompt.trim();
    if (!text) throw new Error("Enter a prompt");
    await assertExecutionAllowed(this.userData, projectPath);
    const { file, project } = await assertRunnableTask(this.agentDir, projectPath, taskPath);

    const auth = AuthStorage.create(path.join(this.agentDir, "auth.json"));
    const models = ModelRegistry.create(auth, path.join(this.agentDir, "models.json"));
    if (models.getError()) throw new Error(`Fix models.json before running this Task: ${models.getError()}`);
    if (!models.getAvailable().length) throw new Error("Connect a provider in Settings before running this Task");
    if (this.activeProjects.has(project)) throw new Error("Another Local Task is already running in this Project");

    const active: ActiveRun = {
      project,
      state: { taskPath: file, status: "preparing", prompt: text, assistantText: "" },
      abortRequested: false,
      accepted: false,
    };
    this.activeProjects.add(project);
    this.activeTasks.set(file, active);
    this.emit({ ...active.state });

    try {
      await withTaskWrite(file, async () => {
        await assertRunnableTask(this.agentDir, project, file);
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
        active.session = session;
        const unsubscribe = session.subscribe((event) => this.handleEvent(active, event));

        try {
          if (active.abortRequested) {
            active.state = { ...active.state, status: "aborted", activity: undefined };
          } else {
            await session.prompt(text, { preflightResult: (accepted) => { active.accepted = accepted; } });
            active.state = {
              ...active.state,
              status: active.abortRequested ? "aborted" : active.lastError ? "failed" : "settled",
              activity: undefined,
              ...(active.lastError ? { error: active.lastError } : {}),
            };
          }
          if (active.accepted) manager.appendCustomEntry(runMetadataType, {
            version: 1,
            outcome: active.state.status,
          });
        } catch (error) {
          active.state = {
            ...active.state,
            status: active.abortRequested ? "aborted" : "failed",
            activity: undefined,
            error: active.abortRequested ? undefined : error instanceof Error ? error.message : String(error),
          };
          if (active.accepted) manager.appendCustomEntry(runMetadataType, {
            version: 1,
            outcome: active.state.status,
          });
        } finally {
          unsubscribe();
          session.dispose();
          this.emit({ ...active.state });
        }
      });
    } catch (error) {
      active.state = {
        ...active.state,
        status: active.abortRequested ? "aborted" : "failed",
        activity: undefined,
        error: active.abortRequested ? undefined : error instanceof Error ? error.message : String(error),
      };
      this.emit({ ...active.state });
    } finally {
      this.activeTasks.delete(file);
      this.activeProjects.delete(project);
    }
  }

  async abortTask(taskPath: string) {
    const active = this.activeTasks.get(path.resolve(taskPath));
    if (!active) return;
    active.abortRequested = true;
    await active.session?.abort();
    active.state = { ...active.state, status: "aborted", activity: undefined };
    this.emit({ ...active.state });
  }

  async abortAll() {
    await Promise.all([...this.activeTasks].map(([taskPath]) => this.abortTask(taskPath)));
  }

  private handleEvent(active: ActiveRun, event: AgentSessionEvent) {
    switch (event.type) {
      case "agent_start":
        active.state = { ...active.state, status: "running", activity: undefined };
        break;
      case "message_update":
        if (event.assistantMessageEvent.type !== "text_delta") return;
        active.state = { ...active.state, assistantText: active.state.assistantText + event.assistantMessageEvent.delta };
        break;
      case "message_end":
        if (event.message.role !== "assistant") return;
        if (event.message.stopReason === "error") active.lastError = event.message.errorMessage ?? "The provider failed";
        if (event.message.stopReason === "aborted") active.abortRequested = true;
        break;
      case "tool_execution_start":
        active.state = { ...active.state, activity: `Running ${event.toolName}` };
        break;
      case "tool_execution_end":
        active.state = { ...active.state, activity: event.isError ? `${event.toolName} failed` : undefined };
        break;
      case "auto_retry_start":
        active.state = { ...active.state, activity: `Retrying (${event.attempt}/${event.maxAttempts})` };
        break;
      case "compaction_start":
        active.state = { ...active.state, activity: "Compacting context" };
        break;
      default:
        return;
    }
    this.emit({ ...active.state });
  }
}
