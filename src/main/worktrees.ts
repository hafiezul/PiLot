import { createLocalBashOperations, ProjectTrustStore, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import type { TaskCreationState, TaskExecutionLocation, TaskSetupState } from "../shared/projects.js";
import { assertRunnableTask, getTaskSetupState, setTaskSetupState } from "./tasks.js";

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
