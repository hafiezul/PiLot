import { SessionManager, type SessionEntry, type SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TaskExecutionLocation, TaskHistoryEntryDetail, TaskHistoryKind, TaskHistoryNode, TaskHistoryState, TaskSetupState, TaskSummary } from "../shared/projects.js";
import { safeTaskTitle } from "./tasks.js";

export const historyNavigationType = "pilot.history-navigation";
const taskMetadataType = "pilot.task";
const maximumHistoryEntryDetailCharacters = 64_000;

function contentText(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => part && typeof part === "object" && (part as { type?: string }).type === "text"
    ? [(part as { text?: unknown }).text]
    : []).filter((part): part is string => typeof part === "string").join("");
}

function compact(value: string, maximum = 240) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > maximum ? `${text.slice(0, maximum - 1).trimEnd()}…` : text;
}

function messageView(entry: Extract<SessionEntry, { type: "message" }>): { kind: TaskHistoryKind; title: string; description?: string } {
  const message = entry.message as unknown as {
    role: string;
    content?: unknown;
    command?: string;
    output?: string;
    toolName?: string;
    isError?: boolean;
  };
  const description = compact(contentText(message.content));
  if (message.role === "user") return { kind: "prompt", title: "Prompt", ...(description ? { description } : {}) };
  if (message.role === "assistant") {
    const tools = Array.isArray(message.content) ? message.content.flatMap((part) => part && typeof part === "object" && (part as { type?: string }).type === "toolCall" && typeof (part as { name?: unknown }).name === "string"
      ? [(part as { name: string }).name]
      : []) : [];
    return { kind: "response", title: "Pi response", description: description || (tools.length ? `Requested ${tools.join(", ")}` : "Empty response") };
  }
  if (message.role === "toolResult") return { kind: "tool", title: `${message.toolName || "Tool"} ${message.isError ? "failed" : "result"}`, ...(description ? { description } : {}) };
  if (message.role === "bashExecution") return { kind: "command", title: "Inline command", description: compact(`$ ${message.command ?? ""}${message.output ? ` — ${message.output}` : ""}`) };
  return { kind: "custom", title: "Context message", ...(description ? { description } : {}) };
}

function entryView(entry: SessionEntry): { kind: TaskHistoryKind; title: string; description?: string } | undefined {
  if (entry.type === "message") return messageView(entry);
  if (entry.type === "compaction") return { kind: "compaction", title: "Compaction", description: compact(`${entry.tokensBefore.toLocaleString()} tokens before · ${entry.summary}`) };
  if (entry.type === "branch_summary") return { kind: "branch-summary", title: "Branch summary", description: compact(entry.summary) };
  if (entry.type === "model_change") return { kind: "model-change", title: "Model change", description: `${entry.provider}/${entry.modelId}` };
  if (entry.type === "thinking_level_change") return { kind: "thinking-change", title: "Thinking change", description: entry.thinkingLevel[0]?.toUpperCase() + entry.thinkingLevel.slice(1) };
  if (entry.type === "session_info") return { kind: "task-name", title: "Task name", description: entry.name || "Cleared" };
  if (entry.type === "custom_message") return { kind: "custom", title: "Context message", description: compact(contentText(entry.content)) };
  if (entry.type === "custom" && entry.customType === historyNavigationType) return { kind: "navigation", title: "Navigation point", description: "Ready to continue from the selected entry" };
  if (entry.type === "custom" && !entry.customType.startsWith("pilot.")) return { kind: "custom", title: "Custom entry", description: entry.customType };
}

function messageDetail(entry: Extract<SessionEntry, { type: "message" }>) {
  const message = entry.message as unknown as {
    role: string;
    content?: unknown;
    command?: string;
    output?: string;
    toolName?: string;
    isError?: boolean;
  };
  if (message.role === "bashExecution") return [`$ ${message.command ?? ""}`, message.output ?? ""].filter(Boolean).join("\n\n");
  const text = contentText(message.content).trim();
  if (text) return text;
  if (message.role === "assistant" && Array.isArray(message.content)) {
    const tools = message.content.flatMap((part) => part && typeof part === "object" && (part as { type?: string }).type === "toolCall" && typeof (part as { name?: unknown }).name === "string"
      ? [(part as { name: string }).name]
      : []);
    if (tools.length) return `Requested ${tools.join(", ")}`;
  }
  if (message.role === "toolResult") return `${message.toolName || "Tool"} ${message.isError ? "failed without output" : "returned no output"}`;
  return "";
}

function entryDetail(entry: SessionEntry) {
  if (entry.type === "message") return messageDetail(entry);
  if (entry.type === "compaction") return `${entry.tokensBefore.toLocaleString()} tokens before\n\n${entry.summary}`;
  if (entry.type === "branch_summary") return entry.summary;
  if (entry.type === "model_change") return `${entry.provider}/${entry.modelId}`;
  if (entry.type === "thinking_level_change") return entry.thinkingLevel[0]?.toUpperCase() + entry.thinkingLevel.slice(1);
  if (entry.type === "session_info") return entry.name || "Task name cleared";
  if (entry.type === "custom_message") return contentText(entry.content).trim();
  const view = entryView(entry);
  return view?.description ?? "";
}

function visibleEntry(entry: SessionEntry) {
  return entryView(entry) !== undefined;
}

export function taskHistoryEntryDetail(taskPath: string, manager: SessionManager, entryId: string): TaskHistoryEntryDetail {
  const entry = manager.getEntry(entryId);
  const view = entry && entryView(entry);
  if (!entry || !view) throw new Error("Choose an available history entry");
  const detail = entryDetail(entry) || view.description || view.title;
  const truncated = detail.length > maximumHistoryEntryDetailCharacters;
  const text = truncated ? `${detail.slice(0, maximumHistoryEntryDetailCharacters - 1).trimEnd()}…` : detail;
  return { taskPath, entryId, text, truncated };
}

export function taskHistoryState(taskPath: string, manager: SessionManager): TaskHistoryState {
  const currentLeafId = [...manager.getBranch()].reverse().find((entry) => visibleEntry(entry))?.id;
  const projectNodes = (nodes: SessionTreeNode[]): TaskHistoryNode[] => nodes.flatMap((node) => {
    const children = projectNodes(node.children);
    const view = entryView(node.entry);
    if (!view) return children;
    return [{
      id: node.entry.id,
      ...view,
      timestamp: node.entry.timestamp,
      ...(node.label ? { label: node.label } : {}),
      current: node.entry.id === currentLeafId,
      children,
    }];
  });
  const roots = projectNodes(manager.getTree());
  const countPaths = (nodes: TaskHistoryNode[]): number => nodes.reduce((total, node) => total + (node.children.length ? countPaths(node.children) : 1), 0);
  return { taskPath, roots, ...(currentLeafId ? { currentLeafId } : {}), pathCount: countPaths(roots) };
}

export function navigateWithoutSummary(manager: SessionManager, targetId: string) {
  const target = manager.getEntry(targetId);
  if (!target || !visibleEntry(target)) throw new Error("Choose an available history entry");
  let editorText: string | undefined;
  if (target.type === "message" && target.message.role === "user") {
    editorText = contentText(target.message.content);
    if (target.parentId) manager.branch(target.parentId); else manager.resetLeaf();
  } else if (target.type === "custom_message") {
    editorText = contentText(target.content);
    if (target.parentId) manager.branch(target.parentId); else manager.resetLeaf();
  } else {
    manager.branch(target.id);
  }
  manager.appendCustomEntry(historyNavigationType, { version: 1, targetId });
  return editorText;
}

export function historyLabel(value?: string) {
  if (value === undefined) return undefined;
  const label = value.trim();
  if (!label) return undefined;
  if (label.length > 80) throw new Error("History labels must be 80 characters or fewer");
  if (/[\u0000-\u001f\u007f]/.test(label)) throw new Error("History labels cannot contain control characters");
  return label;
}

function currentTaskTitle(manager: SessionManager) {
  const named = manager.getSessionName();
  if (named) return safeTaskTitle(named);
  const metadata = [...manager.getEntries()].reverse().find((entry) => entry.type === "custom" && entry.customType === taskMetadataType && entry.data && typeof entry.data === "object") as Extract<SessionEntry, { type: "custom" }> | undefined;
  const title = metadata?.data && typeof (metadata.data as { title?: unknown }).title === "string" ? (metadata.data as { title: string }).title : undefined;
  if (title) return safeTaskTitle(title);
  const prompt = manager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "user");
  return safeTaskTitle(prompt?.type === "message" ? contentText((prompt.message as { content?: unknown }).content) : "");
}

async function persistTask(
  sourceFile: string,
  entries: SessionEntry[],
  title: string,
  projectPath: string,
  execution: TaskExecutionLocation,
  setup?: Omit<TaskSetupState, "taskPath">,
): Promise<TaskSummary> {
  const manager = SessionManager.create(execution.path, path.dirname(sourceFile), { parentSession: sourceFile });
  const file = manager.getSessionFile();
  const header = manager.getHeader();
  if (!file || !header) throw new Error("Pi could not create this Task");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`, { flag: "wx" });
  SessionManager.open(file).appendCustomEntry(taskMetadataType, { version: 1, title, lifecycle: "active", projectPath, execution, setup });
  return { id: header.id, path: file, title, lifecycle: "active", modified: header.timestamp, execution, ...(setup ? { setup } : {}) };
}

export async function forkFromPrompt(file: string, project: string, execution: TaskExecutionLocation, setup: Omit<TaskSetupState, "taskPath"> | undefined, manager: SessionManager, entryId: string) {
  const entry = manager.getEntry(entryId);
  if (!entry || entry.type !== "message" || entry.message.role !== "user") throw new Error("Choose a prompt to fork");
  const draft = contentText(entry.message.content);
  const entries = entry.parentId ? manager.getBranch(entry.parentId) : [];
  return { task: await persistTask(file, entries, safeTaskTitle(draft), project, execution, setup), draft };
}

export async function cloneCurrentPath(file: string, project: string, execution: TaskExecutionLocation, setup: Omit<TaskSetupState, "taskPath"> | undefined, manager: SessionManager) {
  return { task: await persistTask(file, manager.getBranch(), currentTaskTitle(manager), project, execution, setup) };
}
