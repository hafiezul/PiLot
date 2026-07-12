import { SettingsManager } from "@earendil-works/pi-coding-agent";

const [cwd, agentDir, command, first, second] = process.argv.slice(2);
if (!cwd || !agentDir || !["model", "thinking"].includes(command)) {
  throw new Error("usage: settings-write.js CWD AGENT_DIR model PROVIDER ID | thinking LEVEL");
}

const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
const loadErrors = settings.drainErrors();
if (loadErrors.length) throw loadErrors[0].error;

if (command === "model") settings.setDefaultModelAndProvider(first, second);
else settings.setDefaultThinkingLevel(first);

await settings.flush();
const errors = settings.drainErrors();
if (errors.length) throw errors[0].error;
