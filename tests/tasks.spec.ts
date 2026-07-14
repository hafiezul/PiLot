import { expect, test } from "@playwright/test";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverTasks, getProjectSessionDirectory, setTaskLifecycle } from "../dist/main/main/tasks.js";

const headerTime = "2026-01-01T00:00:00.000Z";

function header(id: string, project: string) {
  return { type: "session", version: 3, id, timestamp: headerTime, cwd: project };
}

function message(id: string, activity: string, content: string) {
  return {
    type: "message", id, parentId: null, timestamp: activity,
    message: { role: "user", content, timestamp: Date.parse(activity) },
  };
}

async function entries(file: string) {
  return (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

test("serializes Task bookkeeping without changing activity order", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pilot-tasks-"));
  const agentDir = path.join(root, ".pi", "agent");
  const projectDirectory = path.join(root, "project");
  await mkdir(projectDirectory, { recursive: true });
  const project = await realpath(projectDirectory);
  const directory = getProjectSessionDirectory(agentDir, project);
  const target = path.join(directory, "target.jsonl");
  const newer = path.join(directory, "newer.jsonl");
  const targetActivity = "2026-01-02T00:00:00.000Z";
  const newerActivity = "2026-01-03T00:00:00.000Z";
  await mkdir(directory, { recursive: true });
  await writeFile(target, [
    header("target", project),
    message("target-message", targetActivity, "Target task"),
  ].map(JSON.stringify).join("\n"));
  await writeFile(newer, [
    header("newer", project),
    message("newer-message", newerActivity, "Newer task"),
    {
      type: "custom", customType: "pilot.task", id: "newer-metadata", parentId: "newer-message",
      timestamp: "2026-01-04T00:00:00.000Z", data: { version: 1, title: "Newer task", lifecycle: "active" },
    },
  ].map(JSON.stringify).join("\n") + "\n");
  await utimes(target, new Date("2020-01-02"), new Date("2020-01-02"));
  await utimes(newer, new Date("2020-01-01"), new Date("2020-01-01"));

  try {
    const discoveries = await Promise.all([
      discoverTasks(agentDir, project),
      discoverTasks(agentDir, project),
    ]);
    for (const discovery of discoveries) expect(discovery.tasks.map(({ id }) => id)).toEqual(["newer", "target"]);

    let metadata = (await entries(target)).filter((entry) => entry.customType === "pilot.task");
    expect(metadata).toHaveLength(1);
    expect(metadata[0]).toMatchObject({ parentId: "target-message", data: { lifecycle: "active" } });
    const external = {
      type: "custom", customType: "fixture.external", id: "external-append", parentId: metadata[0].id,
      timestamp: "2026-01-05T00:00:00.000Z", data: { writer: "cli" },
    };
    await appendFile(target, `${JSON.stringify(external)}\n`);

    await Promise.all([
      setTaskLifecycle(agentDir, project, target, "archived"),
      setTaskLifecycle(agentDir, project, target, "active"),
      discoverTasks(agentDir, project),
    ]);

    metadata = (await entries(target)).filter((entry) => entry.customType === "pilot.task");
    expect(metadata.map((entry) => entry.data.lifecycle)).toEqual(["active", "archived", "active"]);
    expect(metadata.map((entry) => entry.parentId)).toEqual([
      "target-message",
      external.id,
      metadata[1].id,
    ]);
    const refreshed = await discoverTasks(agentDir, project);
    expect(refreshed.tasks.map(({ id }) => id)).toEqual(["newer", "target"]);
    expect(refreshed.tasks.find(({ id }) => id === "target")?.lifecycle).toBe("active");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
