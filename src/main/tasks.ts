import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { appendFile, open, readdir, realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { ProjectDiagnostic, TaskSummary } from "../shared/projects.js";

const metadataType = "pilot.task";
const maximumTasks = 500;

type Header = { type?: string; version?: number; id?: string; cwd?: string };
type TaskMetadata = { title?: string; lifecycle?: "active" | "archived" };
type Inspection = { task?: TaskSummary; incompatible?: boolean; malformed?: boolean; enrichmentFailed?: boolean };

export function getProjectSessionDirectory(agentDir: string, projectPath: string) {
  const encoded = path.resolve(projectPath).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
  return path.join(agentDir, "sessions", `--${encoded}--`);
}

function text(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => part && typeof part === "object" && (part as { type?: string }).type === "text"
    ? [(part as { text?: unknown }).text]
    : []).filter((part): part is string => typeof part === "string").join(" ");
}

function safeTitle(value: string) {
  const title = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!title) return "Untitled task";
  return title.length > 80 ? `${title.slice(0, 79).trimEnd()}…` : title;
}

async function normalize(value: string) {
  return realpath(value).catch(() => path.resolve(value));
}

async function appendMetadata(file: string, parentId: string | null, data: Required<TaskMetadata>) {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const last = Buffer.alloc(1);
    if (size) await handle.read(last, 0, 1, size - 1);
    const prefix = size && last[0] !== 10 ? "\n" : "";
    const entry = {
      type: "custom",
      customType: metadataType,
      data: { version: 1, ...data },
      id: randomUUID(),
      parentId,
      timestamp: new Date().toISOString(),
    };
    await appendFile(file, `${prefix}${JSON.stringify(entry)}\n`);
  } finally {
    await handle.close();
  }
}

async function readHeader(file: string): Promise<Header | undefined> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
    const header = JSON.parse(line) as Header;
    return header.type === "session" && typeof header.id === "string" && typeof header.cwd === "string" ? header : undefined;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

async function inspect(file: string, projectPath: string): Promise<Inspection> {
  let header: Header | undefined;
  let malformed = false;
  let firstMessage = "";
  let sessionName = "";
  let metadata: TaskMetadata | undefined;
  let lastId: string | null = null;

  try {
    const modified = await stat(file);
    const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        malformed = true;
        continue;
      }
      if (!header) {
        header = entry;
        if (header.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") return { malformed: true };
        if (await normalize(header.cwd) !== projectPath) return {};
        if ((header.version ?? 1) > CURRENT_SESSION_VERSION) return { incompatible: true };
        continue;
      }
      if (typeof entry.id === "string") lastId = entry.id;
      if (entry.type === "session_info") sessionName = typeof entry.name === "string" ? entry.name : "";
      if (entry.type === "custom" && entry.customType === metadataType && entry.data && typeof entry.data === "object") {
        const data = entry.data as TaskMetadata;
        metadata = {
          title: typeof data.title === "string" ? data.title : undefined,
          lifecycle: data.lifecycle === "archived" ? "archived" : "active",
        };
      }
      if (!firstMessage && entry.type === "message" && entry.message && typeof entry.message === "object") {
        const message = entry.message as { role?: unknown; content?: unknown };
        if (message.role === "user") firstMessage = text(message.content);
      }
    }
    if (!header) return { malformed: true };

    const title = safeTitle(sessionName || metadata?.title || firstMessage);
    const lifecycle = metadata?.lifecycle ?? "active";
    let enrichmentFailed = false;
    if (!metadata && !malformed && (header.version ?? 1) === CURRENT_SESSION_VERSION) {
      try {
        await appendMetadata(file, lastId, { title, lifecycle });
      } catch {
        enrichmentFailed = true;
      }
    }
    return {
      task: { id: header.id!, path: file, title, lifecycle, modified: modified.mtime.toISOString() },
      malformed,
      enrichmentFailed,
    };
  } catch {
    return { malformed: true };
  }
}

export async function discoverTasks(agentDir: string, projectPath: string) {
  const diagnostics: ProjectDiagnostic[] = [];
  const sessionRoot = path.join(agentDir, "sessions");
  const canonicalDirectory = getProjectSessionDirectory(agentDir, projectPath);
  let files: string[] = [];
  try {
    const directories = (await readdir(sessionRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    for (const directory of directories) {
      const child = path.join(sessionRoot, directory.name);
      try {
        files.push(...(await readdir(child, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
          .map((entry) => path.join(child, entry.name)));
      } catch {
        if (child === canonicalDirectory) diagnostics.push({
          title: "Task history is unavailable",
          detail: "PiLot could not read this Project's Pi task folder. Check its permissions and try again.",
        });
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.push({
      title: "Task history is unavailable",
      detail: "PiLot could not read Pi task folders. Check their permissions and try again.",
    });
    return { tasks: [], diagnostics };
  }

  const malformedByDirectory = new Map<string, number>();
  const matchingDirectories = new Set<string>([canonicalDirectory]);
  const matching: string[] = [];
  for (const file of files) {
    const directory = path.dirname(file);
    const header = await readHeader(file);
    if (!header) {
      malformedByDirectory.set(directory, (malformedByDirectory.get(directory) ?? 0) + 1);
      continue;
    }
    if (await normalize(header.cwd!) === projectPath) {
      matching.push(file);
      matchingDirectories.add(directory);
    }
  }
  const malformedInProjectDirectory = [...malformedByDirectory]
    .filter(([directory]) => matchingDirectories.has(directory))
    .reduce((sum, [, count]) => sum + count, 0);
  files = matching.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
  if (files.length > maximumTasks) diagnostics.push({
    title: "Some Tasks are not shown",
    detail: `This Project has ${files.length} Pi task files. PiLot loaded the newest ${maximumTasks}; archive or move older history to inspect it here.`,
  });

  const inspections = [];
  for (const file of files.slice(0, maximumTasks)) inspections.push(await inspect(file, projectPath));
  for (let count = 0; count < malformedInProjectDirectory; count++) inspections.push({ malformed: true });
  const incompatible = inspections.filter((item) => item.incompatible).length;
  const malformed = inspections.filter((item) => item.malformed).length;
  const enrichmentFailed = inspections.filter((item) => item.enrichmentFailed).length;
  if (incompatible) diagnostics.push({
    title: "Update PiLot to open newer Tasks",
    detail: `${incompatible} Task${incompatible === 1 ? " uses" : "s use"} a newer Pi format and remains untouched.`,
  });
  if (malformed) diagnostics.push({
    title: "Review unreadable Task history",
    detail: `${malformed} Pi task file${malformed === 1 ? " could" : "s could"} not be read safely and remains untouched.`,
  });
  if (enrichmentFailed) diagnostics.push({
    title: "Some Task details could not be saved",
    detail: `PiLot found ${enrichmentFailed} Task${enrichmentFailed === 1 ? "" : "s"}, but could not append its compatibility metadata. Check file permissions.`,
  });
  return {
    tasks: inspections.flatMap((item) => item.task ? [item.task] : []).sort((a, b) => b.modified.localeCompare(a.modified)),
    diagnostics,
  };
}

export async function setTaskLifecycle(agentDir: string, projectPath: string, taskPath: string, lifecycle: "active" | "archived") {
  const canonicalProject = await normalize(projectPath);
  const { tasks } = await discoverTasks(agentDir, canonicalProject);
  const task = tasks.find(({ path: file }) => file === path.resolve(taskPath));
  if (!task) throw new Error("This Task does not belong to the admitted Project");
  const header = await readHeader(task.path);
  if (!header || (header.version ?? 1) < 2 || (header.version ?? 1) > CURRENT_SESSION_VERSION) {
    throw new Error("Update this Task's Pi format before changing its lifecycle");
  }
  let parentId: string | null = null;
  const lines = createInterface({ input: createReadStream(task.path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let entry: { id?: unknown };
    try { entry = JSON.parse(line) as { id?: unknown }; } catch { throw new Error("Repair this Task's unreadable history before changing its lifecycle"); }
    if (typeof entry.id === "string") parentId = entry.id;
  }
  await appendMetadata(task.path, parentId, { title: task.title, lifecycle });
}
