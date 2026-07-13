import {
  AuthStorage,
  CURRENT_SESSION_VERSION,
  getAgentDir,
  getShellConfig,
  ModelRegistry,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ProjectSummary, ReadinessGap, StartupState } from "../shared/readiness.js";

type Header = { type?: string; version?: number; cwd?: string };

async function readHeader(file: string): Promise<Header | undefined> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
    return JSON.parse(firstLine) as Header;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

async function inspectSessions(agentDir: string) {
  const sessionRoot = path.join(agentDir, "sessions");
  const projects = new Map<string, number>();
  let incompatible = 0;
  let malformed = 0;

  try {
    const entries = await readdir(sessionRoot, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const header = await readHeader(path.join(entry.parentPath, entry.name));
      if (!header || header.type !== "session") {
        malformed++;
        continue;
      }
      if ((header.version ?? 1) > CURRENT_SESSION_VERSION) incompatible++;
      if (header.cwd) projects.set(header.cwd, (projects.get(header.cwd) ?? 0) + 1);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") malformed++;
  }

  return {
    incompatible,
    malformed,
    projects: [...projects].map<ProjectSummary>(([cwd, taskCount]) => ({
      name: path.basename(cwd) || cwd,
      taskCount,
    })),
  };
}

export async function getStartupState(): Promise<StartupState> {
  const gaps: ReadinessGap[] = [];
  const agentDir = getAgentDir();

  const environmentExists = await stat(agentDir).then((value) => value.isDirectory()).catch(() => false);
  if (!environmentExists) {
    gaps.push({
      area: "environment",
      title: "Create your Pi environment",
      detail: "Run Pi once, then relaunch PiLot. PiLot shares ~/.pi/agent with the Pi CLI.",
    });
  }

  const auth = AuthStorage.create(path.join(agentDir, "auth.json"));
  const models = ModelRegistry.create(auth, path.join(agentDir, "models.json"));
  if (models.getAvailable().length === 0) {
    gaps.push({
      area: "provider",
      title: "Connect a provider",
      detail: "Add provider credentials to Pi. Stored and environment credentials are detected without displaying their values.",
    });
  }

  try {
    const settings = SettingsManager.create(process.cwd(), agentDir);
    getShellConfig(settings.getShellPath());
  } catch {
    gaps.push({
      area: "shell",
      title: "Install a compatible Bash shell",
      detail: "Install Git for Windows or add Bash to PATH, then relaunch PiLot.",
    });
  }

  const sessions = await inspectSessions(agentDir);
  if (sessions.incompatible > 0) {
    gaps.push({
      area: "sessions",
      title: "Update PiLot to open newer tasks",
      detail: `${sessions.incompatible} task${sessions.incompatible === 1 ? " uses" : "s use"} a newer Pi session format and will remain untouched.`,
    });
  } else if (sessions.malformed > 0) {
    gaps.push({
      area: "sessions",
      title: "Review unreadable task history",
      detail: `${sessions.malformed} Pi session file${sessions.malformed === 1 ? " could" : "s could"} not be read and will remain untouched.`,
    });
  }

  return { gaps, projects: sessions.projects, passed: 4 - gaps.length };
}
