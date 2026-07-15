import { expect, test } from "@playwright/test";
import { RunAttentionPolicy, backgroundRunStatus, lastWindowPrompt } from "../dist/main/main/desktop-lifecycle.js";
import type { NotificationPreferences } from "../src/shared/preferences.js";
import type { RunEvidenceItem, RunStatus, TaskRunState } from "../src/shared/projects.js";

const allNotifications: NotificationPreferences = {
  runCompleted: true,
  runFailed: true,
  attentionRequired: true,
};

function state(status: RunStatus, id = "run-1", items: RunEvidenceItem[] = []): TaskRunState {
  return {
    taskPath: "/project/task.jsonl",
    activeRunId: status === "queued" || status === "preparing" || status === "running" ? id : undefined,
    runs: [{
      id,
      status,
      startedAt: "2026-01-01T00:00:00.000Z",
      input: { kind: "prompt", text: "Private prompt text" },
      items,
    }],
  };
}

test("classifies distinct background Run attention without exposing private context", () => {
  const policy = new RunAttentionPolicy();
  const attention: RunEvidenceItem = {
    id: "resource-warning",
    kind: "notice",
    tone: "attention",
    title: "Pi resource unavailable",
    detail: "Sensitive local path",
  };
  const approval: RunEvidenceItem = {
    id: "approval-needed",
    kind: "notice",
    tone: "attention",
    title: "Approval needed",
    detail: "Sensitive command",
  };

  expect(policy.observe(state("running"), { focused: false, preferences: allNotifications })).toEqual([]);
  const [first] = policy.observe(state("running", "run-1", [attention]), { focused: false, preferences: allNotifications });
  expect(first).toMatchObject({
    category: "attentionRequired",
    title: "PiLot needs attention",
    body: "Pi resource unavailable",
  });
  expect(first.id).toMatch(/^pilot-[a-f0-9]{32}$/);
  expect(JSON.stringify(first)).not.toContain("Private prompt text");
  expect(JSON.stringify(first)).not.toContain("Sensitive local path");
  expect(JSON.stringify(first)).not.toContain("/project/");

  const [second] = policy.observe(state("running", "run-1", [attention, approval]), { focused: false, preferences: allNotifications });
  expect(second).toMatchObject({ category: "attentionRequired", body: "Approval needed" });
  expect(second.id).not.toBe(first.id);
  expect(policy.observe(state("running", "run-1", [attention, approval]), { focused: false, preferences: allNotifications })).toEqual([]);

  const [completion] = policy.observe(state("settled", "run-1", [attention, approval]), { focused: false, preferences: allNotifications });
  expect(completion).toMatchObject({
    category: "runCompleted",
    title: "Run completed",
    body: "Open PiLot to review the latest evidence.",
  });
  expect(completion.id).not.toBe(first.id);
  expect(policy.observe(state("settled", "run-1", [attention, approval]), { focused: false, preferences: allNotifications })).toEqual([]);
});

test("does not replay focused or disabled notifications after the app backgrounds", () => {
  const policy = new RunAttentionPolicy();
  const failedOnly: NotificationPreferences = { ...allNotifications, runCompleted: false };

  expect(policy.observe(state("failed", "focused-failure"), { focused: true, preferences: allNotifications })).toEqual([]);
  expect(policy.observe(state("failed", "focused-failure"), { focused: false, preferences: allNotifications })).toEqual([]);
  expect(policy.observe(state("settled", "disabled-completion"), { focused: false, preferences: failedOnly })).toEqual([]);
  expect(policy.observe(state("settled", "disabled-completion"), { focused: false, preferences: allNotifications })).toEqual([]);
  const [interruption] = policy.observe(state("interrupted", "background-interruption"), { focused: false, preferences: allNotifications });
  expect(interruption).toMatchObject({
    category: "runFailed",
    title: "Run interrupted",
    body: "Open PiLot to review what changed before continuing.",
  });
});

test("describes background Run status without double-counting waiting Runs", () => {
  expect(backgroundRunStatus({ activeCount: 2, waitingCount: 1 })).toEqual({
    menuLabel: "2 active Runs · 1 waiting",
    tooltip: "PiLot — 2 active Runs, 1 waiting",
  });
  expect(backgroundRunStatus({ activeCount: 1, waitingCount: 0 })).toEqual({
    menuLabel: "1 active Run",
    tooltip: "PiLot — 1 active Run",
  });
  expect(backgroundRunStatus({ activeCount: 0, waitingCount: 1 })).toEqual({
    menuLabel: "1 waiting",
    tooltip: "PiLot — 1 waiting",
  });
  expect(backgroundRunStatus({ activeCount: 0, waitingCount: 0 })).toEqual({
    menuLabel: "No active Runs",
    tooltip: "PiLot — No active Runs",
  });
});

test("defines the native last-window choices and active-work detail", () => {
  expect(lastWindowPrompt(2)).toEqual({
    title: "Close PiLot Window",
    message: "2 Runs are still active",
    detail: "Continue in Background keeps the work running in PiLot's system status area. Stop and Quit ends every active or waiting Run cleanly before PiLot exits.",
    buttons: ["Continue in Background", "Stop and Quit", "Cancel"],
  });
});
