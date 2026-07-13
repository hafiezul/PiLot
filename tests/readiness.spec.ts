import { SessionManager } from "@earendil-works/pi-coding-agent";
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { createServer as createPortServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "vite";

const appPath = path.resolve(import.meta.dirname, "..");
const electronPath = createRequire(import.meta.url)("electron") as string;

async function fixture(version = 3) {
  const root = await mkdtemp(path.join(tmpdir(), "pilot-"));
  const agentDir = path.join(root, ".pi", "agent");
  const project = path.join(root, "fixture-project");
  const sessionDir = path.join(agentDir, "sessions", "fixture");
  await mkdir(project, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "fixture-secret" } }));
  await writeFile(
    path.join(sessionDir, "task.jsonl"),
    `${JSON.stringify({ type: "session", version, id: "fixture", timestamp: new Date().toISOString(), cwd: project })}\n`,
  );
  return { agentDir, project, root };
}

function sessionDirectory(agentDir: string, project: string) {
  const encoded = path.resolve(project).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
  return path.join(agentDir, "sessions", `--${encoded}--`);
}

async function writeSession(agentDir: string, project: string, name: string, entries: object[]) {
  const directory = sessionDirectory(agentDir, project);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${name}.jsonl`);
  await writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return file;
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createPortServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function launch(
  agentDir: string,
  withoutAuth = false,
  extraEnv: Record<string, string> = {},
): Promise<{ browser: Browser; process: ChildProcess; window: Page }> {
  const port = await availablePort();
  const env = withoutAuth
    ? Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(_API_KEY|_TOKEN|_CREDENTIALS?)$/.test(name)))
    : process.env;
  const child = spawn(electronPath, [appPath, `--pilot-debug-port=${port}`], {
    env: { ...env, PILOT_USER_DATA_DIR: path.join(agentDir, "pilot-user-data"), ...extraEnv, PI_CODING_AGENT_DIR: agentDir },
    stdio: "ignore",
  });
  const endpoint = `http://127.0.0.1:${port}`;
  let browser: Browser | undefined;
  for (let attempt = 0; attempt < 100 && !browser; attempt++) {
    try {
      browser = await chromium.connectOverCDP(endpoint);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (!browser) {
    child.kill();
    throw new Error("PiLot did not open its test connection");
  }
  const context = browser.contexts()[0];
  const window = context.pages()[0] ?? await context.waitForEvent("page");
  return { browser, process: child, window };
}

async function close(app: { browser: Browser; process: ChildProcess }) {
  const exit = app.process.exitCode === null ? once(app.process, "exit") : undefined;
  await app.browser.close();
  if (app.process.exitCode === null) app.process.kill();
  await exit;
}

function latestUserText(body: string) {
  const messages = (JSON.parse(body) as { messages?: Array<{ role?: string; content?: string | Array<{ type?: string; text?: string }> }> }).messages ?? [];
  const content = [...messages].reverse().find(({ role }) => role === "user")?.content;
  return typeof content === "string" ? content : content?.filter(({ type }) => type === "text").map(({ text }) => text ?? "").join("") ?? "";
}

async function deterministicProvider(root: string) {
  const started = path.join(root, "tool-started");
  const finished = path.join(root, "tool-finished");
  const modelStopped = path.join(root, "model-stopped");
  const requests: string[] = [];
  const server = createHttpServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push(body);
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (choice: object) => response.write(`data: ${JSON.stringify({
        id: "fixture-response", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [choice],
      })}\n\n`);
      const latestUser = latestUserText(body);
      if (latestUser === "start live queue check" || latestUser === "start abort queue check") {
        chunk({ index: 0, delta: { role: "assistant", tool_calls: [{
          index: 0, id: `queue-tool-${requests.length}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "sleep 2" }) },
        }] }, finish_reason: null });
        chunk({ index: 0, delta: {}, finish_reason: "tool_calls" });
        response.end("data: [DONE]\n\n");
        return;
      }
      if (latestUser === "steer with keyboard") {
        setTimeout(() => {
          if (response.destroyed) return;
          chunk({ index: 0, delta: { role: "assistant", content: "Steering received." }, finish_reason: null });
          chunk({ index: 0, delta: {}, finish_reason: "stop" });
          response.end("data: [DONE]\n\n");
        }, 400);
        return;
      }
      if (latestUser === "follow up with pointer") {
        chunk({ index: 0, delta: { role: "assistant", content: "Follow-up received." }, finish_reason: null });
        chunk({ index: 0, delta: {}, finish_reason: "stop" });
        response.end("data: [DONE]\n\n");
        return;
      }
      if (body.includes("show failure")) {
        if (body.includes("failure-tool")) {
          chunk({ index: 0, delta: { role: "assistant", content: "Failure recorded." }, finish_reason: null });
          chunk({ index: 0, delta: {}, finish_reason: "stop" });
        } else {
          chunk({ index: 0, delta: { role: "assistant", tool_calls: [{
            index: 0, id: "failure-tool", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "printf failed-output; exit 7" }) },
          }] }, finish_reason: null });
          chunk({ index: 0, delta: {}, finish_reason: "tool_calls" });
        }
        response.end("data: [DONE]\n\n");
        return;
      }
      if (body.includes("show evidence")) {
        if (body.includes("evidence-tool")) {
          chunk({ index: 0, delta: { role: "assistant", content: "Evidence complete." }, finish_reason: null });
          chunk({ index: 0, delta: {}, finish_reason: "stop" });
        } else {
          chunk({ index: 0, delta: { role: "assistant", reasoning_content: "Inspect the command evidence carefully." }, finish_reason: null });
          chunk({ index: 0, delta: { tool_calls: [{
            index: 0, id: "evidence-tool", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "seq 1 5000" }) },
          }] }, finish_reason: null });
          chunk({ index: 0, delta: {}, finish_reason: "tool_calls" });
        }
        response.end("data: [DONE]\n\n");
        return;
      }
      if (body.includes("abort model")) {
        chunk({ index: 0, delta: { role: "assistant", content: "Still streaming" }, finish_reason: null });
        const timer = setTimeout(() => response.end("data: [DONE]\n\n"), 5_000);
        response.once("close", () => {
          clearTimeout(timer);
          void writeFile(modelStopped, "stopped");
        });
        return;
      }
      if (body.includes("abort tool")) {
        chunk({ index: 0, delta: { role: "assistant", tool_calls: [{
          index: 0, id: "fixture-tool", type: "function", function: {
            name: "bash",
            arguments: JSON.stringify({ command: `printf started > ${JSON.stringify(started)}; sleep 5; printf finished > ${JSON.stringify(finished)}` }),
          },
        }] }, finish_reason: null });
        chunk({ index: 0, delta: {}, finish_reason: "tool_calls" });
        response.end("data: [DONE]\n\n");
        return;
      }
      if (body.includes("model controls stats")) {
        chunk({ index: 0, delta: { role: "assistant", content: "Usage recorded." }, finish_reason: null });
        response.write(`data: ${JSON.stringify({
          id: "fixture-response", object: "chat.completion.chunk", created: 1, model: "reasoning-model", choices: [],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_tokens_details: { cached_tokens: 20 } },
        })}\n\n`);
        chunk({ index: 0, delta: {}, finish_reason: "stop" });
        response.end("data: [DONE]\n\n");
        return;
      }
      chunk({ index: 0, delta: { role: "assistant", content: "Streaming " }, finish_reason: null });
      setTimeout(() => {
        if (response.destroyed) return;
        chunk({ index: 0, delta: { content: "from PiLot." }, finish_reason: null });
        chunk({ index: 0, delta: {}, finish_reason: "stop" });
        response.end("data: [DONE]\n\n");
      }, 500);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture provider did not start");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    started,
    finished,
    modelStopped,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("runs and aborts a Local Task through the Electron boundary", async () => {
  const environment = await fixture();
  const project = await realpath(environment.project);
  const provider = await deterministicProvider(environment.root);
  await writeFile(path.join(environment.agentDir, "models.json"), JSON.stringify({
    providers: {
      fixture: {
        baseUrl: provider.baseUrl,
        api: "openai-completions",
        apiKey: "fixture-key",
        models: [{ id: "fixture-model", name: "Fixture model", contextWindow: 32_000, maxTokens: 1_000 }],
      },
    },
  }));
  await writeFile(path.join(environment.agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "fixture",
    defaultModel: "fixture-model",
  }));
  const app = await launch(environment.agentDir, false, { PILOT_TEST_PROJECT_DIR: environment.project });

  try {
    await app.window.getByRole("button", { name: "Add project" }).click();
    await app.window.getByRole("dialog", { name: "Project access" }).getByRole("button", { name: "Allow agent execution" }).click();
    await app.window.getByRole("button", { name: "New Task" }).click();

    const composer = app.window.getByRole("form", { name: "Task composer" });
    const modelControl = composer.getByRole("combobox", { name: "Provider and model" });
    await expect(modelControl).toBeVisible();
    await modelControl.focus();
    await expect(modelControl).toBeFocused();
    await composer.getByRole("textbox", { name: "Prompt" }).fill("Reply with a deterministic greeting");
    await composer.getByRole("button", { name: "Run" }).click();
    const run = app.window.getByRole("region", { name: "Run timeline" });
    await expect(run).toContainText("Streaming ");
    await expect(run).toContainText("Running");
    await expect(run).toContainText("Streaming from PiLot.");
    await expect(run).toContainText("Settled");

    const directory = sessionDirectory(environment.agentDir, project);
    const firstFile = path.join(directory, (await readdir(directory)).find((file) => file.endsWith(".jsonl"))!);
    const firstEntries = (await readFile(firstFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(firstEntries[0]).toMatchObject({ type: "session", version: 3, cwd: project });
    expect(firstEntries.filter((entry) => entry.type === "message").map((entry) => entry.message.role)).toEqual(["user", "assistant"]);
    expect(firstEntries.find((entry) => entry.customType === "pilot.run")?.data.outcome).toBe("settled");
    expect(firstEntries.filter((entry) => entry.type === "custom_message")).toHaveLength(0);
    const context = SessionManager.open(firstFile).buildSessionContext();
    expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(context)).not.toContain("pilot.run");
    expect(JSON.stringify(context)).not.toContain("pilot.task");

    await app.window.getByRole("button", { name: "New Task" }).click();
    const abortComposer = app.window.getByRole("form", { name: "Task composer" });
    await abortComposer.getByRole("textbox", { name: "Prompt" }).fill("run abort tool");
    await abortComposer.getByRole("button", { name: "Run" }).click();
    const abortRun = app.window.getByRole("region", { name: "Run timeline" });
    await expect(abortRun.locator('details[aria-label="bash tool, running"]')).toBeVisible();
    await abortRun.getByRole("button", { name: "Abort" }).click();
    await expect(abortRun).toContainText("Aborted");
    await expect.poll(() => readFile(provider.started, "utf8").catch(() => "")).toBe("started");
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(await readFile(provider.finished, "utf8").catch(() => "")).toBe("");

    await app.window.getByRole("button", { name: "New Task" }).click();
    const modelComposer = app.window.getByRole("form", { name: "Task composer" });
    await modelComposer.getByRole("textbox", { name: "Prompt" }).fill("abort model");
    await modelComposer.getByRole("button", { name: "Run" }).click();
    const modelRun = app.window.getByRole("region", { name: "Run timeline" });
    await expect(modelRun).toContainText("Still streaming");
    await modelRun.getByRole("button", { name: "Abort" }).click();
    await expect(modelRun).toContainText("Aborted");
    await expect.poll(() => readFile(provider.modelStopped, "utf8").catch(() => "")).toBe("stopped");

    const files = await readdir(directory);
    expect(files.filter((file) => file.endsWith(".jsonl"))).toHaveLength(3);
    const outcomes = await Promise.all(files.filter((file) => file.endsWith(".jsonl")).map(async (file) =>
      (await readFile(path.join(directory, file), "utf8")).trim().split("\n").map((line) => JSON.parse(line))
        .find((entry) => entry.customType === "pilot.run")?.data.outcome));
    expect(outcomes.sort()).toEqual(["aborted", "aborted", "settled"]);
  } finally {
    await close(app);
    await provider.close();
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("steers, follows up, shows live queues, and restores queued input on abort", async () => {
  const environment = await fixture();
  const provider = await deterministicProvider(environment.root);
  await writeFile(path.join(environment.agentDir, "models.json"), JSON.stringify({
    providers: {
      fixture: {
        baseUrl: provider.baseUrl,
        api: "openai-completions",
        apiKey: "fixture-key",
        models: [{ id: "fixture-model", name: "Fixture model", contextWindow: 32_000, maxTokens: 1_000 }],
      },
    },
  }));
  await writeFile(path.join(environment.agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "fixture",
    defaultModel: "fixture-model",
  }));
  const app = await launch(environment.agentDir, false, { PILOT_TEST_PROJECT_DIR: environment.project });

  try {
    await app.window.getByRole("button", { name: "Add project" }).click();
    await app.window.getByRole("dialog", { name: "Project access" }).getByRole("button", { name: "Allow agent execution" }).click();
    await app.window.getByRole("button", { name: "New Task" }).click();

    const composer = app.window.getByRole("form", { name: "Task composer" });
    const prompt = composer.getByRole("textbox", { name: "Prompt" });
    await prompt.fill("start live queue check");
    await composer.getByRole("button", { name: "Run" }).click();
    await expect(app.window.locator('details[aria-label="bash tool, running"]')).toBeVisible();

    const liveMode = composer.getByRole("radiogroup", { name: "Live input mode" });
    await expect(liveMode.getByRole("radio", { name: "Steer" })).toBeChecked();
    await expect(liveMode.getByRole("radio", { name: "Follow-up" })).not.toBeChecked();

    await prompt.fill("steer with keyboard");
    await prompt.press("Enter");
    await expect(composer.getByRole("list", { name: "Pending steering" })).toContainText("steer with keyboard");

    await liveMode.getByRole("radio", { name: "Follow-up" }).check();
    await prompt.fill("follow up with pointer");
    await composer.getByRole("button", { name: "Queue input" }).click();
    await expect(composer.getByRole("list", { name: "Pending follow-ups" })).toContainText("follow up with pointer");
    await expect(app.window.getByRole("region", { name: "Run timeline" })).toContainText("Follow-up received.");
    await expect.poll(() => provider.requests.map(latestUserText)).toEqual([
      "start live queue check",
      "steer with keyboard",
      "follow up with pointer",
    ]);

    await prompt.fill("start abort queue check");
    await composer.getByRole("button", { name: "Run" }).click();
    await expect(app.window.locator('details[aria-label="bash tool, running"]')).toBeVisible();
    await prompt.fill("recover queued follow-up");
    await prompt.press("Alt+Enter");
    await expect(composer.getByRole("list", { name: "Pending follow-ups" })).toContainText("recover queued follow-up");
    await prompt.fill("keep unsent draft");
    await app.window.getByRole("button", { name: "Abort" }).click();
    await expect(prompt).toHaveValue("recover queued follow-up\n\nkeep unsent draft");
  } finally {
    await close(app);
    await provider.close();
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("renders Run evidence, disclosures, and inline commands through the Electron boundary", async () => {
  const environment = await fixture();
  const provider = await deterministicProvider(environment.root);
  await writeFile(path.join(environment.agentDir, "models.json"), JSON.stringify({
    providers: {
      fixture: {
        baseUrl: provider.baseUrl,
        api: "openai-completions",
        apiKey: "fixture-key",
        models: [{ id: "fixture-model", name: "Fixture model", contextWindow: 32_000, maxTokens: 1_000 }],
      },
    },
  }));
  await writeFile(path.join(environment.agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "fixture",
    defaultModel: "fixture-model",
  }));
  const app = await launch(environment.agentDir, false, { PILOT_TEST_PROJECT_DIR: environment.project });

  try {
    await app.window.getByRole("button", { name: "Add project" }).click();
    await app.window.getByRole("dialog", { name: "Project access" }).getByRole("button", { name: "Allow agent execution" }).click();
    await app.window.getByRole("button", { name: "New Task" }).click();
    const composer = app.window.getByRole("form", { name: "Task composer" });
    const prompt = composer.getByRole("textbox", { name: "Prompt" });
    const timeline = app.window.getByRole("region", { name: "Run timeline" });

    await prompt.fill("!!printf hidden-command-output");
    await composer.getByRole("button", { name: "Run" }).click();
    const hiddenCommand = timeline.getByRole("region", { name: "Command: printf hidden-command-output" });
    await expect(hiddenCommand).toContainText("hidden-command-output");
    await expect(hiddenCommand).toContainText("Local only");

    await prompt.fill("!printf visible-command-output");
    await composer.getByRole("button", { name: "Run" }).click();
    const visibleCommand = timeline.getByRole("region", { name: "Command: printf visible-command-output" });
    await expect(visibleCommand).toContainText("visible-command-output");
    await expect(visibleCommand).toContainText("Included in next Pi context");

    await prompt.fill("show evidence");
    await composer.getByRole("button", { name: "Run" }).click();
    await expect(timeline).toContainText("Evidence complete.");
    await expect(timeline.getByRole("article")).toHaveCount(3);
    const thinking = timeline.locator('details[aria-label="Thinking"]');
    await expect(thinking).not.toHaveAttribute("open", "");
    await thinking.locator("summary").focus();
    await thinking.locator("summary").press("Enter");
    await expect(thinking).toHaveAttribute("open", "");
    await expect(thinking).toContainText("Inspect the command evidence carefully.");

    const successfulTool = timeline.locator('details[aria-label="bash tool, succeeded"]');
    await expect(successfulTool).toHaveCount(1);
    await expect(successfulTool).not.toHaveAttribute("open", "");
    await successfulTool.locator("summary").press("Enter");
    await expect(successfulTool).toContainText("5000");
    await expect(successfulTool.getByRole("button", { name: "Open complete output" })).toBeVisible();

    const modelRequest = provider.requests.find((body) => body.includes("show evidence") && !body.includes('"role":"tool"'))!;
    expect(modelRequest).toContain("visible-command-output");
    expect(modelRequest).not.toContain("hidden-command-output");

    await prompt.fill("show failure");
    await composer.getByRole("button", { name: "Run" }).click();
    await expect(timeline).toContainText("Failure recorded.");
    const failedTool = timeline.locator('details[aria-label="bash tool, failed"]');
    await expect(failedTool).toHaveAttribute("open", "");
    await expect(failedTool).toContainText("Command exited with code 7");

    await app.window.getByRole("button", { name: "Settings" }).click();
    await app.window.getByRole("checkbox", { name: "Expand thinking by default" }).check();
    await app.window.getByRole("button", { name: "Back to command center" }).click();
    await expect(timeline.locator('details[aria-label="Thinking"]')).toHaveAttribute("open", "");
  } finally {
    await close(app);
    await provider.close();
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("controls a Task model and shows usage through the Electron boundary", async () => {
  const environment = await fixture();
  const provider = await deterministicProvider(environment.root);
  const modelsPath = path.join(environment.agentDir, "models.json");
  const settingsPath = path.join(environment.agentDir, "settings.json");
  await writeFile(modelsPath, JSON.stringify({
    providers: {
      fixture: {
        baseUrl: provider.baseUrl,
        api: "openai-completions",
        apiKey: "fixture-key",
        models: [
          { id: "basic-model", name: "Basic model", contextWindow: 1_000, maxTokens: 200 },
          {
            id: "reasoning-model", name: "Reasoning model", reasoning: true, contextWindow: 1_000, maxTokens: 200,
            thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" },
            cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
          },
        ],
      },
      locked: {
        baseUrl: provider.baseUrl,
        api: "openai-completions",
        models: [{ id: "locked-model", name: "Locked model" }],
      },
    },
  }));
  await writeFile(settingsPath, JSON.stringify({ defaultProvider: "fixture", defaultModel: "basic-model", defaultThinkingLevel: "high" }));
  await writeFile(path.join(environment.agentDir, "auth.json"), "{}");
  const userData = path.join(environment.root, "pilot-user-data");
  const first = await launch(environment.agentDir, true, { PILOT_TEST_PROJECT_DIR: environment.project, PILOT_USER_DATA_DIR: userData });
  let taskFile = "";

  try {
    await first.window.getByRole("button", { name: "Add project" }).click();
    await first.window.getByRole("dialog", { name: "Project access" }).getByRole("button", { name: "Allow agent execution" }).click();
    await first.window.getByRole("button", { name: "New Task" }).click();

    const composer = first.window.getByRole("form", { name: "Task composer" });
    const modelControl = composer.getByRole("combobox", { name: "Provider and model" });
    await expect(modelControl).toHaveValue("fixture/basic-model");
    await modelControl.focus();
    await expect(modelControl).toBeFocused();
    await expect(modelControl.locator('optgroup[label="Fixture"]')).toBeAttached();
    const optionsButton = composer.getByRole("button", { name: "Model options" });
    await optionsButton.press("Enter");
    const controls = composer.getByRole("group", { name: "Model options" });
    await controls.getByRole("button", { name: /Unavailable providers/ }).click();
    await expect(controls).toContainText("Locked");
    await expect(controls).toContainText("Credentials not configured");
    const providerSettings = controls.getByRole("button", { name: "Open provider Settings" });
    await expect(providerSettings).toBeVisible();
    await providerSettings.click();
    await expect(first.window.getByRole("region", { name: "Provider authentication" })).toBeVisible();
    await first.window.getByRole("button", { name: "Back to command center" }).click();

    await modelControl.selectOption("fixture/reasoning-model");
    await expect(modelControl).toHaveValue("fixture/reasoning-model");
    await optionsButton.press("Enter");
    const thinking = controls.getByRole("combobox", { name: "Thinking level" });
    await expect(thinking.getByRole("option")).toHaveText(["Off", "High", "Max"]);
    await thinking.selectOption("max");

    const prompt = composer.getByRole("textbox", { name: "Prompt" });
    await prompt.fill("model controls stats");
    await composer.getByRole("button", { name: "Run" }).click();
    await expect(first.window.getByRole("region", { name: "Run timeline" })).toContainText("Usage recorded.");
    await expect(first.window.getByRole("region", { name: "Task details" })).toContainText("150 / 1,000");
    await expect(first.window.getByRole("region", { name: "Task details" })).toContainText("$0.00019");

    const directory = sessionDirectory(environment.agentDir, await realpath(environment.project));
    taskFile = path.join(directory, (await readdir(directory)).find((file) => file.endsWith(".jsonl"))!);
    const saved = (await readFile(taskFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(saved.filter((entry) => entry.type === "model_change").at(-1)).toMatchObject({ provider: "fixture", modelId: "reasoning-model" });
    expect(saved.filter((entry) => entry.type === "thinking_level_change").at(-1)).toMatchObject({ thinkingLevel: "max" });
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toMatchObject({ defaultModel: "basic-model", defaultThinkingLevel: "high" });

    await first.window.getByRole("button", { name: "New Task" }).click();
    await expect(first.window.getByRole("form", { name: "Task composer" }).getByRole("combobox", { name: "Provider and model" })).toHaveValue("fixture/basic-model");
  } finally {
    await close(first);
  }

  SessionManager.open(taskFile).appendSessionInfo("model controls stats");
  await writeFile(modelsPath, JSON.stringify({
    providers: {
      fixture: {
        baseUrl: provider.baseUrl,
        api: "openai-completions",
        apiKey: "fixture-key",
        models: [{ id: "basic-model", name: "Basic model", contextWindow: 1_000, maxTokens: 200 }],
      },
    },
  }));
  const second = await launch(environment.agentDir, true, { PILOT_USER_DATA_DIR: userData });
  try {
    await second.window.getByRole("list", { name: "Active Tasks in fixture-project" }).getByRole("button", { name: "model controls stats" }).click();
    const fallback = second.window.getByRole("status", { name: "Model fallback" });
    await expect(fallback).toContainText("Could not restore fixture/reasoning-model");
    await expect(fallback).toContainText("Using fixture/basic-model");
    const choose = fallback.getByRole("button", { name: "Choose another model" });
    await choose.focus();
    await choose.press("Enter");
    await expect(second.window.getByRole("combobox", { name: "Provider and model" })).toBeFocused();
    await fallback.getByRole("button", { name: "Use fallback model" }).click();
    await expect(fallback).toHaveCount(0);
    const restored = (await readFile(taskFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(restored.filter((entry) => entry.type === "model_change").at(-1)).toMatchObject({ provider: "fixture", modelId: "basic-model" });
  } finally {
    await close(second);
    await provider.close();
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("does not admit Projects from global Pi session discovery", async () => {
  const environment = await fixture();
  const app = await launch(environment.agentDir);

  try {
    await expect(app.window).toHaveTitle("PiLot");
    await expect(app.window.getByRole("navigation", { name: "Projects and tasks" })).not.toContainText("fixture-project");
    await expect(app.window.getByRole("main")).toContainText("Ready to work");
    await expect(app.window.getByText("fixture-secret")).toHaveCount(0);
    await expect(app.window.getByRole("complementary", { name: "Inspector" })).toBeVisible();
    expect(await app.window.evaluate(() => {
      const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
      return {
        bodyOverflow: style("body").overflow,
        mainOverflow: style("main").overflowY,
        navigationOverflow: style("nav").overflow,
        inspectorOverflow: style("aside").overflow,
        chromeMatchesLayout: style(".window-bar").backgroundColor === style("nav").backgroundColor,
        process: typeof process,
        require: typeof require,
      };
    })).toEqual({
      bodyOverflow: "hidden",
      mainOverflow: "auto",
      navigationOverflow: "hidden",
      inspectorOverflow: "hidden",
      chromeMatchesLayout: true,
      process: "undefined",
      require: "undefined",
    });
  } finally {
    await close(app);
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("loads the renderer from Vite during development", async () => {
  const environment = await fixture();
  const server = await createServer();
  let app: Awaited<ReturnType<typeof launch>> | undefined;

  try {
    await server.listen();
    app = await launch(environment.agentDir, false, { PILOT_DEV_SERVER: "1" });
    await expect(app.window).toHaveURL("http://127.0.0.1:5173/");
    await expect(app.window.locator('script[src*="/@vite/client"]')).toHaveCount(1);
    await expect(app.window.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute(
      "content",
      /style-src 'self' 'unsafe-inline'.*connect-src ws:\/\/127\.0\.0\.1:5173/,
    );
    await expect.poll(() => app?.window.locator(".shell").evaluate((element) => getComputedStyle(element).display)).toBe("grid");
  } finally {
    if (app) await close(app);
    await server.close();
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("configures providers on a dedicated settings page without exposing secrets", async () => {
  const environment = await fixture();
  await writeFile(path.join(environment.agentDir, "models.json"), JSON.stringify({
    providers: {
      fixture: {
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        apiKey: "local-placeholder",
        models: [{ id: "fixture-model", name: "Fixture model" }],
      },
    },
  }));
  const app = await launch(environment.agentDir, false, { OPENAI_API_KEY: "fixture-env-secret" });

  try {
    const settingsButton = app.window.getByRole("navigation", { name: "Projects and tasks" }).getByRole("button", { name: "Settings" });
    await settingsButton.click();
    const settings = app.window.getByRole("main", { name: "Settings" });
    await expect(app.window.getByRole("dialog")).toHaveCount(0);
    await app.window.getByRole("button", { name: "Providers" }).click();
    const setup = settings.getByRole("region", { name: "Provider authentication" });
    await expect(setup).toContainText("Anthropic");
    await expect(setup).toContainText("Stored API key");
    await expect(setup).toContainText("Environment");
    await expect(setup).toContainText("models.json");
    await expect(setup).not.toContainText("fixture-secret");
    await expect(setup).not.toContainText("fixture-env-secret");
    await expect(setup).not.toContainText("local-placeholder");

    await setup.getByLabel("Provider").selectOption("fixture");
    const models = setup.getByRole("list", { name: "Available models" });
    await expect(models.getByRole("listitem")).toContainText("Fixture model");
    await expect(models.getByRole("listitem")).toContainText("fixture-model");
    await expect(setup).toContainText("Switch models from the contextual control in a Task.");

    await writeFile(path.join(environment.agentDir, "models.json"), JSON.stringify({
      providers: {
        fixture: {
          baseUrl: "http://127.0.0.1:11434/v1",
          api: "openai-completions",
          apiKey: "changed-placeholder",
          models: [
            { id: "fixture-model", name: "Fixture model" },
            { id: "external-model", name: "External model" },
          ],
        },
      },
    }));
    const refreshProviders = setup.getByRole("button", { name: "Refresh providers" });
    await refreshProviders.focus();
    await refreshProviders.press("Enter");
    await expect(models.getByRole("listitem")).toHaveCount(2);
    await expect(models).toContainText("External model");
    await expect(setup).not.toContainText("changed-placeholder");

    await setup.getByLabel("Provider").selectOption("anthropic");
    await expect(setup.getByRole("button", { name: "Use subscription" })).toBeVisible();
    await setup.getByRole("button", { name: "Replace API key" }).click();
    await setup.getByLabel("API key for Anthropic").fill("replacement-secret");
    await setup.getByRole("button", { name: "Save API key" }).click();
    await expect(setup).not.toContainText("replacement-secret");
    expect(JSON.parse(await readFile(path.join(environment.agentDir, "auth.json"), "utf8"))).toMatchObject({
      anthropic: { type: "api_key", key: "replacement-secret" },
    });

    await setup.getByRole("button", { name: "Remove API key" }).click();
    await expect(setup).toContainText("Environment");
    expect(JSON.parse(await readFile(path.join(environment.agentDir, "auth.json"), "utf8")).anthropic).toBeUndefined();

    await writeFile(path.join(environment.agentDir, "auth.json"), JSON.stringify({
      anthropic: { type: "oauth", access: "oauth-secret", refresh: "refresh-secret", expires: Date.now() + 60_000 },
    }));
    await refreshProviders.press("Enter");
    await expect(setup).toContainText("Subscription");
    await expect(setup.getByRole("button", { name: "Reauthenticate" })).toBeVisible();
    await expect(setup).not.toContainText("oauth-secret");
    await setup.getByRole("button", { name: "Log out" }).click();
    await expect(setup).toContainText("Environment");

    await app.window.getByRole("button", { name: "Back to command center" }).click();
    await expect(app.window.getByRole("main")).toContainText("Ready to work");
    await expect(settingsButton).toBeFocused();
    await settingsButton.press("Enter");
    await app.window.keyboard.press("Escape");
    await expect(settingsButton).toBeFocused();
  } finally {
    await close(app);
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("applies and persists PiLot appearance preferences", async () => {
  const environment = await fixture();
  const userData = path.join(environment.root, "pilot-user-data");
  const first = await launch(environment.agentDir, false, { PILOT_USER_DATA_DIR: userData });

  try {
    await first.window.getByRole("button", { name: "Settings" }).click();
    const settings = first.window.getByRole("main", { name: "Settings" });
    await expect(settings.getByRole("radio", { name: "System" })).toBeChecked();
    await settings.getByRole("radio", { name: "Dark" }).check();
    await expect.poll(() => first.window.evaluate(() => getComputedStyle(document.documentElement).color)).toBe("rgb(232, 232, 229)");
    await expect(first.window.getByRole("button", { name: "General" })).toHaveAttribute("aria-current", "page");
    await first.window.getByRole("button", { name: "Providers" }).click();
    await expect(settings.getByRole("region", { name: "Provider authentication" })).toBeVisible();
    expect(await first.window.evaluate(() => {
      const background = (selector: string) => getComputedStyle(document.querySelector(selector)!).backgroundColor;
      return background(".provider-setup") === background(".settings-main");
    })).toBe(true);
  } finally {
    await close(first);
  }

  const second = await launch(environment.agentDir, false, { PILOT_USER_DATA_DIR: userData });
  try {
    await second.window.getByRole("button", { name: "Settings" }).click();
    await expect(second.window.getByRole("radio", { name: "Dark" })).toBeChecked();
    expect(JSON.parse(await readFile(path.join(userData, "preferences.json"), "utf8"))).toEqual({ appearance: "dark", expandThinking: false });
    expect(JSON.parse(await readFile(path.join(environment.agentDir, "settings.json"), "utf8").catch(() => "{}"))).toEqual({});
  } finally {
    await close(second);
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("admits a Project before presenting its existing Pi sessions as Tasks", async () => {
  const environment = await fixture();
  const canonicalProject = await realpath(environment.project);
  const timestamp = "2026-07-13T00:00:00.000Z";
  const header = (id: string) => ({ type: "session", version: 3, id, timestamp, cwd: environment.project });
  const message = (id: string, content: string) => ({
    type: "message", id, parentId: null, timestamp,
    message: { role: "user", content, timestamp: Date.parse(timestamp) },
  });
  const named = await writeSession(environment.agentDir, environment.project, "named", [
    header("named"),
    message("message-1", "Original prompt"),
    { type: "session_info", id: "name-1", parentId: "message-1", timestamp, name: "Repair release build" },
  ]);
  const inferred = await writeSession(environment.agentDir, environment.project, "inferred", [
    header("inferred"),
    message("message-2", "  Explain the flaky checkout test\nwithout changing production.  "),
  ]);
  const newer = await writeSession(environment.agentDir, environment.project, "newer", [
    { ...header("newer"), version: 99 },
    message("message-3", "Future work"),
  ]);
  const newerBytes = await readFile(newer);
  await writeFile(path.join(sessionDirectory(environment.agentDir, environment.project), "malformed.jsonl"), "not json\n");
  const app = await launch(environment.agentDir, false, { PILOT_TEST_PROJECT_DIR: environment.project });

  try {
    const navigation = app.window.getByRole("navigation", { name: "Projects and tasks" });
    await expect(navigation).not.toContainText("fixture-project");
    await navigation.getByRole("button", { name: "Add project" }).click();

    const access = app.window.getByRole("dialog", { name: "Project access" });
    await expect(access).toBeVisible();
    await expect(navigation).not.toContainText("fixture-project");
    await access.getByRole("button", { name: "Allow agent execution" }).click();

    expect(JSON.parse(await readFile(path.join(environment.agentDir, "trust.json"), "utf8"))[canonicalProject]).toBe(true);
    await expect(navigation).toContainText("fixture-project");
    await expect(navigation).toContainText("Repair release build");
    const active = app.window.getByRole("region", { name: "Active tasks" });
    await expect(active).toContainText("Repair release build");
    await expect(active).toContainText("Explain the flaky checkout test without changing production.");
    await expect(app.window.getByRole("region", { name: "Archived tasks" })).toContainText("No archived Tasks");
    const diagnostics = app.window.getByRole("region", { name: "Task diagnostics" });
    await expect(diagnostics).toContainText("Update PiLot to open newer Tasks");
    await expect(diagnostics).toContainText("Review unreadable Task history");
    expect(await readFile(newer)).toEqual(newerBytes);

    await expect.poll(async () => (await readFile(named, "utf8")).includes('"customType":"pilot.task"')).toBe(true);
    expect(await readFile(inferred, "utf8")).toContain('"customType":"pilot.task"');

    const namedTask = active.getByRole("listitem").filter({ hasText: "Repair release build" });
    await namedTask.getByRole("button", { name: "Archive" }).click();
    await expect(active).not.toContainText("Repair release build");
    await expect(app.window.getByRole("region", { name: "Archived tasks" })).toContainText("Repair release build");
    expect(await readFile(named, "utf8")).toContain('"lifecycle":"archived"');

    const inspector = app.window.getByRole("complementary", { name: "Inspector" });
    await expect(inspector).not.toContainText("Pi resource trust");
    await expect(inspector).not.toContainText("Agent execution");
    await expect(inspector).not.toContainText("Remove Project");

    const beforeRemoval = await readFile(named);
    await app.window.getByRole("button", { name: "Project actions" }).click();
    const projectMenu = app.window.getByRole("menu", { name: "Project actions" });
    await expect(projectMenu.getByRole("menuitem", { name: "Project access" })).toBeVisible();
    await projectMenu.getByRole("menuitem", { name: "Remove Project" }).click();
    await expect(navigation).not.toContainText("fixture-project");
    expect(await readFile(named)).toEqual(beforeRemoval);
    expect(await readFile(newer)).toEqual(newerBytes);
    const saved = JSON.parse(await readFile(path.join(environment.agentDir, "pilot-user-data", "projects.json"), "utf8"));
    expect(saved.recentProjects).toEqual([]);
    expect(saved.executionConsent).toEqual({});
  } finally {
    await close(app);
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("bounds large admitted Task lists with an actionable diagnostic", async () => {
  const environment = await fixture();
  const directory = sessionDirectory(environment.agentDir, environment.project);
  await mkdir(directory, { recursive: true });
  await Promise.all(Array.from({ length: 501 }, (_, index) => writeFile(
    path.join(directory, `${String(index).padStart(3, "0")}.jsonl`),
    `${JSON.stringify({ type: "session", version: 3, id: `large-${index}`, timestamp: new Date().toISOString(), cwd: environment.project })}\n`,
  )));
  const app = await launch(environment.agentDir, false, { PILOT_TEST_PROJECT_DIR: environment.project });

  try {
    await app.window.getByRole("button", { name: "Add project" }).click();
    const access = app.window.getByRole("dialog", { name: "Project access" });
    await access.getByRole("button", { name: "Allow agent execution" }).click();
    await expect(access).toHaveCount(0, { timeout: 20_000 });
    const diagnostics = app.window.getByRole("region", { name: "Task diagnostics" });
    await expect(diagnostics).toContainText("This Project has 502 Pi task files");
    await expect(diagnostics).toContainText("loaded the newest 500");
    await expect(app.window.getByRole("region", { name: "Active tasks" }).getByRole("listitem")).toHaveCount(500);
  } finally {
    await close(app);
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("adds a Project and keeps Pi resource trust separate from execution consent", async () => {
  const environment = await fixture();
  const project = path.join(environment.root, "picked-project");
  const userData = path.join(environment.root, "pilot-user-data");
  await mkdir(path.join(project, ".pi"), { recursive: true });
  const canonicalProject = await realpath(project);
  await writeFile(path.join(project, ".pi", "settings.json"), "{}");

  const first = await launch(environment.agentDir, false, {
    PILOT_USER_DATA_DIR: userData,
    PILOT_TEST_PROJECT_DIR: project,
  });

  try {
    const addProject = first.window.getByRole("button", { name: "Add project" });
    await addProject.focus();
    await addProject.press("Enter");

    const projectAccess = first.window.getByRole("dialog", { name: "Project access" });
    await expect(projectAccess).toBeVisible();
    await first.window.keyboard.press("Escape");
    await expect(projectAccess).toBeVisible();
    await expect(projectAccess).toContainText(project);
    await expect(first.window.getByRole("main")).not.toContainText("Pi resource trust");
    await expect(projectAccess.getByRole("status", { name: "Pi resource trust" })).toContainText("Not decided");
    await expect(projectAccess.getByRole("status", { name: "Agent execution" })).toContainText("Not granted");
    await expect(projectAccess).toContainText("Prompts and setup commands are blocked");

    const trust = projectAccess.getByRole("button", { name: "Trust project resources", exact: true });
    await trust.focus();
    await trust.press("Enter");
    await expect(projectAccess.getByRole("status", { name: "Pi resource trust" })).toContainText("Trusted");
    expect(JSON.parse(await readFile(path.join(environment.agentDir, "trust.json"), "utf8"))[canonicalProject]).toBe(true);

    await projectAccess.getByRole("button", { name: "Allow agent execution" }).click();
    await expect(projectAccess).toHaveCount(0);
    const inspector = first.window.getByRole("complementary", { name: "Inspector" });
    await expect(inspector).not.toContainText("Pi resource trust");
    await expect(inspector).not.toContainText("Agent execution");
    expect(JSON.parse(await readFile(path.join(userData, "projects.json"), "utf8")).executionConsent[canonicalProject]).toBe(true);

    const projectActions = first.window.getByRole("button", { name: "Project actions" });
    await projectActions.focus();
    await projectActions.press("Enter");
    await expect(first.window.getByRole("menuitem", { name: "Project access" })).toBeFocused();
    await first.window.keyboard.press("Escape");
    await expect(projectActions).toBeFocused();
    await projectActions.click();
    await first.window.getByRole("menuitem", { name: "Project access" }).click();
    const reopenedAccess = first.window.getByRole("dialog", { name: "Project access" });
    await expect(reopenedAccess.getByRole("status", { name: "Agent execution" })).toContainText("Granted");
    await reopenedAccess.getByRole("button", { name: "Revoke agent execution" }).click();
    const revokedAccess = first.window.getByRole("dialog", { name: "Project access" });
    await expect(revokedAccess.getByRole("button", { name: "Close project access" })).toHaveCount(0);
    await first.window.keyboard.press("Escape");
    await expect(revokedAccess).toBeVisible();
    await expect(revokedAccess.getByRole("status", { name: "Agent execution" })).toContainText("Not granted");
    await expect(revokedAccess.getByRole("status", { name: "Pi resource trust" })).toContainText("Trusted");
    expect(JSON.parse(await readFile(path.join(environment.agentDir, "trust.json"), "utf8"))[canonicalProject]).toBe(true);
  } finally {
    await close(first);
  }

  const second = await launch(environment.agentDir, false, { PILOT_USER_DATA_DIR: userData });
  try {
    await expect(second.window.getByRole("navigation", { name: "Projects and tasks" })).toContainText("picked-project");
    const projectAccess = second.window.getByRole("dialog", { name: "Project access" });
    await expect(projectAccess).toContainText(project);
    await expect(projectAccess.getByRole("status", { name: "Pi resource trust" })).toContainText("Trusted");
    await expect(projectAccess.getByRole("status", { name: "Agent execution" })).toContainText("Not granted");
    const deny = projectAccess.getByRole("button", { name: "Do not trust project resources" });
    await deny.focus();
    await deny.press("Enter");
    await expect(projectAccess.getByRole("status", { name: "Pi resource trust" })).toContainText("Not trusted");
    expect(JSON.parse(await readFile(path.join(environment.agentDir, "trust.json"), "utf8"))[canonicalProject]).toBe(false);
  } finally {
    await close(second);
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("keeps unadmitted Task diagnostics out of readiness", async () => {
  const environment = await fixture(99);
  await rm(path.join(environment.agentDir, "auth.json"));
  await writeFile(path.join(environment.agentDir, "settings.json"), JSON.stringify({ shellPath: path.join(environment.root, "missing-bash") }));
  const app = await launch(environment.agentDir, true);

  try {
    const readiness = app.window.getByRole("region", { name: "Readiness" });
    await expect(readiness).toContainText("Connect a provider");
    await expect(readiness).toContainText("Install a compatible Bash shell");
    await expect(readiness).not.toContainText("Update PiLot to open newer Tasks");
    await expect(readiness).not.toContainText("Pi environment");
    await readiness.focus();
    await expect(readiness).toBeFocused();
  } finally {
    await close(app);
    await rm(environment.root, { recursive: true, force: true });
  }
});
