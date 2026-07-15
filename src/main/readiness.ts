import {
  AuthStorage,
  getAgentDir,
  ModelRegistry,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ReadinessGap, StartupState } from "../shared/readiness.js";
import { resolveBashShell, type CapturedShellEnvironment } from "./environment.js";

export async function getStartupState(captured?: CapturedShellEnvironment, environment: NodeJS.ProcessEnv = process.env): Promise<StartupState> {
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
    const settings = SettingsManager.create(homedir(), agentDir, { projectTrusted: false });
    await resolveBashShell(environment, settings.getShellPath(), path.join(agentDir, "settings.json"));
    if (captured?.error) {
      gaps.push({
        area: "shell",
        title: "Load your login-shell environment",
        detail: `PiLot could not capture the configured login shell and is using the desktop launch environment instead. ${captured.error} Fix the shell startup error, then relaunch PiLot.`,
      });
    }
  } catch (error) {
    gaps.push({
      area: "shell",
      title: "Install a compatible Bash shell",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  return { gaps, passed: 3 - gaps.length };
}
