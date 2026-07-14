import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export class ExternalTaskChangeError extends Error {
  constructor() {
    super("This Task changed outside PiLot. Reload it or fork the last PiLot path before continuing.");
    this.name = "ExternalTaskChangeError";
  }
}

type Stamp = {
  device: bigint;
  inode: bigint;
  size: bigint;
  modified: bigint;
  changed: bigint;
};

type WatchedTask = {
  file: string;
  stamp: Stamp;
  chunks: Buffer[];
  leafId: string | null;
  changed: boolean;
  listeners: Set<() => void>;
  watcher?: FSWatcher;
};

const watchedTasks = new Map<string, WatchedTask>();
const guardedMethods = new Set([
  "appendMessage",
  "appendThinkingLevelChange",
  "appendModelChange",
  "appendCompaction",
  "appendCustomEntry",
  "appendSessionInfo",
  "appendCustomMessageEntry",
  "appendLabelChange",
  "branchWithSummary",
]);

function stamp(file: string): Stamp {
  const value = statSync(file, { bigint: true });
  return {
    device: value.dev,
    inode: value.ino,
    size: value.size,
    modified: value.mtimeNs,
    changed: value.ctimeNs,
  };
}

function same(left: Stamp, right: Stamp) {
  return left.device === right.device && left.inode === right.inode && left.size === right.size
    && left.modified === right.modified && left.changed === right.changed;
}

function leafId(content: Buffer) {
  const lines = content.toString("utf8").trim().split("\n");
  for (let index = lines.length - 1; index >= 1; index--) {
    try {
      const entry = JSON.parse(lines[index]) as { id?: unknown };
      if (typeof entry.id === "string") return entry.id;
    } catch {
      continue;
    }
  }
  return null;
}

function capture(file: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = stamp(file);
    const content = readFileSync(file);
    const after = stamp(file);
    if (same(before, after) && BigInt(content.length) === after.size) return { stamp: after, chunks: [content], leafId: leafId(content) };
  }
  throw new ExternalTaskChangeError();
}

function markChanged(task: WatchedTask) {
  if (task.changed) return;
  task.changed = true;
  for (const listener of task.listeners) queueMicrotask(listener);
}

function inspect(task: WatchedTask) {
  if (task.changed) return;
  try {
    const next = stamp(task.file);
    if (same(task.stamp, next)) return;
    if (next.device === task.stamp.device && next.inode === task.stamp.inode && next.size === task.stamp.size
      && readFileSync(task.file).equals(Buffer.concat(task.chunks))) {
      task.stamp = next;
      return;
    }
    markChanged(task);
  } catch {
    markChanged(task);
  }
}

export function watchTask(file: string, listener: () => void) {
  const resolved = path.resolve(file);
  let task = watchedTasks.get(resolved);
  if (!task) {
    const snapshot = capture(resolved);
    task = { file: resolved, ...snapshot, changed: false, listeners: new Set() };
    watchedTasks.set(resolved, task);
    try {
      task.watcher = watch(path.dirname(resolved), { persistent: false }, (_event, filename) => {
        if (!filename || filename.toString() === path.basename(resolved)) inspect(task!);
      });
      task.watcher.on("error", () => markChanged(task!));
    } catch {
      markChanged(task);
    }
  }
  task.listeners.add(listener);
  return task.changed || undefined;
}

export function getTaskContinuity(file: string) {
  return watchedTasks.get(path.resolve(file))?.changed || undefined;
}

function assertCurrent(task: WatchedTask) {
  inspect(task);
  if (task.changed) throw new ExternalTaskChangeError();
}

export function assertTaskCurrent(file: string) {
  const task = watchedTasks.get(path.resolve(file));
  if (task) assertCurrent(task);
}

function ensureLineBoundary(task: WatchedTask) {
  if (!task.stamp.size) return;
  const last = Buffer.alloc(1);
  const descriptor = openSync(task.file, "r");
  try {
    if (readSync(descriptor, last, 0, 1, Number(task.stamp.size - 1n)) !== 1) throw new ExternalTaskChangeError();
  } finally {
    closeSync(descriptor);
  }
  if (last[0] === 10) return;
  appendFileSync(task.file, "\n");
  const next = stamp(task.file);
  if (next.device !== task.stamp.device || next.inode !== task.stamp.inode || next.size !== task.stamp.size + 1n) {
    markChanged(task);
    throw new ExternalTaskChangeError();
  }
  task.chunks.push(Buffer.from("\n"));
  task.stamp = next;
}

function acknowledgeTaskWrite(task: WatchedTask, manager: SessionManager, entryId: unknown) {
  const next = stamp(task.file);
  if (next.device !== task.stamp.device || next.inode !== task.stamp.inode || next.size <= task.stamp.size) {
    markChanged(task);
    throw new ExternalTaskChangeError();
  }
  const added = next.size - task.stamp.size;
  if (added > BigInt(Number.MAX_SAFE_INTEGER) || task.stamp.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    markChanged(task);
    throw new ExternalTaskChangeError();
  }
  const bytes = Buffer.alloc(Number(added));
  const descriptor = openSync(task.file, "r");
  try {
    const count = readSync(descriptor, bytes, 0, bytes.length, Number(task.stamp.size));
    if (count !== bytes.length) throw new ExternalTaskChangeError();
  } finally {
    closeSync(descriptor);
  }
  try {
    const entries = bytes.toString("utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { id?: unknown });
    if (typeof entryId !== "string" || entries.length !== 1 || entries[0]?.id !== entryId || manager.getLeafId() !== entryId) {
      throw new ExternalTaskChangeError();
    }
  } catch {
    markChanged(task);
    throw new ExternalTaskChangeError();
  }
  task.chunks.push(bytes);
  task.leafId = entryId as string;
  task.stamp = next;
}

export function guardTaskManager(file: string, manager: SessionManager): SessionManager {
  const resolved = path.resolve(file);
  const task: WatchedTask = watchedTasks.get(resolved) ?? { file: resolved, ...capture(resolved), changed: false, listeners: new Set() };
  assertCurrent(task);
  if (manager.getLeafId() !== task.leafId) {
    markChanged(task);
    throw new ExternalTaskChangeError();
  }
  return new Proxy(manager, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (!guardedMethods.has(String(property))) return value.bind(target);
      return (...args: unknown[]) => {
        const destination = target.getSessionFile();
        if (!destination) throw new Error("Pi could not persist this Task");
        const resolvedDestination = path.resolve(destination);
        if (resolvedDestination !== task.file && !existsSync(resolvedDestination)) return Reflect.apply(value, target, args);
        const writeTask: WatchedTask = resolvedDestination === task.file
          ? task
          : { file: resolvedDestination, ...capture(resolvedDestination), changed: false, listeners: new Set() };
        assertCurrent(writeTask);
        if (resolvedDestination !== task.file && target.getLeafId() !== writeTask.leafId) {
          markChanged(writeTask);
          throw new ExternalTaskChangeError();
        }
        ensureLineBoundary(writeTask);
        const result = Reflect.apply(value, target, args);
        acknowledgeTaskWrite(writeTask, target, result);
        return result;
      };
    },
  });
}

export function reloadTaskContinuity(file: string) {
  const task = watchedTasks.get(path.resolve(file));
  if (!task) return;
  const snapshot = capture(task.file);
  task.stamp = snapshot.stamp;
  task.chunks = snapshot.chunks;
  task.leafId = snapshot.leafId;
  task.changed = false;
}

export function taskSnapshot(file: string) {
  const task = watchedTasks.get(path.resolve(file));
  if (!task?.changed) throw new Error("This Task has no external change to fork");
  return Buffer.concat(task.chunks);
}
