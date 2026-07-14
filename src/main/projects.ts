import { hasTrustRequiringProjectResources, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectAccess, ProjectsState } from "../shared/projects.js";
import { createLocalTask, discoverTasks, setTaskLifecycle } from "./tasks.js";

type SavedProjects = {
  recentProjects: string[];
  selectedProject?: string;
  executionConsent: Record<string, boolean>;
};

const defaults: SavedProjects = { recentProjects: [], executionConsent: {} };

async function load(directory: string): Promise<SavedProjects> {
  try {
    const saved = JSON.parse(await readFile(path.join(directory, "projects.json"), "utf8")) as Partial<SavedProjects>;
    return {
      recentProjects: Array.isArray(saved.recentProjects) ? saved.recentProjects.filter((item): item is string => typeof item === "string") : [],
      selectedProject: typeof saved.selectedProject === "string" ? saved.selectedProject : undefined,
      executionConsent: saved.executionConsent && typeof saved.executionConsent === "object" ? saved.executionConsent : {},
    };
  } catch {
    return structuredClone(defaults);
  }
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
  if (saved.selectedProject === canonical) saved.selectedProject = saved.recentProjects[0];
  await save(directory, saved);
  return getProjectsState(directory, agentDir);
}

export async function createTask(directory: string, agentDir: string, projectPath: string) {
  const saved = await load(directory);
  const canonical = await canonicalize(projectPath);
  if (!saved.recentProjects.includes(canonical)) throw new Error("Admit this Project before creating a Task");
  if (saved.executionConsent[canonical] !== true) throw new Error("Agent execution consent is required for this Project");
  return createLocalTask(agentDir, canonical);
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
  const canonical = await canonicalize(projectPath);
  new ProjectTrustStore(agentDir).set(canonical, trusted);
  const saved = await load(directory);
  if (saved.recentProjects.includes(canonical)) return selectProject(directory, agentDir, canonical);
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
