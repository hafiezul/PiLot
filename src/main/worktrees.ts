import { createLocalBashOperations, ProjectTrustStore, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, readlink, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import type { TerminalId } from "../shared/editors.js";
import type { ChangeStatus, TaskCreationState, TaskExecutionLocation, TaskSetupState, TaskWorktreeFile, TaskWorktreeState } from "../shared/projects.js";
import { launchTerminal } from "./editors.js";
import { assertRunnableTask, getTaskSetupState, setTaskSetupState, withTaskWorktreeRemoval } from "./tasks.js";

function git(cwd: string, args: string[], maxBuffer = 4 * 1024 * 1024) {
  return new Promise<string>((resolve, reject) => {
    execFile("git", ["--no-optional-locks", ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer,
      env: { ...process.env, GIT_PAGER: "cat" },
    }, (error, stdout, stderr) => {
      if (!error) resolve(stdout);
      else reject(new Error(stderr.trim() || error.message));
    });
  });
}

async function repository(projectPath: string) {
  const project = await realpath(projectPath);
  const root = await realpath((await git(project, ["rev-parse", "--show-toplevel"])).trim());
  return { project, root, relativeProjectPath: path.relative(root, project) };
}

export async function getTaskCreationState(projectPath: string): Promise<TaskCreationState> {
  let context: Awaited<ReturnType<typeof repository>>;
  try {
    context = await repository(projectPath);
  } catch {
    return { repository: false, dirty: false, refs: [], setupCommand: "" };
  }

  let commit = "";
  try { commit = (await git(context.root, ["rev-parse", "--verify", "HEAD"])).trim(); } catch { /* unborn repository */ }
  if (!commit) return { repository: true, dirty: Boolean((await git(context.root, ["status", "--porcelain", "--untracked-files=normal"])).trim()), refs: [], setupCommand: "" };

  let branch = "";
  try { branch = (await git(context.root, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim(); } catch { /* detached HEAD */ }
  const [branches, commits, status] = await Promise.all([
    git(context.root, ["for-each-ref", "--format=%(refname:short)%09%(objectname)%09%(subject)", "refs/heads"]),
    git(context.root, ["log", "--all", "--max-count=25", "--format=%H%x09%h%x09%s"]),
    git(context.root, ["status", "--porcelain", "--untracked-files=normal"]),
  ]);
  const refs = [
    ...branches.split("\n").filter(Boolean).map((line) => {
      const [value, hash, ...subject] = line.split("\t");
      return { value, label: `${value} — ${hash.slice(0, 8)}${subject.length ? ` · ${subject.join(" ")}` : ""}` };
    }),
    ...commits.split("\n").filter(Boolean).map((line) => {
      const [value, short, ...subject] = line.split("\t");
      return { value, label: `${short} — ${subject.join(" ")}` };
    }),
  ];
  return { repository: true, dirty: Boolean(status.trim()), defaultRef: branch || commit, refs, setupCommand: "" };
}

function safeRef(value: string) {
  const ref = value.trim();
  if (!ref || ref.length > 1024 || ref.startsWith("-") || /[\u0000-\u001f\u007f]/.test(ref)) {
    throw new Error("Choose a committed branch or commit");
  }
  return ref;
}

export async function withManagedWorktree<T>(
  userData: string,
  projectPath: string,
  selectedRef: string,
  operation: (execution: TaskExecutionLocation) => Promise<T>,
) {
  const context = await repository(projectPath);
  const ref = safeRef(selectedRef);
  let commit: string;
  try {
    commit = (await git(context.root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
  } catch {
    throw new Error("Choose a branch or commit that resolves to a committed Git revision");
  }

  const projectName = (path.basename(context.root).replace(/[^A-Za-z0-9._-]/g, "-") || "project").slice(0, 48);
  const worktreePath = path.join(userData, "worktrees", `${projectName}-${randomUUID()}`);
  await mkdir(path.dirname(worktreePath), { recursive: true });
  try {
    await git(context.root, ["worktree", "add", "--detach", worktreePath, commit]);
    const executionPath = path.join(worktreePath, context.relativeProjectPath);
    if (!(await stat(executionPath)).isDirectory()) throw new Error("The selected Project folder does not exist in that committed revision");
    return await operation({
      kind: "worktree",
      path: await realpath(executionPath),
      worktreePath: await realpath(worktreePath),
      ref,
      commit,
    });
  } catch (error) {
    await git(context.root, ["worktree", "remove", "--force", worktreePath]).catch(() => rm(worktreePath, { recursive: true, force: true }));
    throw error;
  }
}

async function taskWorktree(agentDir: string, projectPath: string, taskPath: string) {
  const context = await assertRunnableTask(agentDir, projectPath, taskPath);
  if (context.execution.kind !== "worktree") throw new Error("This Task does not use a managed Worktree");
  return { ...context, execution: context.execution };
}

function worktreeStatus(code: string): ChangeStatus {
  if (code === "??") return "untracked";
  if (code.includes("U") || code === "AA" || code === "DD") return "unmerged";
  if (code.includes("R")) return "renamed";
  if (code.includes("C")) return "copied";
  if (code.includes("D")) return "deleted";
  if (code.includes("A")) return "added";
  if (code.includes("T")) return "type-changed";
  return "modified";
}

function worktreeFiles(output: string) {
  const records = output.split("\0");
  const files: Array<Omit<TaskWorktreeFile, "fingerprint">> = [];
  for (let index = 0; index < records.length;) {
    const record = records[index++];
    if (!record || record.length < 4) continue;
    const code = record.slice(0, 2);
    const filePath = record.slice(3).split(path.sep).join("/");
    if (!filePath) continue;
    const moved = code.includes("R") || code.includes("C");
    const previousPath = moved ? (records[index++] ?? "").split(path.sep).join("/") : "";
    files.push({ path: filePath, ...(previousPath ? { previousPath } : {}), status: worktreeStatus(code) });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function worktreeIndex(output: string) {
  const entries = new Map<string, string[]>();
  for (const record of output.split("\0")) {
    const separator = record.indexOf("\t");
    if (separator < 0) continue;
    const filePath = record.slice(separator + 1).split(path.sep).join("/");
    const values = entries.get(filePath) ?? [];
    values.push(record.slice(0, separator));
    entries.set(filePath, values);
  }
  return entries;
}

async function supplementalWorktreeFiles(root: string, output: string, index: Map<string, string[]>, visible: Set<string>, sparseCheckout: boolean) {
  const files: Array<Omit<TaskWorktreeFile, "fingerprint">> = [];
  for (const record of output.split("\0")) {
    if (record.length < 3) continue;
    const tag = record[0];
    const filePath = record.slice(2).split(path.sep).join("/");
    const contentHidden = tag === "S" || /^[a-z]$/.test(tag);
    if (visible.has(filePath)) continue;
    const indexed = (index.get(filePath) ?? []).find((entry) => entry.endsWith(" 0"));
    if (!indexed) continue;
    const [mode, expectedHash] = indexed.split(" ");
    const target = path.join(root, ...filePath.split("/"));
    let info;
    try { info = await lstat(target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!contentHidden || (tag.toUpperCase() === "S" && sparseCheckout)) continue;
      files.push({ path: filePath, status: "deleted" });
      continue;
    }
    const typeChanged = mode === "120000" ? !info.isSymbolicLink() : mode === "160000" ? !info.isDirectory() : !info.isFile();
    const modeChanged = process.platform !== "win32" && !typeChanged && (mode === "100755" ? !(info.mode & 0o111) : mode === "100644" ? Boolean(info.mode & 0o111) : false);
    if (!contentHidden && mode !== "160000") {
      if (typeChanged || modeChanged) files.push({ path: filePath, status: "type-changed" });
      continue;
    }
    const gitlinkInitialized = mode === "160000" && await lstat(path.join(target, ".git")).then(() => true, () => false);
    const actualHash = typeChanged ? "" : gitlinkInitialized
      ? await git(target, ["rev-parse", "HEAD"]).then((value) => value.trim(), () => expectedHash)
      : mode === "160000" ? expectedHash : await git(root, ["hash-object", `--path=${filePath}`, "--", filePath]).then((value) => value.trim(), () => "");
    const gitlinkDirty = gitlinkInitialized && await git(target, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).then((value) => Boolean(value), () => false);
    if (typeChanged || modeChanged || gitlinkDirty || actualHash !== expectedHash) files.push({ path: filePath, status: typeChanged || modeChanged ? "type-changed" : "modified" });
  }
  return files;
}

async function hashFilesystemEntry(hash: ReturnType<typeof createHash>, target: string) {
  let info;
  try { info = await lstat(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") { hash.update("missing"); return; }
    throw error;
  }
  hash.update(`${info.mode}\0`);
  if (info.isSymbolicLink()) hash.update(`link\0${await readlink(target)}`);
  else if (info.isFile()) {
    hash.update("file\0");
    for await (const chunk of createReadStream(target)) hash.update(chunk as Buffer);
  } else if (info.isDirectory()) {
    hash.update("directory\0");
    for (const name of (await readdir(target)).sort()) {
      hash.update(`${name}\0`);
      await hashFilesystemEntry(hash, path.join(target, name));
    }
  } else hash.update("other");
}

async function hashWorktreePath(hash: ReturnType<typeof createHash>, root: string, filePath: string, index: Map<string, string[]>) {
  hash.update(`\0${filePath}\0${(index.get(filePath) ?? []).join("\0")}\0`);
  await hashFilesystemEntry(hash, path.join(root, ...filePath.split("/")));
}

async function fingerprintWorktreeFile(root: string, file: Omit<TaskWorktreeFile, "fingerprint">, index: Map<string, string[]>) {
  const hash = createHash("sha256");
  hash.update(`${file.status}\0${file.previousPath ?? ""}\0${file.path}`);
  await hashWorktreePath(hash, root, file.path, index);
  if (file.previousPath) await hashWorktreePath(hash, root, file.previousPath, index);
  return hash.digest("hex");
}

function worktreeFileKeys(files: TaskWorktreeState["files"]) {
  return files.map(({ path: filePath, previousPath, status, fingerprint }) => JSON.stringify([status, previousPath ?? null, filePath, fingerprint])).sort();
}

async function readWorktreeState(context: Awaited<ReturnType<typeof taskWorktree>>): Promise<TaskWorktreeState> {
  const [head, branch, status, indexOutput, flagsOutput, sparseCheckout] = await Promise.all([
    git(context.executionPath, ["rev-parse", "--verify", "HEAD"]).then((value) => value.trim()),
    git(context.executionPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]).then((value) => value.trim(), () => ""),
    git(context.execution.worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    git(context.execution.worktreePath, ["ls-files", "--stage", "-z"]),
    git(context.execution.worktreePath, ["ls-files", "-v", "-z"]),
    git(context.execution.worktreePath, ["config", "--bool", "core.sparseCheckout"]).then((value) => value.trim() === "true", () => false),
  ]);
  const rawFiles = worktreeFiles(status);
  const index = worktreeIndex(indexOutput);
  const visible = new Set(rawFiles.flatMap(({ path: filePath, previousPath }) => previousPath ? [filePath, previousPath] : [filePath]));
  rawFiles.push(...await supplementalWorktreeFiles(context.execution.worktreePath, flagsOutput, index, visible, sparseCheckout));
  rawFiles.sort((left, right) => left.path.localeCompare(right.path));
  const files = await Promise.all(rawFiles.map(async (file) => ({ ...file, fingerprint: await fingerprintWorktreeFile(context.execution.worktreePath, file, index) })));
  return { taskPath: context.file, head, ...(branch ? { branch } : {}), files };
}

export async function getTaskWorktreeState(agentDir: string, projectPath: string, taskPath: string) {
  return readWorktreeState(await taskWorktree(agentDir, projectPath, taskPath));
}

function validBranchName(value: string) {
  const branch = value.trim();
  if (!branch || branch.length > 255 || branch.startsWith("-") || /[\u0000-\u001f\u007f]/.test(branch)) {
    throw new Error("Enter a valid Git branch name");
  }
  return branch;
}

export async function createTaskWorktreeBranch(userData: string, agentDir: string, projectPath: string, taskPath: string, value: string) {
  const context = await taskWorktree(agentDir, projectPath, taskPath);
  await assertManagedWorktree(userData, context.execution.worktreePath);
  const current = await getTaskWorktreeState(agentDir, projectPath, taskPath);
  if (current.branch) throw new Error(`This Worktree is already on branch ${current.branch}`);
  const branch = validBranchName(value);
  try { await git(context.executionPath, ["check-ref-format", `refs/heads/${branch}`]); }
  catch { throw new Error("Enter a valid Git branch name"); }
  await git(context.executionPath, ["switch", "-c", branch]);
  return getTaskWorktreeState(agentDir, projectPath, taskPath);
}

export async function openTaskWorktreeTerminal(agentDir: string, projectPath: string, taskPath: string, terminal: TerminalId) {
  const context = await taskWorktree(agentDir, projectPath, taskPath);
  try { await launchTerminal(context.executionPath, terminal); }
  catch (reason) {
    throw new Error(`Could not open this Worktree in a terminal: ${reason instanceof Error ? reason.message : String(reason)}`);
  }
}

async function assertManagedWorktree(userData: string, worktreePath: string) {
  const [root, target] = await Promise.all([realpath(path.join(userData, "worktrees")), realpath(worktreePath)]);
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Only PiLot-managed Worktrees can be removed");
  }
  return target;
}

function pathChunks(values: string[]) {
  const chunks: string[][] = [];
  for (let index = 0; index < values.length; index += 100) chunks.push(values.slice(index, index + 100));
  return chunks;
}

async function discardWorktreeFiles(root: string, files: TaskWorktreeFile[]) {
  const paths = [...new Set(files.flatMap(({ path: filePath, previousPath }) => previousPath ? [filePath, previousPath] : [filePath]))];
  const tracked = new Set<string>();
  for (const chunk of pathChunks(paths)) {
    const output = await git(root, ["--literal-pathspecs", "ls-tree", "-r", "--name-only", "-z", "HEAD", "--", ...chunk]);
    for (const filePath of output.split("\0").filter(Boolean)) tracked.add(filePath.split(path.sep).join("/"));
  }
  const untracked = paths.filter((filePath) => !tracked.has(filePath));
  for (const chunk of pathChunks([...tracked])) {
    await git(root, ["--literal-pathspecs", "update-index", "--no-assume-unchanged", "--", ...chunk]);
    await git(root, ["--literal-pathspecs", "update-index", "--no-skip-worktree", "--", ...chunk]);
    await git(root, ["--literal-pathspecs", "restore", "--source=HEAD", "--staged", "--worktree", "--", ...chunk]);
  }
  for (const chunk of pathChunks(untracked)) await git(root, ["--literal-pathspecs", "rm", "--cached", "--force", "--ignore-unmatch", "--", ...chunk]);
  for (const filePath of untracked) {
    const target = path.resolve(root, ...filePath.split("/"));
    const relative = path.relative(root, target);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("A changed file points outside this Worktree");
    }
    await rm(target, { recursive: true, force: true });
  }
}

async function pauseTestRemoval() {
  const signal = process.env.PILOT_TEST_PROJECT_DIR && process.env.PILOT_TEST_WORKTREE_REMOVAL_PAUSE_FILE;
  if (!signal) return;
  const milliseconds = Number(await readFile(signal, "utf8").catch(() => "0"));
  if (Number.isFinite(milliseconds) && milliseconds > 0) await delay(Math.min(milliseconds, 30_000));
}

export async function removeManagedWorktree(
  userData: string,
  agentDir: string,
  projectPath: string,
  taskPath: string,
  discard: boolean,
  expectedFiles: TaskWorktreeState["files"],
) {
  const context = await taskWorktree(agentDir, projectPath, taskPath);
  const worktreePath = await assertManagedWorktree(userData, context.execution.worktreePath);
  const state = await getTaskWorktreeState(agentDir, projectPath, taskPath);
  const currentFiles = worktreeFileKeys(state.files);
  const expected = worktreeFileKeys(expectedFiles);
  if (currentFiles.length !== expected.length || currentFiles.some((filePath, index) => filePath !== expected[index])) {
    throw new Error("Worktree changes changed. Review the affected files again before removal");
  }
  if (currentFiles.length && !discard) {
    throw new Error("This Worktree has uncommitted changes. Resolve them or explicitly discard the affected files");
  }
  if (!state.branch && state.head !== context.execution.commit) {
    throw new Error("Create a branch before removing this Worktree so its detached commits remain reachable");
  }
  const root = (await repository(context.project)).root;
  if (currentFiles.length) {
    await discardWorktreeFiles(worktreePath, state.files);
    if ((await getTaskWorktreeState(agentDir, projectPath, taskPath)).files.length) {
      throw new Error("Worktree changes changed while discarding. Review the affected files again before removal");
    }
  }
  await withTaskWorktreeRemoval(userData, agentDir, context.project, context.file, new Date().toISOString(), async (markStarted) => {
    await pauseTestRemoval();
    const finalState = await readWorktreeState(context);
    if (finalState.files.length) throw new Error("Worktree changes changed. Review the affected files again before removal");
    if (!finalState.branch && finalState.head !== context.execution.commit) {
      throw new Error("Create a branch before removing this Worktree so its detached commits remain reachable");
    }
    await git(worktreePath, ["submodule", "deinit", "--all"]);
    if ((await readWorktreeState(context)).files.length) throw new Error("Worktree changes changed. Review the affected files again before removal");
    const worktreeGitDirectory = (await git(worktreePath, ["rev-parse", "--absolute-git-dir"])).trim();
    await rm(path.join(worktreeGitDirectory, "modules"), { recursive: true, force: true });
    await markStarted();
    return git(root, ["worktree", "remove", worktreePath]);
  });
}

const maximumSetupOutput = 12_000;

type ActiveSetup = { controller: AbortController; state: TaskSetupState };

function appendOutput(state: TaskSetupState, chunk: string): TaskSetupState {
  const output = state.output + stripVTControlCharacters(chunk).replace(/\r/g, "");
  return output.length <= maximumSetupOutput
    ? { ...state, output }
    : { ...state, output: output.slice(-maximumSetupOutput), outputTruncated: true };
}

export class WorktreeSetupCoordinator {
  private active = new Map<string, ActiveSetup>();
  private starting = new Set<string>();

  constructor(
    private agentDir: string,
    private emit: (state: TaskSetupState) => void,
  ) {}

  async get(projectPath: string, taskPath: string) {
    const file = path.resolve(taskPath);
    const current = this.active.get(file);
    if (current) return current.state;
    const saved = await getTaskSetupState(this.agentDir, projectPath, file);
    if (saved?.status !== "running") return saved;
    return setTaskSetupState(this.agentDir, projectPath, file, { ...saved, status: "interrupted" });
  }

  async run(projectPath: string, taskPath: string) {
    const file = path.resolve(taskPath);
    if (this.active.has(file) || this.starting.has(file)) throw new Error("Setup is already running for this Task");
    this.starting.add(file);
    try {
      await this.runReserved(projectPath, file);
    } finally {
      this.starting.delete(file);
    }
  }

  private async runReserved(projectPath: string, file: string) {
    const saved = await getTaskSetupState(this.agentDir, projectPath, file);
    if (!saved) throw new Error("This Task has no setup command");
    if (saved.status === "succeeded" || saved.status === "bypassed") throw new Error("Setup is already complete for this Task");
    const context = await assertRunnableTask(this.agentDir, projectPath, file);
    if (new ProjectTrustStore(this.agentDir).getEntry(context.project)?.decision !== true) {
      throw new Error("Trust Project resources before running its setup command");
    }
    const entries = SessionManager.open(context.file).getEntries();
    const creationIndex = entries.findIndex((entry) => {
      if (entry.type !== "custom" || entry.customType !== "pilot.task" || !entry.data || typeof entry.data !== "object") return false;
      const execution = (entry.data as { execution?: unknown }).execution;
      return execution && typeof execution === "object" && (execution as { path?: unknown }).path === context.executionPath;
    });
    const taskEntries = creationIndex < 0 ? entries : entries.slice(creationIndex + 1);
    if (taskEntries.some((entry) => entry.type === "message" || (entry.type === "custom" && entry.customType === "pilot.run"))) {
      throw new Error("Project setup can run only before this Task's first Run");
    }

    if (context.execution.kind !== "worktree") throw new Error("Project setup is available only for a managed Worktree Task");
    const controller = new AbortController();
    let state = await setTaskSetupState(this.agentDir, projectPath, file, {
      command: saved.command,
      status: "running",
      output: "",
      outputTruncated: false,
    });
    const active = { controller, state };
    this.active.set(file, active);
    this.emit(state);
    const decoder = new StringDecoder("utf8");

    try {
      const settings = SettingsManager.create(context.executionPath, this.agentDir, { projectTrusted: true });
      const operations = createLocalBashOperations({ shellPath: settings.getShellPath() });
      const prefix = settings.getShellCommandPrefix()?.trim();
      const result = await operations.exec(prefix ? `${prefix}\n${saved.command}` : saved.command, context.executionPath, {
        signal: controller.signal,
        onData: (data) => {
          state = appendOutput(state, decoder.write(data));
          active.state = state;
          this.emit(state);
        },
      });
      state = appendOutput(state, decoder.end());
      state = await setTaskSetupState(this.agentDir, projectPath, file, {
        ...state,
        status: controller.signal.aborted ? "aborted" : result.exitCode === 0 ? "succeeded" : "failed",
        ...(typeof result.exitCode === "number" ? { exitCode: result.exitCode } : {}),
      });
    } catch (error) {
      state = appendOutput(state, decoder.end());
      const detail = error instanceof Error ? error.message : String(error);
      state = appendOutput(state, detail && !controller.signal.aborted ? `${state.output ? "\n" : ""}${detail}` : "");
      state = await setTaskSetupState(this.agentDir, projectPath, file, {
        ...state,
        status: controller.signal.aborted ? "aborted" : "failed",
      });
    } finally {
      if (this.active.get(file) === active) this.active.delete(file);
      this.emit(state);
    }
  }

  abort(taskPath: string) {
    this.active.get(path.resolve(taskPath))?.controller.abort();
  }

  async bypass(projectPath: string, taskPath: string) {
    const file = path.resolve(taskPath);
    if (this.active.has(file) || this.starting.has(file)) throw new Error("Stop setup before bypassing it");
    const saved = await this.get(projectPath, file);
    if (!saved || !["failed", "aborted", "interrupted"].includes(saved.status)) {
      throw new Error("Setup can be bypassed only after it fails or is stopped");
    }
    const state = await setTaskSetupState(this.agentDir, projectPath, file, { ...saved, status: "bypassed" });
    this.emit(state);
    return state;
  }
}
