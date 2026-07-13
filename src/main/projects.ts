import { hasTrustRequiringProjectResources, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectAccess, ProjectSummary, ProjectsState } from "../shared/projects.js";

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

export async function getProjectsState(
  directory: string,
  agentDir: string,
  discovered: ProjectSummary[],
): Promise<ProjectsState> {
  const saved = await load(directory);
  const normalizedDiscovered = await Promise.all(discovered.map(async (project) => ({ ...project, path: await normalize(project.path) })));
  const discoveredByPath = new Map(normalizedDiscovered.map((project) => [project.path, project]));
  const paths = [...saved.recentProjects, ...normalizedDiscovered.map(({ path: projectPath }) => projectPath).filter((projectPath) => !saved.recentProjects.includes(projectPath))];
  const trust = new ProjectTrustStore(agentDir);
  const projects = paths.map<ProjectAccess>((projectPath) => {
    const decision = trust.getEntry(projectPath);
    const found = discoveredByPath.get(projectPath);
    return {
      path: projectPath,
      name: found?.name ?? (path.basename(projectPath) || projectPath),
      taskCount: found?.taskCount ?? 0,
      executionConsent: saved.executionConsent[projectPath] === true,
      resourceTrust: {
        required: hasTrustRequiringProjectResources(projectPath),
        decision: decision?.decision ?? null,
        sourcePath: decision?.path,
      },
    };
  });
  return { projects, selected: projects.find(({ path: projectPath }) => projectPath === saved.selectedProject) };
}

export async function addProject(
  directory: string,
  agentDir: string,
  projectPath: string,
  discovered: ProjectSummary[],
) {
  const saved = await load(directory);
  remember(saved, await canonicalize(projectPath));
  await save(directory, saved);
  return getProjectsState(directory, agentDir, discovered);
}

export async function selectProject(
  directory: string,
  agentDir: string,
  projectPath: string,
  discovered: ProjectSummary[],
) {
  const saved = await load(directory);
  remember(saved, await canonicalize(projectPath));
  await save(directory, saved);
  return getProjectsState(directory, agentDir, discovered);
}

export async function setResourceTrust(
  directory: string,
  agentDir: string,
  projectPath: string,
  trusted: boolean,
  discovered: ProjectSummary[],
) {
  const canonical = await canonicalize(projectPath);
  new ProjectTrustStore(agentDir).set(canonical, trusted);
  return selectProject(directory, agentDir, canonical, discovered);
}

export async function setExecutionConsent(
  directory: string,
  agentDir: string,
  projectPath: string,
  consent: boolean,
  discovered: ProjectSummary[],
) {
  const saved = await load(directory);
  const canonical = await canonicalize(projectPath);
  remember(saved, canonical);
  saved.executionConsent[canonical] = consent;
  await save(directory, saved);
  return getProjectsState(directory, agentDir, discovered);
}

export async function assertExecutionAllowed(directory: string, projectPath: string) {
  const saved = await load(directory);
  if (saved.executionConsent[await canonicalize(projectPath)] !== true) {
    throw new Error("Agent execution consent is required for this Project");
  }
}
