import { createHash } from "node:crypto";
import type { NotificationPreferences } from "../shared/preferences.js";
import type { RunEvidence, TaskRunState } from "../shared/projects.js";

export type RunAttentionCategory = keyof NotificationPreferences;

export type RunAttentionNotification = {
  id: string;
  category: RunAttentionCategory;
  title: string;
  body: string;
};

export type RunActivity = {
  activeCount: number;
  waitingCount: number;
};

type ObservationContext = {
  focused: boolean;
  preferences: NotificationPreferences;
};

const maximumRememberedEvents = 4_096;

function notificationId(key: string) {
  return `pilot-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

function terminalNotification(run: RunEvidence): Omit<RunAttentionNotification, "id"> | undefined {
  if (run.status === "settled") {
    return {
      category: "runCompleted",
      title: "Run completed",
      body: "Open PiLot to review the latest evidence.",
    };
  }
  if (run.status === "failed") {
    return {
      category: "runFailed",
      title: "Run failed",
      body: "Open PiLot to review the failure and next steps.",
    };
  }
  if (run.status === "interrupted") {
    return {
      category: "runFailed",
      title: "Run interrupted",
      body: "Open PiLot to review what changed before continuing.",
    };
  }
}

export class RunAttentionPolicy {
  private remembered = new Set<string>();
  private rememberedOrder: string[] = [];

  private isNew(key: string) {
    if (this.remembered.has(key)) return false;
    this.remembered.add(key);
    this.rememberedOrder.push(key);
    if (this.rememberedOrder.length > maximumRememberedEvents) {
      this.remembered.delete(this.rememberedOrder.shift()!);
    }
    return true;
  }

  observe(state: TaskRunState, context: ObservationContext): RunAttentionNotification[] {
    const run = state.runs.at(-1);
    if (!run) return [];
    const notifications: RunAttentionNotification[] = [];

    for (const item of run.items) {
      if (item.kind !== "notice" || item.tone !== "attention") continue;
      const key = `${state.taskPath}\0${run.id}\0attention\0${item.id}`;
      if (!this.isNew(key) || context.focused || !context.preferences.attentionRequired) continue;
      notifications.push({
        id: notificationId(key),
        category: "attentionRequired",
        title: "PiLot needs attention",
        body: item.title,
      });
    }

    const terminal = terminalNotification(run);
    if (!terminal) return notifications;
    const key = `${state.taskPath}\0${run.id}\0terminal`;
    if (!this.isNew(key) || context.focused || !context.preferences[terminal.category]) return notifications;
    notifications.push({ id: notificationId(key), ...terminal });
    return notifications;
  }
}

export function backgroundRunStatus(activity: RunActivity) {
  const active = Math.max(0, Math.trunc(activity.activeCount));
  const waiting = Math.max(0, Math.trunc(activity.waitingCount));
  const parts = [
    ...(active ? [`${active} active Run${active === 1 ? "" : "s"}`] : []),
    ...(waiting ? [`${waiting} waiting`] : []),
  ];
  return parts.length ? {
    menuLabel: parts.join(" · "),
    tooltip: `PiLot — ${parts.join(", ")}`,
  } : {
    menuLabel: "No active Runs",
    tooltip: "PiLot — No active Runs",
  };
}

export function lastWindowPrompt(runCount: number) {
  const count = Math.max(1, Math.trunc(runCount));
  const plural = count === 1 ? "Run is" : "Runs are";
  return {
    title: "Close PiLot Window",
    message: `${count} ${plural} still active`,
    detail: "Continue in Background keeps the work running in PiLot's system status area. Stop and Quit ends every active or waiting Run cleanly before PiLot exits.",
    buttons: ["Continue in Background", "Stop and Quit", "Cancel"] as const,
  };
}
