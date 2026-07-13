import { DefaultResourceLoader, ProjectTrustStore, SettingsManager } from "@earendil-works/pi-coding-agent";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { TaskResourceState } from "../shared/projects.js";
import { assertRunnableTask } from "./tasks.js";

export async function loadTaskResources(agentDir: string, project: string) {
  const trusted = new ProjectTrustStore(agentDir).getEntry(project)?.decision === true;
  const settings = SettingsManager.create(project, agentDir, { projectTrusted: trusted });
  const loader = new DefaultResourceLoader({
    cwd: project,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noThemes: true,
  });
  await loader.reload();
  return { loader, settings };
}

async function projectFiles(project: string) {
  const files: string[] = [];
  const diagnostics: TaskResourceState["diagnostics"] = [];

  const visit = async (directory: string, relative = "") => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      diagnostics.push({
        severity: "warning",
        message: error instanceof Error ? error.message : String(error),
        path: relative || ".",
      });
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const child = path.join(directory, entry.name);
      const childRelative = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(child, childRelative);
      else if (entry.isFile()) files.push(childRelative.split(path.sep).join("/"));
      // Symlinks are intentionally not followed: discovery must stay inside the Project.
    }
  };
  await visit(project);
  return { files, diagnostics };
}

function provenance(sourceInfo: { source: string; scope: "user" | "project" | "temporary"; origin: "package" | "top-level"; path: string }) {
  return {
    scope: sourceInfo.scope,
    source: sourceInfo.source,
    origin: sourceInfo.origin,
    path: sourceInfo.path,
  };
}

export async function getTaskResources(agentDir: string, projectPath: string, taskPath: string): Promise<TaskResourceState> {
  const { project } = await assertRunnableTask(agentDir, projectPath, taskPath);
  const [loaded, discovered] = await Promise.all([
    loadTaskResources(agentDir, project).then((value) => ({ value })).catch((error: unknown) => ({ error })),
    projectFiles(project),
  ]);
  if (!("value" in loaded)) return {
    taskPath: path.resolve(taskPath),
    commands: [],
    files: discovered.files,
    diagnostics: [{
      severity: "error",
      message: loaded.error instanceof Error ? loaded.error.message : String(loaded.error),
    }, ...discovered.diagnostics],
  };
  const skills = loaded.value.loader.getSkills();
  const prompts = loaded.value.loader.getPrompts();
  return {
    taskPath: path.resolve(taskPath),
    commands: [
      ...prompts.prompts.map((prompt) => ({
        name: prompt.name,
        kind: "prompt" as const,
        description: prompt.description,
        argumentHint: prompt.argumentHint,
        provenance: provenance(prompt.sourceInfo),
      })),
      ...skills.skills.map((skill) => ({
        name: `skill:${skill.name}`,
        kind: "skill" as const,
        description: skill.description,
        provenance: provenance(skill.sourceInfo),
      })),
    ],
    files: discovered.files,
    diagnostics: [
      ...prompts.diagnostics.map((diagnostic) => ({ severity: diagnostic.type === "error" ? "error" as const : "warning" as const, message: diagnostic.message, path: diagnostic.path })),
      ...skills.diagnostics.map((diagnostic) => ({ severity: diagnostic.type === "error" ? "error" as const : "warning" as const, message: diagnostic.message, path: diagnostic.path })),
      ...discovered.diagnostics,
    ],
  };
}
