import { DefaultPackageManager, DefaultResourceLoader, ProjectTrustStore, SettingsManager } from "@earendil-works/pi-coding-agent";
import { access, readdir } from "node:fs/promises";
import path from "node:path";
import type { TaskResourceState } from "../shared/projects.js";
import { assertRunnableTask } from "./tasks.js";

export async function loadTaskResources(agentDir: string, projectPath: string, executionPath = projectPath) {
  const trusted = new ProjectTrustStore(agentDir).getEntry(projectPath)?.decision === true;
  const settings = SettingsManager.create(executionPath, agentDir, { projectTrusted: trusted });
  const loader = new DefaultResourceLoader({
    cwd: executionPath,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noThemes: true,
  });
  await loader.reload();
  const settingsErrors = settings.drainErrors();
  if (settingsErrors.length) {
    const first = settingsErrors[0];
    const settingsPath = first.scope === "global" ? path.join(agentDir, "settings.json") : path.join(executionPath, ".pi", "settings.json");
    throw new Error(`Pi ${first.scope} settings could not be read from ${settingsPath}: ${first.error.message}`);
  }

  const resolved = await new DefaultPackageManager({ cwd: executionPath, agentDir, settingsManager: settings })
    .resolve(async () => "skip");
  const unsupported = [
    ...resolved.extensions.filter(({ enabled }) => enabled).map(({ path: resourcePath, metadata }) => ({
      kind: "extension" as const,
      path: resourcePath,
      scope: metadata.scope,
    })),
    ...resolved.themes.filter(({ enabled }) => enabled).map(({ path: resourcePath, metadata }) => ({
      kind: "theme" as const,
      path: resourcePath,
      scope: metadata.scope,
    })),
    ...await access(path.join(agentDir, "keybindings.json")).then(() => [{
      kind: "keybindings" as const,
      path: path.join(agentDir, "keybindings.json"),
      scope: "user" as const,
    }]).catch(() => []),
  ].filter((resource, index, resources) => resources.findIndex((candidate) => candidate.kind === resource.kind && candidate.path === resource.path) === index)
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.path.localeCompare(right.path));
  return { loader, settings, unsupported };
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
  const { project, executionPath } = await assertRunnableTask(agentDir, projectPath, taskPath);
  const [loaded, discovered] = await Promise.all([
    loadTaskResources(agentDir, project, executionPath).then((value) => ({ value })).catch((error: unknown) => ({ error })),
    projectFiles(executionPath),
  ]);
  if (!("value" in loaded)) return {
    taskPath: path.resolve(taskPath),
    commands: [],
    files: discovered.files,
    diagnostics: [{
      severity: "error",
      message: loaded.error instanceof Error ? loaded.error.message : String(loaded.error),
    }, ...discovered.diagnostics],
    unsupported: [],
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
    unsupported: loaded.value.unsupported,
  };
}
