import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import type { EditorId } from "../shared/editors.js";
import type { ChangeStatus, DiffHunk, TaskChanges, TaskFileDiff } from "../shared/projects.js";
import { getConfiguredEditor, launchEditor } from "./editors.js";
import { assertProjectAdmitted } from "./projects.js";
import { assertRunnableTask } from "./tasks.js";

const maximumDiffBytes = 16 * 1024 * 1024;
const maximumGitOutputBytes = 32 * 1024 * 1024;
type ChangeStats = { additions: number; deletions: number; binary: boolean };
const untrackedStatsCache = new Map<string, ChangeStats & { mtimeMs: number; size: number }>();
const taskChangesCache = new Map<string, TaskChanges>();

function taskChangesKey(projectPath: string, taskPath: string) {
  return `${path.resolve(projectPath)}\0${path.resolve(taskPath)}`;
}

function git(cwd: string, args: string[], maxBuffer = maximumGitOutputBytes) {
  return new Promise<string>((resolve, reject) => {
    execFile("git", ["--no-optional-locks", "--literal-pathspecs", ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer,
      env: { ...process.env, GIT_PAGER: "cat" },
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

function gitPath(value: string) {
  return value.split(path.sep).join("/");
}

function resolveChangePath(executionPath: string, value: string) {
  if (!value || path.isAbsolute(value)) throw new Error("Choose a changed file in this Execution location");
  const target = path.resolve(executionPath, value);
  const relative = path.relative(executionPath, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Choose a changed file in this Execution location");
  }
  return target;
}

function statusFromCode(code: string): ChangeStatus {
  if (code.startsWith("R")) return "renamed";
  if (code.startsWith("C")) return "copied";
  if (code.startsWith("D")) return "deleted";
  if (code.startsWith("A")) return "added";
  if (code.startsWith("T")) return "type-changed";
  if (code.startsWith("U")) return "unmerged";
  return "modified";
}

function parseNameStatus(output: string) {
  const records = output.split("\0");
  const files: Array<{ path: string; previousPath?: string; status: ChangeStatus }> = [];
  for (let index = 0; index < records.length;) {
    const code = records[index++];
    if (!code) continue;
    const moved = code.startsWith("R") || code.startsWith("C");
    const firstPath = records[index++] ?? "";
    const filePath = moved ? records[index++] ?? "" : firstPath;
    if (!filePath) continue;
    files.push({
      path: gitPath(filePath),
      ...(moved && firstPath ? { previousPath: gitPath(firstPath) } : {}),
      status: statusFromCode(code),
    });
  }
  return files;
}

function parseNumstat(output: string) {
  const records = output.split("\0");
  const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (let index = 0; index < records.length;) {
    const record = records[index++];
    if (!record) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const added = record.slice(0, firstTab);
    const deleted = record.slice(firstTab + 1, secondTab);
    let filePath = record.slice(secondTab + 1);
    if (!filePath) {
      index += 1; // pre-image path
      filePath = records[index++] ?? "";
    }
    if (!filePath) continue;
    const binary = added === "-" || deleted === "-";
    stats.set(gitPath(filePath), {
      additions: binary ? 0 : Number(added) || 0,
      deletions: binary ? 0 : Number(deleted) || 0,
      binary,
    });
  }
  return stats;
}

async function untrackedStats(executionPath: string, filePath: string) {
  const target = resolveChangePath(executionPath, filePath);
  const info = await lstat(target);
  const cached = untrackedStatsCache.get(target);
  if (cached?.mtimeMs === info.mtimeMs && cached.size === info.size) return cached;
  const remember = (stats: ChangeStats) => {
    untrackedStatsCache.set(target, { ...stats, mtimeMs: info.mtimeMs, size: info.size });
    return stats;
  };
  if (info.isSymbolicLink()) return remember({ additions: 1, deletions: 0, binary: false });
  if (!info.isFile()) return remember({ additions: 0, deletions: 0, binary: true });
  let additions = 0;
  let bytes = 0;
  let lastByte = -1;
  let binary = false;
  for await (const value of createReadStream(target)) {
    const chunk = value as Buffer;
    bytes += chunk.length;
    lastByte = chunk.at(-1) ?? lastByte;
    if (!binary && chunk.includes(0)) binary = true;
    if (!binary) for (const byte of chunk) if (byte === 10) additions += 1;
  }
  if (!binary && bytes && lastByte !== 10) additions += 1;
  return remember({ additions: binary ? 0 : additions, deletions: 0, binary });
}

async function hasHead(executionPath: string) {
  try {
    await git(executionPath, ["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

export async function getTaskChanges(agentDir: string, projectPath: string, taskPath: string): Promise<TaskChanges> {
  const { file, executionPath } = await assertRunnableTask(agentDir, projectPath, taskPath);
  const checkedAt = Date.now();
  const finish = (changes: TaskChanges) => {
    taskChangesCache.set(taskChangesKey(projectPath, taskPath), changes);
    return changes;
  };
  try {
    if ((await git(executionPath, ["rev-parse", "--is-inside-work-tree"])).trim() !== "true") {
      return finish({ taskPath: file, executionPath, repository: false, checkedAt, files: [], additions: 0, deletions: 0 });
    }
  } catch {
    return finish({ taskPath: file, executionPath, repository: false, checkedAt, files: [], additions: 0, deletions: 0 });
  }

  const head = await hasHead(executionPath);
  const [trackedOutput, untrackedOutput, numstatOutput] = await Promise.all([
    head
      ? git(executionPath, ["diff", "--no-ext-diff", "--no-color", "--find-renames", "--name-status", "-z", "--relative", "HEAD", "--", "."])
      : git(executionPath, ["ls-files", "--cached", "-z", "--", "."]),
    git(executionPath, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."]),
    head
      ? git(executionPath, ["diff", "--no-ext-diff", "--no-color", "--find-renames", "--numstat", "-z", "--relative", "HEAD", "--", "."])
      : Promise.resolve(""),
  ]);
  const statuses: Array<{ path: string; previousPath?: string; status: ChangeStatus }> = head
    ? parseNameStatus(trackedOutput)
    : trackedOutput.split("\0").filter(Boolean).map((filePath) => ({ path: gitPath(filePath), status: "added" as const }));
  const trackedPaths = new Set(statuses.map(({ path }) => path));
  for (const filePath of untrackedOutput.split("\0").filter(Boolean).map(gitPath)) {
    if (!trackedPaths.has(filePath)) statuses.push({ path: filePath, status: "untracked" });
  }
  const trackedStats = parseNumstat(numstatOutput);
  const files = await Promise.all(statuses.map(async (change) => {
    const stats = trackedStats.get(change.path)
      ?? (change.status === "untracked" || (!head && change.status !== "deleted")
        ? await untrackedStats(executionPath, change.path)
        : { additions: 0, deletions: 0, binary: false });
    return { ...change, ...stats };
  }));
  files.sort((left, right) => left.path.localeCompare(right.path));
  return finish({
    taskPath: file,
    executionPath,
    repository: true,
    checkedAt,
    files,
    additions: files.reduce((total, change) => total + change.additions, 0),
    deletions: files.reduce((total, change) => total + change.deletions, 0),
  });
}

function parseUnifiedDiff(value: string) {
  const metadata: string[] = [];
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  for (const valueLine of value.split("\n")) {
    if (/^(?:old mode|new mode|new file mode|deleted file mode|similarity index|rename from|rename to|copy from|copy to) /.test(valueLine)) {
      metadata.push(valueLine);
      continue;
    }
    if (valueLine.startsWith("@@")) {
      const match = valueLine.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!match) continue;
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      current = {
        header: valueLine,
        oldStart: oldLine,
        oldCount: Number(match[2] ?? 1),
        newStart: newLine,
        newCount: Number(match[4] ?? 1),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    const marker = valueLine[0];
    if (marker === "+") current.lines.push({ kind: "addition", newLine: newLine++, text: valueLine.slice(1) });
    else if (marker === "-") current.lines.push({ kind: "deletion", oldLine: oldLine++, text: valueLine.slice(1) });
    else if (marker === " ") current.lines.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, text: valueLine.slice(1) });
    else if (marker === "\\") current.lines.push({ kind: "meta", text: valueLine });
  }
  return { metadata, hunks };
}

async function syntheticDiff(executionPath: string, filePath: string): Promise<{ binary: boolean; truncated: boolean; metadata: string[]; hunks: DiffHunk[] }> {
  const target = resolveChangePath(executionPath, filePath);
  const info = await lstat(target);
  const content = info.isSymbolicLink()
    ? await readlink(target)
    : info.size > maximumDiffBytes ? undefined : await readFile(target, "utf8");
  if (content === undefined) return { binary: false, truncated: true, metadata: [], hunks: [] };
  if (content.includes("\0")) return { binary: true, truncated: false, metadata: [], hunks: [] };
  const lines = content ? content.split(/\r?\n/) : [];
  if (content.endsWith("\n")) lines.pop();
  const hunk: DiffHunk = {
    header: `@@ -0,0 +1,${lines.length} @@`,
    oldStart: 0,
    oldCount: 0,
    newStart: 1,
    newCount: lines.length,
    lines: lines.map((text, index) => ({ kind: "addition" as const, newLine: index + 1, text })),
  };
  if (content && !content.endsWith("\n")) hunk.lines.push({ kind: "meta", text: "\\ No newline at end of file" });
  return { binary: false, truncated: false, metadata: [], hunks: lines.length || content ? [hunk] : [] };
}

export async function getTaskFileDiff(agentDir: string, projectPath: string, taskPath: string, filePath: string): Promise<TaskFileDiff> {
  const cached = taskChangesCache.get(taskChangesKey(projectPath, taskPath));
  const changes = cached && Date.now() - cached.checkedAt < 5_000
    ? cached
    : await getTaskChanges(agentDir, projectPath, taskPath);
  const change = changes.files.find((candidate) => candidate.path === gitPath(filePath));
  if (!changes.repository || !change) throw new Error("That file is no longer changed");
  if (change.binary) return { ...change, taskPath: changes.taskPath, binary: true, truncated: false, metadata: [], hunks: [] };
  const head = await hasHead(changes.executionPath);
  if (change.status === "untracked" || (!head && change.status !== "deleted")) {
    const diff = await syntheticDiff(changes.executionPath, change.path);
    return { ...change, ...diff, taskPath: changes.taskPath };
  }
  try {
    const paths = [change.previousPath, change.path].filter((value): value is string => Boolean(value));
    const output = await git(changes.executionPath, [
      "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", "--relative", "--unified=3", "HEAD", "--", ...paths,
    ]);
    return { ...change, taskPath: changes.taskPath, truncated: false, ...parseUnifiedDiff(output) };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return { ...change, taskPath: changes.taskPath, truncated: true, metadata: [], hunks: [] };
    }
    throw error;
  }
}

export async function openTaskPathInEditor(userDataDir: string, agentDir: string, projectPath: string, taskPath: string, editor: EditorId, filePath?: string) {
  await assertProjectAdmitted(userDataDir, projectPath);
  const { executionPath } = await assertRunnableTask(agentDir, projectPath, taskPath);
  const canonicalExecutionPath = await realpath(executionPath);
  const requestedTarget = filePath ? resolveChangePath(executionPath, filePath) : executionPath;
  await lstat(requestedTarget);
  const target = await realpath(requestedTarget);
  if (filePath) {
    const change = (await getTaskChanges(agentDir, projectPath, taskPath)).files.find((candidate) => candidate.path === gitPath(filePath));
    if (!change || change.status === "deleted") throw new Error("That file is not a current Git change");
    const relative = path.relative(canonicalExecutionPath, target);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Changed files must stay within the Execution location");
    }
  }
  await launchEditor(editor, target, canonicalExecutionPath, getConfiguredEditor(agentDir, canonicalExecutionPath));
}
