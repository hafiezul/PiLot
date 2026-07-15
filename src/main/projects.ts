import { hasTrustRequiringProjectResources, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectAccess, ProjectEnvironmentOverride, ProjectsState, TaskCreationRequest, TaskExecutionLocation } from "../shared/projects.js";
import { createTaskAtExecution, discoverTasks, setTaskLifecycle } from "./tasks.js";
import { getTaskCreationState, withManagedWorktree } from "./worktrees.js";

type SavedProjects = {
  recentProjects: string[];
  selectedProject?: string;
  executionConsent: Record<string, boolean>;
  setupCommands: Record<string, string>;
  environmentOverrides: Record<string, Record<string, string>>;
};

const defaults: SavedProjects = { recentProjects: [], executionConsent: {}, setupCommands: {}, environmentOverrides: {} };
const maximumSetupCommandLength = 20_000;
const maximumEnvironmentOverrides = 128;
const maximumEnvironmentOverrideLength = 128 * 1024;
const environmentVariableNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export class ProjectStateLoadError extends Error {
  constructor(target: string, problem: string, cause?: unknown) {
    super(
      `Could not load PiLot Project state from ${target}: ${problem}. Repair the file, or delete it to reset recent Projects and execution consent, then retry.`,
      { cause },
    );
    this.name = "ProjectStateLoadError";
  }
}

const projectStateLoadError = (target: string, problem: string, cause?: unknown) =>
  new ProjectStateLoadError(target, problem, cause);

function isSavedProjectPath(value: unknown): value is string {
  return typeof value === "string" && Boolean(value) && !value.includes("\0") && path.isAbsolute(value);
}

function isValidSetupCommand(value: string) {
  return value.length <= maximumSetupCommandLength && !value.includes("\0");
}

function savedRecord<T>(
  value: unknown,
  target: string,
  field: string,
  description: string,
  valid: (entry: unknown) => entry is T,
): Record<string, T> {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.entries(value).some(([projectPath, entry]) => !isSavedProjectPath(projectPath) || !valid(entry))) {
    throw projectStateLoadError(target, `\"${field}\" must be ${description}`);
  }
  return Object.fromEntries(Object.entries(value)) as Record<string, T>;
}

function savedEnvironmentOverrides(value: unknown, target: string) {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw projectStateLoadError(target, '"environmentOverrides" must be an object of Project environment maps');
  }
  const saved: Record<string, Record<string, string>> = {};
  for (const [projectPath, overrides] of Object.entries(value)) {
    if (!isSavedProjectPath(projectPath) || !isRecord(overrides)) {
      throw projectStateLoadError(target, '"environmentOverrides" must be keyed by absolute Project paths');
    }
    const entries = Object.entries(overrides);
    const names = new Set<string>();
    let totalLength = 0;
    for (const [name, entry] of entries) {
      const comparableName = process.platform === "win32" ? name.toLocaleLowerCase() : name;
      totalLength += name.length + (typeof entry === "string" ? entry.length : 0);
      if (!environmentVariableNamePattern.test(name) || typeof entry !== "string" || entry.includes("\0")
        || names.has(comparableName) || entries.length > maximumEnvironmentOverrides || totalLength > maximumEnvironmentOverrideLength) {
        throw projectStateLoadError(target, '"environmentOverrides" must contain at most 128 valid environment variables totaling 128 KB or less');
      }
      names.add(comparableName);
    }
    saved[projectPath] = Object.fromEntries(entries) as Record<string, string>;
  }
  return saved;
}

function savedProjects(value: unknown, target: string): SavedProjects {
  if (!isRecord(value)) throw projectStateLoadError(target, "the top-level value must be an object");
  if (value.recentProjects !== undefined
    && (!Array.isArray(value.recentProjects) || value.recentProjects.some((entry) => !isSavedProjectPath(entry)))) {
    throw projectStateLoadError(target, '"recentProjects" must be an array of absolute Project paths');
  }
  if (value.selectedProject !== undefined && !isSavedProjectPath(value.selectedProject)) {
    throw projectStateLoadError(target, '"selectedProject" must be an absolute Project path');
  }
  return {
    recentProjects: value.recentProjects === undefined ? [] : [...value.recentProjects] as string[],
    ...(typeof value.selectedProject === "string" ? { selectedProject: value.selectedProject } : {}),
    executionConsent: savedRecord(value.executionConsent, target, "executionConsent", "an object keyed by absolute Project paths with only boolean values", (entry): entry is boolean => typeof entry === "boolean"),
    setupCommands: savedRecord(value.setupCommands, target, "setupCommands", "an object of bounded strings keyed by absolute Project paths", (entry): entry is string => typeof entry === "string" && isValidSetupCommand(entry)),
    environmentOverrides: savedEnvironmentOverrides(value.environmentOverrides, target),
  };
}

async function load(directory: string): Promise<SavedProjects> {
  const target = path.join(directory, "projects.json");
  let contents: string;
  try {
    contents = await readFile(target, "utf8");
  } catch (cause) {
    const code = cause && typeof cause === "object" ? (cause as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT") return structuredClone(defaults);
    throw projectStateLoadError(target, `projects.json could not be read${code ? ` (${code})` : ""}; check its permissions`, cause);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (cause) {
    throw projectStateLoadError(target, "projects.json contains malformed JSON", cause);
  }
  return savedProjects(parsed, target);
}

async function save(directory: string, projects: SavedProjects) {
  const target = path.join(directory, "projects.json");
  const temporary = `${target}.tmp`;
  await mkdir(directory, { recursive: true });
  await writeFile(temporary, JSON.stringify(projects, null, 2));
  await rename(temporary, target);
}

const normalize = (projectPath: string) => realpath(projectPath).catch(() => path.resolve(projectPath));

async function canonicalize(projectPath: string) {
  const canonical = await normalize(projectPath);
  if (!(await stat(canonical)).isDirectory()) throw new Error("A Project must be a directory");
  return canonical;
}

function remember(saved: SavedProjects, projectPath: string) {
  saved.recentProjects = [projectPath, ...saved.recentProjects.filter((item) => item !== projectPath)];
  saved.selectedProject = projectPath;
}

async function projectAccess(
  saved: SavedProjects,
  agentDir: string,
  projectPath: string,
  admitted: boolean,
): Promise<ProjectAccess> {
  const trust = new ProjectTrustStore(agentDir).getEntry(projectPath);
  const discovery = admitted ? await discoverTasks(agentDir, projectPath) : { tasks: [], diagnostics: [] };
  return {
    path: projectPath,
    name: path.basename(projectPath) || projectPath,
    admitted,
    tasks: discovery.tasks,
    diagnostics: discovery.diagnostics,
    taskCount: discovery.tasks.length,
    executionConsent: saved.executionConsent[projectPath] === true,
    environmentOverrides: Object.entries(saved.environmentOverrides[projectPath] ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => ({ name, value })),
    resourceTrust: {
      required: hasTrustRequiringProjectResources(projectPath),
      decision: trust?.decision ?? null,
      sourcePath: trust?.path,
    },
  };
}

export async function getProjectsState(
  directory: string,
  agentDir: string,
  candidatePath?: string,
): Promise<ProjectsState> {
  const saved = await load(directory);
  const paths = await Promise.all(saved.recentProjects.map(normalize));
  saved.recentProjects = [...new Set(paths)];
  const projects = [];
  for (const projectPath of saved.recentProjects) projects.push(await projectAccess(saved, agentDir, projectPath, true));
  const selectedPath = candidatePath ? await normalize(candidatePath) : saved.selectedProject;
  const selected = projects.find(({ path: projectPath }) => projectPath === selectedPath)
    ?? (selectedPath ? await projectAccess(saved, agentDir, selectedPath, false) : undefined);
  return { projects, selected };
}

export async function addProject(directory: string, agentDir: string, projectPath: string) {
  const canonical = await canonicalize(projectPath);
  const saved = await load(directory);
  if (saved.recentProjects.includes(canonical)) {
    remember(saved, canonical);
    await save(directory, saved);
    return getProjectsState(directory, agentDir);
  }
  return getProjectsState(directory, agentDir, canonical);
}

export async function selectProject(directory: string, agentDir: string, projectPath: string) {
  const saved = await load(directory);
  const canonical = await canonicalize(projectPath);
  if (!saved.recentProjects.includes(canonical)) throw new Error("Admit this folder before selecting it as a Project");
  remember(saved, canonical);
  await save(directory, saved);
  return getProjectsState(directory, agentDir);
}

export async function removeProject(directory: string, agentDir: string, projectPath: string) {
  const saved = await load(directory);
  const canonical = await normalize(projectPath);
  saved.recentProjects = saved.recentProjects.filter((item) => item !== canonical);
  delete saved.executionConsent[canonical];
  delete saved.setupCommands[canonical];
  delete saved.environmentOverrides[canonical];
  if (saved.selectedProject === canonical) saved.selectedProject = saved.recentProjects[0];
  await save(directory, saved);
  return getProjectsState(directory, agentDir);
}

export async function getTaskCreation(directory: string, agentDir: string, projectPath: string, environment: NodeJS.ProcessEnv = process.env) {
  const saved = await load(directory);
  const canonical = await canonicalize(projectPath);
  if (!saved.recentProjects.includes(canonical)) throw new Error("Admit this Project before creating a Task");
  if (saved.executionConsent[canonical] !== true) throw new Error("Agent execution consent is required for this Project");
  return { ...await getTaskCreationState(canonical, environment), setupCommand: saved.setupCommands[canonical] ?? "" };
}

function normalizedSetupCommand(value?: string) {
  const command = value?.trim() ?? "";
  if (!isValidSetupCommand(command)) throw new Error("Project setup commands must be 20,000 characters or fewer");
  return command;
}

type TaskExecutionPlan = { execution: TaskExecutionLocation; setupCommand?: string };

export async function withTaskExecution<T>(
  directory: string,
  agentDir: string,
  projectPath: string,
  request: TaskCreationRequest,
  operation: (plan: TaskExecutionPlan) => Promise<T>,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const saved = await load(directory);
  const canonical = await canonicalize(projectPath);
  if (!saved.recentProjects.includes(canonical)) throw new Error("Admit this Project before creating a Task");
  if (saved.executionConsent[canonical] !== true) throw new Error("Agent execution consent is required for this Project");
  if (!request || (request.kind !== "local" && request.kind !== "worktree")) throw new Error("Choose an Execution location");
  if (request.kind === "local") return operation({ execution: { kind: "local", path: canonical } });

  const command = normalizedSetupCommand(request.setupCommand);
  if (command && new ProjectTrustStore(agentDir).getEntry(canonical)?.decision !== true) {
    throw new Error("Trust Project resources before saving a setup command");
  }
  if (command) saved.setupCommands[canonical] = command;
  else delete saved.setupCommands[canonical];
  remember(saved, canonical);
  await save(directory, saved);
  return withManagedWorktree(directory, canonical, request.ref, (execution) =>
    operation({ execution, ...(command ? { setupCommand: command } : {}) }), environment);
}

export function createTask(directory: string, agentDir: string, projectPath: string, request: TaskCreationRequest, environment: NodeJS.ProcessEnv = process.env) {
  return withTaskExecution(directory, agentDir, projectPath, request, ({ execution, setupCommand }) =>
    createTaskAtExecution(agentDir, projectPath, execution, setupCommand), environment);
}

export async function setTaskArchived(
  directory: string,
  agentDir: string,
  projectPath: string,
  taskPath: string,
  archived: boolean,
) {
  const saved = await load(directory);
  const canonical = await canonicalize(projectPath);
  if (!saved.recentProjects.includes(canonical)) throw new Error("Admit this Project before changing its Tasks");
  await setTaskLifecycle(agentDir, canonical, taskPath, archived ? "archived" : "active");
  remember(saved, canonical);
  await save(directory, saved);
  return getProjectsState(directory, agentDir);
}

export async function setResourceTrust(
  directory: string,
  agentDir: string,
  projectPath: string,
  trusted: boolean,
) {
  const saved = await load(directory);
  const canonical = await canonicalize(projectPath);
  new ProjectTrustStore(agentDir).set(canonical, trusted);
  if (saved.recentProjects.includes(canonical)) {
    remember(saved, canonical);
    await save(directory, saved);
    return getProjectsState(directory, agentDir);
  }
  return getProjectsState(directory, agentDir, canonical);
}

export async function setExecutionConsent(
  directory: string,
  agentDir: string,
  projectPath: string,
  consent: boolean,
) {
  const saved = await load(directory);
  const canonical = await canonicalize(projectPath);
  const admitted = saved.recentProjects.includes(canonical);
  if (!admitted && consent) {
    const trust = new ProjectTrustStore(agentDir);
    if (trust.getEntry(canonical)?.decision !== true) {
      if (hasTrustRequiringProjectResources(canonical)) throw new Error("Trust Project resources before allowing agent execution");
      trust.set(canonical, true);
    }
  }
  if (!admitted && !consent) return getProjectsState(directory, agentDir, canonical);
  remember(saved, canonical);
  saved.executionConsent[canonical] = consent;
  await save(directory, saved);
  return getProjectsState(directory, agentDir);
}

export async function assertProjectAdmitted(directory: string, projectPath: string) {
  const saved = await load(directory);
  if (!saved.recentProjects.includes(await canonicalize(projectPath))) throw new Error("Admit this Project before opening external applications");
}

export async function assertExecutionAllowed(directory: string, projectPath: string) {
  const saved = await load(directory);
  if (saved.executionConsent[await canonicalize(projectPath)] !== true) {
    throw new Error("Agent execution consent is required for this Project");
  }
}

export async function getProjectEnvironmentOverrides(directory: string, projectPath: string) {
  const saved = await load(directory);
  const canonical = await canonicalize(projectPath);
  if (!saved.recentProjects.includes(canonical)) throw new Error("Admit this Project before using environment overrides");
  return { ...(saved.environmentOverrides[canonical] ?? {}) };
}

function normalizedEnvironmentOverrides(overrides: ProjectEnvironmentOverride[]) {
  if (!Array.isArray(overrides) || overrides.length > maximumEnvironmentOverrides) throw new Error("Save no more than 128 Project environment variables");
  const normalized: Record<string, string> = {};
  let totalLength = 0;
  for (const override of overrides) {
    if (!override || typeof override !== "object" || typeof override.name !== "string" || typeof override.value !== "string") {
      throw new Error("Each Project environment override needs a name and value");
    }
    const name = override.name.trim();
    if (!environmentVariableNamePattern.test(name)) {
      throw new Error(`${name || "Variable names"} must start with a letter or underscore and contain only letters, numbers, and underscores`);
    }
    const duplicate = Object.keys(normalized).find((candidate) => process.platform === "win32"
      ? candidate.toLocaleLowerCase() === name.toLocaleLowerCase()
      : candidate === name);
    if (duplicate) throw new Error(`${name} is listed more than once`);
    totalLength += name.length + override.value.length;
    if (override.value.includes("\0") || totalLength > maximumEnvironmentOverrideLength) throw new Error("Project environment overrides must be 128 KB or smaller");
    normalized[name] = override.value;
  }
  return normalized;
}

export async function setProjectEnvironmentOverrides(
  directory: string,
  agentDir: string,
  projectPath: string,
  overrides: ProjectEnvironmentOverride[],
) {
  const saved = await load(directory);
  const canonical = await canonicalize(projectPath);
  if (!saved.recentProjects.includes(canonical)) throw new Error("Admit this Project before saving environment overrides");
  const normalized = normalizedEnvironmentOverrides(overrides);
  if (Object.keys(normalized).length) saved.environmentOverrides[canonical] = normalized;
  else delete saved.environmentOverrides[canonical];
  remember(saved, canonical);
  await save(directory, saved);
  return getProjectsState(directory, agentDir);
}
