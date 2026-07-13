import {
  AuthStorage,
  getAgentDir,
  getShellConfig,
  ModelRegistry,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { ReadinessGap, StartupState } from "../shared/readiness.js";

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

  return { gaps, passed: 3 - gaps.length };
}
