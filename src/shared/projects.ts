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

export type RunStatus = "preparing" | "running" | "settled" | "failed" | "aborted" | "interrupted";
export type LiveInputMode = "steer" | "followUp";

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

export type RunEvidenceItem = AssistantEvidence | ToolEvidence | CommandEvidence | NoticeEvidence;

export type RunEvidence = {
  id: string;
  status: RunStatus;
  startedAt: string;
  input: {
    kind: "prompt" | "command";
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

export type ProjectsApi = {
  getProjects(): Promise<ProjectsState>;
  addProject(): Promise<ProjectsState>;
  selectProject(path: string): Promise<ProjectsState>;
  removeProject(path: string): Promise<ProjectsState>;
  createTask(projectPath: string): Promise<TaskSummary>;
  getTaskRun(projectPath: string, taskPath: string): Promise<TaskRunState>;
  submitPrompt(projectPath: string, taskPath: string, prompt: string): Promise<void>;
  queuePrompt(taskPath: string, prompt: string, mode: LiveInputMode): Promise<void>;
  executeCommand(projectPath: string, taskPath: string, command: string, includeInContext: boolean): Promise<void>;
  abortTask(taskPath: string): Promise<void>;
  openOutput(path: string): Promise<void>;
  onTaskRunEvent(listener: (state: TaskRunState) => void): () => void;
  setTaskArchived(projectPath: string, taskPath: string, archived: boolean): Promise<ProjectsState>;
  setResourceTrust(path: string, trusted: boolean): Promise<ProjectsState>;
  setExecutionConsent(path: string, consent: boolean): Promise<ProjectsState>;
};
