import {
  getAgentDir,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";

const [command, inputPath, value] = process.argv.slice(2);
if (!inputPath || !["inspect", "set"].includes(command)) {
  throw new Error("usage: project-trust.js inspect|set PATH [true|false]");
}

const path = realpathSync(inputPath);
const store = new ProjectTrustStore(getAgentDir());
if (command === "set") store.set(path, value === "true");

const decision = store.get(path);
const defaultTrust = SettingsManager.create(path, getAgentDir(), { projectTrusted: false })
  .getDefaultProjectTrust();
const status = !hasTrustRequiringProjectResources(path)
  ? "notRequired"
  : decision === true || (decision === null && defaultTrust === "always")
    ? "trusted"
    : decision === false || (decision === null && defaultTrust === "never")
      ? "declined"
      : "unknown";
process.stdout.write(`${JSON.stringify({ path, status })}\n`);
