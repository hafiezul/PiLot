export type TaskSummary = {
  id: string;
  path: string;
  title: string;
  lifecycle: "active" | "archived";
  modified: string;
};

export type ProjectDiagnostic = {
  title: string;
  detail: string;
};

export type ProjectSummary = {
  path: string;
  name: string;
  taskCount: number;
};

export type ProjectAccess = ProjectSummary & {
  admitted: boolean;
  tasks: TaskSummary[];
  diagnostics: ProjectDiagnostic[];
  executionConsent: boolean;
  resourceTrust: {
    required: boolean;
    decision: boolean | null;
    sourcePath?: string;
  };
};

export type ProjectsState = {
  projects: ProjectAccess[];
  selected?: ProjectAccess;
};

export type RunStatus = "preparing" | "running" | "retrying" | "compacting" | "settled" | "failed" | "aborted" | "interrupted";
export type LiveInputMode = "steer" | "followUp";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type TaskModelState = {
  taskPath: string;
  selected?: { provider: string; id: string; name: string };
  thinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
  fallback?: string;
  providers: Array<{
    id: string;
    name: string;
    builtIn: boolean;
    configured: boolean;
    credentialStatus: string;
    models: Array<{ provider: string; id: string; name: string }>;
  }>;
  usage: {
    contextTokens: number | null;
    contextWindow?: number;
    contextPercent?: number | null;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: number;
  };
};

export type AssistantEvidence = {
  id: string;
  kind: "assistant";
  text: string;
  thinking: string;
};

export type ToolEvidence = {
  id: string;
  kind: "tool";
  name: string;
  summary: string;
  input: string;
  output: string;
  details?: string;
  status: "running" | "succeeded" | "failed";
  outputTruncated?: boolean;
  fullOutputPath?: string;
};

export type CommandEvidence = {
  id: string;
  kind: "command";
  command: string;
  output: string;
  status: "running" | "succeeded" | "failed" | "aborted";
  includeInContext: boolean;
  outputTruncated?: boolean;
  fullOutputPath?: string;
};

export type NoticeEvidence = {
  id: string;
  kind: "notice";
  tone: "attention" | "error";
  title: string;
  detail?: string;
};

export type RetryEvidence = {
  id: string;
  kind: "retry";
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  error: string;
  status: "waiting" | "succeeded" | "failed";
  finalError?: string;
};

export type CompactionEvidence = {
  id: string;
  kind: "compaction";
  reason: "manual" | "threshold" | "overflow";
  status: "running" | "succeeded" | "failed" | "aborted";
  summary?: string;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
  error?: string;
};

export type RunEvidenceItem = AssistantEvidence | ToolEvidence | CommandEvidence | NoticeEvidence | RetryEvidence | CompactionEvidence;

export type RunEvidence = {
  id: string;
  status: RunStatus;
  startedAt: string;
  input: {
    kind: "prompt" | "command" | "compaction";
    text: string;
    includeInContext?: boolean;
  };
  items: RunEvidenceItem[];
};

export type TaskRunState = {
  taskPath: string;
  runs: RunEvidence[];
  activeRunId?: string;
  queues?: {
    steering: string[];
    followUp: string[];
  };
  recoveredInput?: string;
};

export const IMAGE_MIME_LABELS = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/gif": "GIF",
  "image/webp": "WebP",
} as const;
export const MAXIMUM_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAXIMUM_IMAGES = 10;
export type SupportedImageMimeType = keyof typeof IMAGE_MIME_LABELS;

export function detectSupportedImageMimeType(bytes: Uint8Array): SupportedImageMimeType | undefined {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  const header = ascii(0, 6);
  if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
}

export type ImageAttachment = {
  name: string;
  mimeType: SupportedImageMimeType;
  size: number;
  data: string;
};

export type TaskResourceState = {
  taskPath: string;
  commands: Array<{
    name: string;
    kind: "prompt" | "skill";
    description: string;
    argumentHint?: string;
    provenance: {
      scope: "user" | "project" | "temporary";
      source: string;
      origin: "package" | "top-level";
      path: string;
    };
  }>;
  files: string[];
  diagnostics: Array<{ severity: "warning" | "error"; message: string; path?: string }>;
};

export type ProjectsApi = {
  getProjects(): Promise<ProjectsState>;
  addProject(): Promise<ProjectsState>;
  selectProject(path: string): Promise<ProjectsState>;
  removeProject(path: string): Promise<ProjectsState>;
  createTask(projectPath: string): Promise<TaskSummary>;
  getTaskRun(projectPath: string, taskPath: string): Promise<TaskRunState>;
  getTaskModel(projectPath: string, taskPath: string): Promise<TaskModelState>;
  getTaskResources(projectPath: string, taskPath: string): Promise<TaskResourceState>;
  setTaskModel(projectPath: string, taskPath: string, provider: string, modelId: string): Promise<TaskModelState>;
  setTaskThinking(projectPath: string, taskPath: string, level: ThinkingLevel): Promise<TaskModelState>;
  submitPrompt(projectPath: string, taskPath: string, prompt: string, images?: ImageAttachment[]): Promise<void>;
  queuePrompt(taskPath: string, prompt: string, mode: LiveInputMode): Promise<void>;
  executeCommand(projectPath: string, taskPath: string, command: string, includeInContext: boolean): Promise<void>;
  compactTask(projectPath: string, taskPath: string): Promise<void>;
  exportTask(projectPath: string, taskPath: string, format: "jsonl" | "html"): Promise<boolean>;
  abortRetry(taskPath: string): Promise<void>;
  abortTask(taskPath: string): Promise<void>;
  openOutput(path: string): Promise<void>;
  onTaskRunEvent(listener: (state: TaskRunState) => void): () => void;
  setTaskArchived(projectPath: string, taskPath: string, archived: boolean): Promise<ProjectsState>;
  setResourceTrust(path: string, trusted: boolean): Promise<ProjectsState>;
  setExecutionConsent(path: string, consent: boolean): Promise<ProjectsState>;
};
