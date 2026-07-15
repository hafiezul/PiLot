import { getShellConfig, SessionManager } from "@earendil-works/pi-coding-agent";
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { createServer as createPortServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "vite";

const appPath = path.resolve(import.meta.dirname, "..");
const electronPath = createRequire(import.meta.url)("electron") as string;
const execute = promisify(execFile);

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

const historyTimestamp = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`;
const historyUsage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function historyUser(id: string, parentId: string, content: string, second: number) {
  return { type: "message", id, parentId, timestamp: historyTimestamp(second), message: { role: "user", content, timestamp: Date.parse(historyTimestamp(second)) } };
}

function historyAssistant(id: string, parentId: string, content: string, second: number) {
  return {
    type: "message", id, parentId, timestamp: historyTimestamp(second),
    message: {
      role: "assistant", content: [{ type: "text", text: content }], api: "openai-completions",
      provider: "fixture", model: "fixture-model", usage: historyUsage, stopReason: "stop",
      timestamp: Date.parse(historyTimestamp(second)),
    },
  };
}

async function writeBranchedHistory(agentDir: string, project: string) {
  return writeSession(agentDir, project, "history", [
    { type: "session", version: 3, id: "history-fixture", timestamp: historyTimestamp(0), cwd: project },
    { type: "custom", customType: "pilot.task", id: "task-meta", parentId: null, timestamp: historyTimestamp(1), data: { version: 1, title: "History fixture", lifecycle: "active" } },
    historyUser("root-prompt", "task-meta", "Choose an architecture", 2),
    historyAssistant("shared-answer", "root-prompt", "Shared answer", 3),
    historyUser("branch-a-prompt", "shared-answer", "Implement branch A", 4),
    historyAssistant("branch-a-answer", "branch-a-prompt", "Branch A done", 5),
    { type: "compaction", id: "compaction-a", parentId: "branch-a-answer", timestamp: historyTimestamp(6), summary: "Earlier branch A context", firstKeptEntryId: "branch-a-prompt", tokensBefore: 12000 },
    { type: "model_change", id: "model-a", parentId: "compaction-a", timestamp: historyTimestamp(7), provider: "fixture", modelId: "fixture-model" },
    { type: "thinking_level_change", id: "thinking-a", parentId: "model-a", timestamp: historyTimestamp(8), thinkingLevel: "high" },
    historyUser("branch-b-prompt", "shared-answer", "Implement branch B", 9),
    historyAssistant("branch-b-answer", "branch-b-prompt", "Branch B done", 10),
    { type: "label", id: "label-b", parentId: "branch-b-answer", timestamp: historyTimestamp(11), targetId: "branch-b-prompt", label: "Preferred route" },
    { type: "custom", customType: "pilot.run", id: "run-b", parentId: "label-b", timestamp: historyTimestamp(12), data: { version: 1, outcome: "settled" } },
  ]);
}

async function childSession(directory: string, parentSession: string) {
  const files = (await readdir(directory)).filter((name) => name.endsWith(".jsonl")).map((name) => path.join(directory, name));
  for (const file of files) {
    const header = JSON.parse((await readFile(file, "utf8")).split("\n", 1)[0]);
    if (header.parentSession === parentSession) return file;
  }
  return "";
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
  const testHome = extraEnv.HOME ?? path.join(agentDir, "pilot-test-home");
  await mkdir(testHome, { recursive: true });
  const child = spawn(electronPath, [
    appPath,
    `--pilot-debug-port=${port}`,
    ...(test.info().project.use.headless === false ? [] : ["--pilot-test-hidden"]),
  ], {
    env: { ...env, HOME: testHome, PILOT_USER_DATA_DIR: path.join(agentDir, "pilot-user-data"), ...extraEnv, PI_CODING_AGENT_DIR: agentDir },
    stdio: "ignore",
  });
  const endpoint = `http://127.0.0.1:${port}`;
  let browser: Browser | undefined;
  for (let attempt = 0; attempt < 200 && !browser; attempt++) {
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

async function terminate(app: { browser: Browser; process: ChildProcess }) {
  const exit = app.process.exitCode === null ? once(app.process, "exit") : undefined;
  if (app.process.exitCode === null) app.process.kill("SIGKILL");
  await exit;
  await app.browser.close().catch(() => undefined);
}

async function openCurrentTaskPathError(page: Page, filePath: string, application = "vscode") {
  return page.evaluate(async ({ target, applicationId }) => {
    const pilot = (window as any).pilot;
    const state = await pilot.getProjects();
    const project = state.selected;
    const task = project.tasks.reduce((latest: { modified: string }, candidate: { modified: string }) => candidate.modified > latest.modified ? candidate : latest);
    try {
      await pilot.openTaskPathInApplication(project.path, task.path, applicationId, target);
      return "";
    } catch (reason) {
      return reason instanceof Error ? reason.message : String(reason);
    }
  }, { target: filePath, applicationId: application });
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
  const heldConcurrent = new Map<string, () => void>();
  let activeConcurrent = 0;
  let maximumConcurrent = 0;
  const server = createHttpServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push(body);
      const latestUser = latestUserText(body);
      const matchingRequests = requests.filter((value) => latestUserText(value) === latestUser).length;
      if ((latestUser === "retry then succeed" && matchingRequests <= 2)
        || (latestUser === "two retry episodes" && (matchingRequests === 1 || matchingRequests === 3))
        || latestUser === "abort pending retry") {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "503 service unavailable" } }));
        return;
      }
      if (latestUser === "recover overflow" && matchingRequests === 1) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "maximum context length exceeded" } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (choice: object) => response.write(`data: ${JSON.stringify({
        id: "fixture-response", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [choice],
      })}\n\n`);
      if (latestUser.startsWith("hold concurrent ")) {
        activeConcurrent += 1;
        maximumConcurrent = Math.max(maximumConcurrent, activeConcurrent);
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          heldConcurrent.delete(latestUser);
          activeConcurrent -= 1;
          if (response.destroyed) return;
          chunk({ index: 0, delta: { role: "assistant", content: `Finished ${latestUser}.` }, finish_reason: null });
          chunk({ index: 0, delta: {}, finish_reason: "stop" });
          response.end("data: [DONE]\n\n");
        };
        heldConcurrent.set(latestUser, finish);
        chunk({ index: 0, delta: { role: "assistant", content: `Running ${latestUser}.` }, finish_reason: null });
        response.once("close", finish);
        return;
      }
      if (latestUser.startsWith("<conversation>")) {
        const finishCompaction = () => {
          if (response.destroyed) return;
          chunk({ index: 0, delta: { role: "assistant", content: "Compaction summary." }, finish_reason: null });
          chunk({ index: 0, delta: {}, finish_reason: "stop" });
          response.end("data: [DONE]\n\n");
        };
        if (latestUser.includes("prepare stop compaction")) {
          const timer = setTimeout(finishCompaction, 5_000);
          response.once("close", () => clearTimeout(timer));
        } else {
          finishCompaction();
        }
        return;
      }
      if (latestUser === "two retry episodes") {
        if (matchingRequests === 2) {
          chunk({ index: 0, delta: { role: "assistant", tool_calls: [{
            index: 0, id: "retry-episode-tool", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "printf retry-episode" }) },
          }] }, finish_reason: null });
          chunk({ index: 0, delta: {}, finish_reason: "tool_calls" });
        } else {
          chunk({ index: 0, delta: { role: "assistant", content: "Both retry episodes recovered." }, finish_reason: null });
          chunk({ index: 0, delta: {}, finish_reason: "stop" });
        }
        response.end("data: [DONE]\n\n");
        return;
      }
      if (latestUser === "retry then succeed") {
        chunk({ index: 0, delta: { role: "assistant", content: "Retry recovered." }, finish_reason: null });
        chunk({ index: 0, delta: {}, finish_reason: "stop" });
        response.end("data: [DONE]\n\n");
        return;
      }
      if (latestUser === "recover overflow") {
        chunk({ index: 0, delta: { role: "assistant", content: "Overflow recovered." }, finish_reason: null });
        chunk({ index: 0, delta: {}, finish_reason: "stop" });
        response.end("data: [DONE]\n\n");
        return;
      }
      if (latestUser === "cross compaction threshold") {
        chunk({ index: 0, delta: { role: "assistant", content: "Threshold reached." }, finish_reason: null });
        response.write(`data: ${JSON.stringify({
          id: "fixture-response", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [],
          usage: { prompt_tokens: 195, completion_tokens: 1, total_tokens: 196 },
        })}\n\n`);
        chunk({ index: 0, delta: {}, finish_reason: "stop" });
        response.end("data: [DONE]\n\n");
        return;
      }
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
      if (latestUser === "edit tracked file") {
        if (body.includes("changes-edit-tool")) {
          chunk({ index: 0, delta: { role: "assistant", content: "Changes ready." }, finish_reason: null });
          chunk({ index: 0, delta: {}, finish_reason: "stop" });
        } else {
          chunk({ index: 0, delta: { role: "assistant", tool_calls: [{
            index: 0, id: "changes-edit-tool", type: "function", function: { name: "edit", arguments: JSON.stringify({
              path: "src/app.ts",
              edits: [{ oldText: "export const value = 1;", newText: "export const value = 2;\nexport const extra = true;" }],
            }) },
          }] }, finish_reason: null });
          chunk({ index: 0, delta: {}, finish_reason: "tool_calls" });
        }
        response.end("data: [DONE]\n\n");
        return;
      }
      if (latestUser === "inspect project environment") {
        if (body.includes("environment-tool")) {
          chunk({ index: 0, delta: { role: "assistant", content: "Environment checked." }, finish_reason: null });
          chunk({ index: 0, delta: {}, finish_reason: "stop" });
        } else {
          chunk({ index: 0, delta: { tool_calls: [{
            index: 0, id: "environment-tool", type: "function", function: {
              name: "bash",
              arguments: JSON.stringify({ command: "printf '%s|%s|%s|%s|' \"$PILOT_CAPTURED_ONLY\" \"$PILOT_LAYERED\" \"$CAPTURE_UNICODE_HOST\" \"${CAPTURE_SHOULD_UNSET-unset}\"; pilot-login-tool" }),
            },
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
      if (latestUser.includes("abort model")) {
        chunk({ index: 0, delta: { role: "assistant", content: "Still streaming" }, finish_reason: null });
        const timer = setTimeout(() => response.end("data: [DONE]\n\n"), 5_000);
        response.once("close", () => {
          clearTimeout(timer);
          void writeFile(modelStopped, "stopped");
        });
        return;
      }
      if (latestUser === "crash after file write" || latestUser.includes("abort tool")) {
        chunk({ index: 0, delta: { role: "assistant", tool_calls: [{
          index: 0, id: "fixture-tool", type: "function", function: {
            name: "bash",
            arguments: JSON.stringify({ command: latestUser === "crash after file write"
              ? "printf interrupted > crash.txt; sleep 5"
              : `printf started > ${JSON.stringify(started)}; sleep 5; printf finished > ${JSON.stringify(finished)}` }),
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
    releaseConcurrent(prompt: string) { heldConcurrent.get(prompt)?.(); },
    get activeConcurrent() { return activeConcurrent; },
    get maximumConcurrent() { return maximumConcurrent; },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("invokes native actions through menus and the Command Palette", async () => {
  const environment = await fixture();
  const provider = await deterministicProvider(environment.root);
  await writeFile(path.join(environment.agentDir, "models.json"), JSON.stringify({
    providers: {
      fixture: {
        baseUrl: provider.baseUrl,
        api: "openai-completions",
        apiKey: "fixture-key",
        models: [{ id: "fixture-model", name: "Fixture model", reasoning: true, thinkingLevelMap: { off: null, high: "high" } }],
      },
    },
  }));
  await writeFile(path.join(environment.agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture-model" }));
  const app = await launch(environment.agentDir, false, { PILOT_TEST_PROJECT_DIR: environment.project, PILOT_TEST_EXPORT_DIR: environment.root });
  const primary = process.platform === "darwin" ? "Meta" : "Control";

  try {
    await app.window.getByRole("button", { name: "Add project" }).click();
    await app.window.getByRole("dialog", { name: "Project access" }).getByRole("button", { name: "Allow agent execution" }).click();
    await app.window.getByRole("button", { name: "New Task" }).click();
    const prompt = app.window.getByRole("combobox", { name: "Prompt" });

    await prompt.focus();
    await app.window.keyboard.press(`${primary}+Shift+P`);
    const palette = app.window.getByRole("dialog", { name: "Command Palette" });
    await expect(palette).toBeVisible();
    const actions = palette.getByRole("listbox", { name: "Actions" });
    const actionSearch = palette.getByRole("combobox", { name: "Search actions" });
    await expect(actions.getByRole("option", { name: /Open Command Palette/ })).toHaveCount(0);
    await expect(app.window.getByRole("button", { name: /Command Palette/ })).toContainText(process.platform === "darwin" ? "⇧⌘P" : "Ctrl+Shift+P");
    await expect(actions.getByText("Available now · File", { exact: true })).toBeVisible();
    await expect(actions.getByText("Available now · Task", { exact: true })).toBeVisible();
    await expect(actions.getByText("Available now · Run", { exact: true })).toBeVisible();
    await expect(actions.getByText("Available now · View", { exact: true })).toBeVisible();
    await expect(actions.getByText("Unavailable · Run", { exact: true })).toBeVisible();
    const availabilityOrder = await actions.getByRole("option").evaluateAll((options) => options.map((option) => option.getAttribute("aria-disabled")));
    expect(availabilityOrder).toEqual([...availabilityOrder].sort());
    expect(await actions.getByRole("option").evaluateAll((options) => options.map((option) => (option as HTMLElement).tabIndex))).toEqual(Array(13).fill(-1));
    const paletteContrast = (appearance: "light" | "dark") => app.window.evaluate((nextAppearance) => {
      document.documentElement.dataset.appearance = nextAppearance;
      const parse = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const luminance = (value: string) => {
        const channels = parse(value).map((channel) => {
          const normalized = channel / 255;
          return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
        });
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      };
      const ratio = (left: string, right: string) => {
        const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
        return (values[0] + 0.05) / (values[1] + 0.05);
      };
      const paletteElement = document.querySelector<HTMLElement>(".command-palette")!;
      const selected = paletteElement.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')!;
      const input = paletteElement.querySelector<HTMLInputElement>('input[type="search"]')!;
      const paletteBackground = getComputedStyle(paletteElement).backgroundColor;
      return {
        selectedText: ratio(getComputedStyle(selected).color, getComputedStyle(selected).backgroundColor),
        focusRing: ratio(getComputedStyle(input).outlineColor, paletteBackground),
        placeholder: ratio(getComputedStyle(input, "::placeholder").color, paletteBackground),
      };
    }, appearance);
    for (const appearance of ["light", "dark"] as const) {
      const contrast = await paletteContrast(appearance);
      expect(contrast.selectedText).toBeGreaterThanOrEqual(4.5);
      expect(contrast.focusRing).toBeGreaterThanOrEqual(3);
      expect(contrast.placeholder).toBeGreaterThanOrEqual(4.5);
    }
    await app.window.evaluate(() => { document.documentElement.dataset.appearance = "system"; });
    await actionSearch.fill("stop run");
    await expect(actionSearch).not.toHaveAttribute("aria-activedescendant");
    await actionSearch.press("Enter");
    await expect(palette).toBeVisible();
    await actionSearch.fill("");
    await actionSearch.press("End");
    await expect(actions.locator('[aria-selected="true"]')).toHaveAttribute("aria-disabled", "false");
    await actionSearch.press("Home");
    await expect(actions.locator('[aria-selected="true"]')).toHaveAttribute("aria-disabled", "false");
    await actionSearch.fill("nw tsk");
    await expect(actions.getByRole("option", { name: /New Task/ })).toBeVisible();
    await actionSearch.fill("a");
    const resultGroups = await actions.getByRole("group").evaluateAll((groups) => groups.map((group) => group.getAttribute("aria-label")));
    expect(new Set(resultGroups).size).toBe(resultGroups.length);
    await actionSearch.press("Escape");
    await expect(palette).toBeHidden();
    await expect(prompt).toBeFocused();

    await app.window.setViewportSize({ width: 680, height: 520 });
    await app.window.getByRole("button", { name: /Command Palette/ }).click();
    const paletteBounds = await palette.boundingBox();
    expect(paletteBounds).toBeTruthy();
    expect(paletteBounds!.x).toBeGreaterThanOrEqual(0);
    expect(paletteBounds!.y + paletteBounds!.height).toBeLessThanOrEqual(520);
    await app.window.keyboard.press("Escape");
    await app.window.setViewportSize({ width: 1180, height: 760 });

    await app.window.keyboard.press(`${primary}+Shift+P`);
    await palette.getByRole("combobox", { name: "Search actions" }).fill("choose model");
    await palette.getByRole("option", { name: /Choose Model/ }).click();
    const modelPicker = app.window.getByRole("dialog", { name: "Choose model" });
    await expect(modelPicker).toBeVisible();
    await modelPicker.press("Escape");
    await expect(app.window.getByRole("button", { name: /Provider and model/ })).toBeFocused();

    await app.window.keyboard.press(`${primary}+Shift+P`);
    await palette.getByRole("combobox", { name: "Search actions" }).fill("reload resources");
    await palette.getByRole("option", { name: /Reload Pi Resources/ }).click();
    await expect(app.window.getByRole("status").filter({ hasText: "Pi resources reloaded" })).toBeVisible();

    await app.window.setViewportSize({ width: 800, height: 700 });
    await prompt.focus();
    await app.window.keyboard.press(`${primary}+Shift+P`);
    await palette.getByRole("combobox", { name: "Search actions" }).fill("show details");
    await palette.getByRole("option", { name: /Show Details/ }).click();
    await expect(app.window.getByRole("complementary", { name: "Inspector" })).toBeVisible();
    await app.window.keyboard.press(`${primary}+Shift+P`);
    await palette.getByRole("combobox", { name: "Search actions" }).fill("hide details");
    await palette.getByRole("option", { name: /Hide Details/ }).click();
    await expect(app.window.getByRole("complementary", { name: "Inspector" })).toBeHidden();
    await expect(prompt).toBeFocused();
    await app.window.setViewportSize({ width: 1180, height: 760 });

    await app.window.keyboard.press(`${primary}+Shift+P`);
    await palette.getByRole("combobox", { name: "Search actions" }).fill("export jsonl");
    const exportAction = palette.getByRole("option", { name: /Export Task as JSONL/ });
    await expect(exportAction).toHaveAttribute("aria-disabled", "false");
    await expect(exportAction).toContainText("File");
    await exportAction.click();
    await expect.poll(() => readFile(path.join(environment.root, "pilot-export.jsonl"), "utf8").catch(() => "")).toContain('"type":"session"');
    await app.window.keyboard.press(`${primary}+Shift+P`);
    await palette.getByRole("combobox", { name: "Search actions" }).fill("export html");
    await palette.getByRole("option", { name: /Export Task as HTML/ }).click();
    await expect.poll(() => readFile(path.join(environment.root, "pilot-export.html"), "utf8").catch(() => "")).toContain("<html");

    const activeTasks = app.window.getByRole("list", { name: /Active Tasks in/ }).getByRole("button");
    await expect(activeTasks).toHaveCount(2);
    await app.window.keyboard.press(`${primary}+Shift+P`);
    await expect(palette).toBeVisible();
    await expect(palette.getByRole("combobox", { name: "Search actions" })).toBeFocused();
    await palette.getByRole("combobox", { name: "Search actions" }).fill("new task");
    await expect(palette.getByRole("option", { name: /New Task/ })).toContainText(process.platform === "darwin" ? "⌘N" : "Ctrl+N");
    await palette.getByRole("option", { name: /New Task/ }).click();
    await expect(activeTasks).toHaveCount(3);

    const nextPrompt = app.window.getByRole("combobox", { name: "Prompt" });
    await nextPrompt.fill("/compact summarize this");
    await app.window.getByRole("button", { name: "Send" }).click();
    await expect(app.window.getByRole("alert")).toContainText("Pi terminal command");
    expect(provider.requests).toHaveLength(0);
  } finally {
    await close(app);
    await provider.close();
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("hides current-surface actions from the Command Palette", async () => {
  const environment = await fixture();
  const app = await launch(environment.agentDir);
  const primary = process.platform === "darwin" ? "Meta" : "Control";
  try {
    await app.window.getByRole("button", { name: "Settings" }).click();
    await app.window.keyboard.press(`${primary}+Shift+P`);
    const palette = app.window.getByRole("dialog", { name: "Command Palette" });
    await expect(palette).toBeVisible();
    await palette.getByRole("combobox", { name: "Search actions" }).fill("settings");
    await expect(palette.getByRole("option", { name: /^Settings/ })).toHaveCount(0);
  } finally {
    await close(app);
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("surfaces and dismisses native action failures", async () => {
  const environment = await fixture();
  const app = await launch(environment.agentDir, false, {
    PILOT_TEST_PROJECT_DIR: environment.project,
    PILOT_TEST_EXPORT_DIR: path.join(environment.root, "missing", "directory"),
  });
  try {
    await app.window.getByRole("button", { name: "Add project" }).click();
    await app.window.getByRole("dialog", { name: "Project access" }).getByRole("button", { name: "Allow agent execution" }).click();
    await app.window.getByRole("button", { name: "New Task" }).click();
    await app.window.getByRole("button", { name: /Command Palette/ }).click();
    const palette = app.window.getByRole("dialog", { name: "Command Palette" });
    await palette.getByRole("combobox", { name: "Search actions" }).fill("export jsonl");
    await palette.getByRole("option", { name: /Export Task as JSONL/ }).click();
    const alert = app.window.getByRole("alert");
    await expect(alert).toContainText("Action failed");
    await alert.getByRole("button", { name: "Dismiss error" }).click();
    await expect(alert).toHaveCount(0);
  } finally {
    await close(app);
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("attaches images and invokes trusted Pi resources through the Electron boundary", async () => {
  const environment = await fixture();
  const provider = await deterministicProvider(environment.root);
  const projectPrompt = path.join(environment.project, ".pi", "prompts", "project-template.md");
  const projectSkill = path.join(environment.project, ".pi", "skills", "project-skill", "SKILL.md");
  const extensionMarker = path.join(environment.root, "extension-ran");
  await Promise.all([
    mkdir(path.dirname(projectPrompt), { recursive: true }),
    mkdir(path.dirname(projectSkill), { recursive: true }),
    mkdir(path.join(environment.project, ".pi", "extensions"), { recursive: true }),
    mkdir(path.join(environment.project, ".pi", "themes"), { recursive: true }),
    mkdir(path.join(environment.project, "src", "nested"), { recursive: true }),
    mkdir(path.join(environment.agentDir, "prompts"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(projectPrompt, "---\ndescription: Expand a project request\n---\nProject template says $1."),
    writeFile(projectSkill, "---\nname: project-skill\ndescription: Apply project guidance\n---\nProject skill instructions."),
    writeFile(path.join(environment.project, ".pi", "skills", "malformed.md"), "---\nname: malformed\n---\nMissing description."),
    writeFile(path.join(environment.agentDir, "prompts", "global-template.md"), "---\ndescription: Global helper\n---\nGlobal helper."),
    writeFile(path.join(environment.project, "src", "nested", "context.txt"), "Project-only context"),
    writeFile(path.join(environment.root, "outside-secret.txt"), "outside"),
    writeFile(path.join(environment.project, ".pi", "extensions", "must-not-run.ts"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(extensionMarker)}, "ran");\nexport default function () {}`),
    writeFile(path.join(environment.project, ".pi", "themes", "terminal-only.json"), JSON.stringify({ name: "terminal-only", colors: {} })),
    writeFile(path.join(environment.agentDir, "keybindings.json"), JSON.stringify({ "app.model.select": "ctrl+m" })),
    writeFile(path.join(environment.agentDir, "models.json"), JSON.stringify({
      providers: {
        fixture: {
          baseUrl: provider.baseUrl,
          api: "openai-completions",
          apiKey: "fixture-key",
          models: [{ id: "fixture-model", name: "Fixture model", input: ["text", "image"], contextWindow: 32_000, maxTokens: 1_000 }],
        },
      },
    })),
    writeFile(path.join(environment.agentDir, "settings.json"), JSON.stringify({
      defaultProvider: "fixture",
      defaultModel: "fixture-model",
      enableSkillCommands: true,
    })),
  ]);
  await symlink(path.join(environment.root, "outside-secret.txt"), path.join(environment.project, "linked-secret.txt"));
  const app = await launch(environment.agentDir, false, { PILOT_TEST_PROJECT_DIR: environment.project });

  try {
    await app.window.getByRole("button", { name: "Add project" }).click();
    const access = app.window.getByRole("dialog", { name: "Project access" });
    await access.getByRole("button", { name: "Trust project resources", exact: true }).click();
    await access.getByRole("button", { name: "Allow agent execution" }).click();
    await app.window.getByRole("button", { name: "New Task" }).click();

    const composer = app.window.getByRole("form", { name: "Task composer" });
    const prompt = composer.getByRole("combobox", { name: "Prompt" });
    const diagnostics = composer.getByRole("region", { name: "Pi resource diagnostics" });
    await expect(diagnostics).toContainText(/description/i);
    const unsupported = composer.getByRole("region", { name: "Unsupported Pi resources" });
    await expect(unsupported).toContainText("1 extension not executed");
    await expect(unsupported).toContainText("1 TUI theme ignored");
    await expect(unsupported).toContainText("TUI keybindings ignored");
    await expect(unsupported).toContainText("must-not-run.ts");
    await expect(unsupported).toContainText("terminal-only.json");
    await expect(unsupported).toContainText("keybindings.json");
    expect(await readFile(extensionMarker, "utf8").catch(() => "")).toBe("");

    await prompt.fill("/project");
    const slashCompletion = composer.getByRole("listbox", { name: "Resource completion" });
    const projectTemplate = slashCompletion.getByRole("option", { name: /project-template/ });
    await expect(prompt).toHaveAttribute("aria-expanded", "true");
    await expect(prompt).toHaveAttribute("aria-activedescendant", await slashCompletion.locator('[aria-selected="true"]').getAttribute("id"));
    await expect(projectTemplate).toContainText("Project");
    await prompt.press("Enter");
    await expect(prompt).toHaveValue("/project-template ");
    await prompt.fill("/project-template widget");
    await composer.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => provider.requests.join("\n")).toContain("Project template says widget.");
    await expect(app.window.getByRole("region", { name: "Run timeline" }).getByRole("article").last()).toContainText("Settled");

    await prompt.fill("/skill:project");
    const skillCompletion = composer.getByRole("listbox", { name: "Resource completion" });
    await expect(skillCompletion.getByRole("option", { name: /skill:project-skill/ })).toContainText("Project");
    await prompt.press("Enter");
    await expect(prompt).toHaveValue("/skill:project-skill ");
    await prompt.fill("/skill:project-skill audit now");
    await composer.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => provider.requests.join("\n")).toContain("Project skill instructions.");
    await expect.poll(() => provider.requests.join("\n")).toContain("audit now");
    await expect(app.window.getByRole("region", { name: "Run timeline" }).getByRole("article").last()).toContainText("Settled");
    expect(await readFile(extensionMarker, "utf8").catch(() => "")).toBe("");

    await prompt.fill("@nstd");
    const fileCompletion = composer.getByRole("listbox", { name: "Resource completion" });
    await expect(fileCompletion.getByRole("option", { name: "src/nested/context.txt" })).toBeVisible();
    await expect(fileCompletion).not.toContainText("linked-secret.txt");
    await prompt.press("Enter");
    await expect(prompt).toHaveValue("@src/nested/context.txt ");

    const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const picker = composer.getByLabel("Choose images");
    await picker.setInputFiles({ name: "selected.png", mimeType: "", buffer: onePixelPng });
    await app.window.evaluate((base64) => {
      const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
      document.querySelector<HTMLTextAreaElement>('[aria-label="Prompt"]')!.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: transfer }));
    }, onePixelPng.toString("base64"));
    await app.window.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["preview"], "dropped.png", { type: "image/png" }));
      document.querySelector<HTMLFormElement>('[aria-label="Task composer"]')!.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: transfer }));
    });
    await expect(composer.getByText("Drop images to attach")).toBeVisible();
    await app.window.evaluate((base64) => {
      const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], "dropped.png", { type: "image/png" }));
      document.querySelector<HTMLFormElement>('[aria-label="Task composer"]')!.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
    }, onePixelPng.toString("base64"));
    const attachments = composer.getByRole("list", { name: "Image attachments" });
    await expect(attachments.getByRole("listitem")).toHaveCount(3);
    await expect(attachments).toContainText("selected.png");
    await expect(composer.getByRole("button", { name: "Attach images" })).toHaveAccessibleDescription("Paste, drop, or select PNG, JPEG, GIF, or WebP images up to 20 MB each");

    const requestsBeforeImages = provider.requests.length;
    await prompt.fill("Inspect the attached images");
    await composer.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => provider.requests.length).toBe(requestsBeforeImages + 1);
    await expect(app.window.getByRole("region", { name: "Run timeline" }).getByRole("article").last()).toContainText("Settled");
    expect(provider.requests.at(-1)).toContain("data:image/png;base64");
    await expect(attachments).toHaveCount(0);

    await picker.setInputFiles({ name: "task-a.png", mimeType: "image/png", buffer: onePixelPng });
    await expect(attachments.getByRole("listitem")).toHaveCount(1);
    await app.window.getByRole("button", { name: "New Task" }).click();
    await expect(attachments).toHaveCount(0);
  } finally {
    await close(app);
    await provider.close();
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("creates a managed Worktree Task from a committed ref", async () => {
  const environment = await fixture();
  const project = await realpath(environment.project);
  const provider = await deterministicProvider(environment.root);
  await mkdir(path.join(project, ".pi"), { recursive: true });
  await writeFile(path.join(environment.agentDir, "models.json"), JSON.stringify({
    providers: {
      fixture: {
        baseUrl: provider.baseUrl,
        api: "openai-completions",
        apiKey: "fixture-key",
        models: [
          { id: "committed-model", name: "Committed model", contextWindow: 32_000, maxTokens: 1_000 },
          { id: "local-model", name: "Local model", contextWindow: 32_000, maxTokens: 1_000 },
        ],
      },
    },
  }));
  await execute("git", ["init"], { cwd: project });
  await execute("git", ["config", "user.email", "pilot@example.test"], { cwd: project });
  await execute("git", ["config", "user.name", "PiLot Test"], { cwd: project });
  await Promise.all([
    writeFile(path.join(project, ".gitignore"), "ignored.txt\n"),
    writeFile(path.join(project, "tracked.txt"), "committed\n"),
    writeFile(path.join(project, ".pi", "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "committed-model" })),
  ]);
  await execute("git", ["add", "."], { cwd: project });
  await execute("git", ["commit", "-m", "fixture base"], { cwd: project });
  await execute("git", ["branch", "fixture-base"], { cwd: project });
  const baseCommit = (await execute("git", ["rev-parse", "HEAD"], { cwd: project })).stdout.trim();
  await Promise.all([
    writeFile(path.join(project, "tracked.txt"), "dirty local\n"),
    writeFile(path.join(project, "ignored.txt"), "local only\n"),
    writeFile(path.join(project, ".pi", "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "local-model" })),
  ]);
  const app = await launch(environment.agentDir, false, { PILOT_TEST_PROJECT_DIR: project });

  try {
    await app.window.getByRole("button", { name: "Add project" }).click();
    const access = app.window.getByRole("dialog", { name: "Project access" });
    await access.getByRole("button", { name: "Trust project resources", exact: true }).click();
    await access.getByRole("button", { name: "Allow agent execution" }).click();
    await app.window.getByRole("button", { name: "New Task" }).click();

    const create = app.window.getByRole("dialog", { name: "Create Task" });
    await expect(create.getByRole("radio", { name: "Local" })).toBeChecked();
    await expect(create.getByRole("radio", { name: "Worktree" })).toBeVisible();
    await create.getByRole("radio", { name: "Worktree" }).check();
    await expect(create).toContainText("Dirty, untracked, and ignored files in Local are excluded");
    await create.getByRole("combobox", { name: "Branch or commit" }).fill("fixture-base");
    await create.getByRole("textbox", { name: "Project setup command" }).fill("printf 'dependencies ready\\n' > setup.txt; printf 'setup streamed\\n'");
    await create.getByRole("button", { name: "Create Worktree Task" }).click();

    await expect(app.window.getByText("Worktree · fixture-base", { exact: true })).toBeVisible();
    const setup = app.window.getByRole("region", { name: "Worktree setup" });
    const composer = app.window.getByRole("form", { name: "Task composer" });
    await expect(composer.getByRole("button", { name: /Provider and model/ })).toContainText("Committed model");
    await expect(setup.getByRole("status", { name: "Setup status" })).toHaveText("Pending");
    await expect(composer.getByRole("button", { name: "Send" })).toBeDisabled();
    await setup.getByRole("button", { name: "Run setup" }).click();
    await expect(setup.getByRole("log", { name: "Setup output" })).toContainText("setup streamed");
    await expect(setup.getByRole("status", { name: "Setup status" })).toHaveText("Succeeded");
    await composer.getByRole("combobox", { name: "Prompt" }).fill("!printf 'worktree run\\n' > run.txt");
    await expect(composer.getByRole("button", { name: "Send" })).toBeEnabled();
    await composer.getByRole("button", { name: "Send" }).click();
    await expect(app.window.getByRole("region", { name: "Run timeline" }).getByRole("article").last()).toContainText("Settled");
    const task = await app.window.evaluate(async () => {
      const state = await (window as any).pilot.getProjects();
      return state.selected.tasks.find((candidate: any) => candidate.execution.kind === "worktree");
    });
    expect(task.execution.path).not.toBe(project);
    expect(await readFile(path.join(task.execution.path, "tracked.txt"), "utf8")).toBe("committed\n");
    expect(await readFile(path.join(task.execution.path, "setup.txt"), "utf8")).toBe("dependencies ready\n");
    expect(await readFile(path.join(task.execution.path, "run.txt"), "utf8")).toBe("worktree run\n");
    await expect(readFile(path.join(project, "run.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(task.execution.path, "ignored.txt"), "utf8")).rejects.toThrow();
    const metadata = (await readFile(task.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
      .filter((entry) => entry.customType === "pilot.task").at(-1);
    expect(metadata.data).toMatchObject({
      projectPath: project,
      execution: { kind: "worktree", path: task.execution.path, ref: "fixture-base" },
    });
    expect((await execute("git", ["worktree", "list", "--porcelain"], { cwd: project })).stdout).toContain(task.execution.path);
    const inspector = app.window.getByRole("complementary", { name: "Inspector" });
    await inspector.getByRole("tab", { name: /History/ }).click();
    await inspector.getByRole("button", { name: "Clone active path" }).click();
    const cloneDialog = app.window.getByRole("dialog", { name: "Create Task" });
    await expect(cloneDialog.getByRole("note")).toContainText("uncommitted files are never transferred");
    await cloneDialog.getByRole("radio", { name: "Worktree" }).check();
    await cloneDialog.getByRole("combobox", { name: "Branch or commit" }).fill(baseCommit);
    await cloneDialog.getByRole("button", { name: "Create Worktree Task" }).click();
    await expect(cloneDialog).toHaveCount(0);
    await expect.poll(() => app.window.evaluate(async (sourcePath) => Boolean((await (window as any).pilot.getProjects()).selected.tasks.find((candidate: any) => candidate.path !== sourcePath && candidate.execution.kind === "worktree")), task.path)).toBe(true);
    const cloneTask = await app.window.evaluate(async (sourcePath) => (await (window as any).pilot.getProjects()).selected.tasks.find((candidate: any) => candidate.path !== sourcePath && candidate.execution.kind === "worktree"), task.path);
    expect(cloneTask.execution.path).not.toBe(task.execution.path);
    expect((await execute("git", ["worktree", "list", "--porcelain"], { cwd: project })).stdout).toContain(cloneTask.execution.path);
    const cloneSetup = app.window.getByRole("region", { name: "Worktree setup" });
    await cloneSetup.getByRole("button", { name: "Run setup" }).click();
    await expect(cloneSetup.getByRole("status", { name: "Setup status" })).toHaveText("Succeeded");
    const cloneComposer = app.window.getByRole("form", { name: "Task composer" });
    await cloneComposer.getByRole("combobox", { name: "Prompt" }).fill("!sleep 5");
    await cloneComposer.getByRole("button", { name: "Send" }).click();
    await expect(app.window.getByRole("region", { name: "Run timeline" }).getByRole("region", { name: "Command: sleep 5" })).toContainText("Running");
    await app.window.evaluate(async ({ projectPath, taskPath }) => {
      await (window as any).pilot.executeCommand(projectPath, taskPath, "printf 'isolated\\n' > concurrent.txt", false);
    }, { projectPath: project, taskPath: task.path });
    expect(await readFile(path.join(task.execution.path, "concurrent.txt"), "utf8")).toBe("isolated\n");
    await cloneComposer.getByRole("button", { name: "Stop Run" }).click();
    await expect(app.window.getByRole("region", { name: "Run timeline" })).toContainText("Aborted");

    await app.window.getByRole("button", { name: "New Task" }).click();
    const failedCreate = app.window.getByRole("dialog", { name: "Create Task" });
    await failedCreate.getByRole("radio", { name: "Worktree" }).check();
    await expect(failedCreate.getByRole("textbox", { name: "Project setup command" })).toHaveValue(/dependencies ready/);
    await failedCreate.getByRole("combobox", { name: "Branch or commit" }).fill(baseCommit);
    await failedCreate.getByRole("textbox", { name: "Project setup command" }).fill("printf 'setup failed\\n'; exit 7");
    await failedCreate.getByRole("button", { name: "Create Worktree Task" }).click();
    const failedSetup = app.window.getByRole("region", { name: "Worktree setup" });
    await failedSetup.getByRole("button", { name: "Run setup" }).click();
    await expect(failedSetup.getByRole("log", { name: "Setup output" })).toContainText("setup failed");
    await expect(failedSetup.getByRole("status", { name: "Setup status" })).toHaveText("Failed");
    const blocked = await app.window.evaluate(async () => {
      const pilot = (window as any).pilot;
      const projectState = (await pilot.getProjects()).selected;
      const worktree = projectState.tasks.find((candidate: any) => candidate.setup?.command.includes("setup failed"));
      try {
        await pilot.submitPrompt(projectState.path, worktree.path, "must stay blocked");
        return "";
      } catch (reason) {
        return reason instanceof Error ? reason.message : String(reason);
      }
    });
    expect(blocked).toContain("Finish Worktree setup");
    await failedSetup.getByRole("button", { name: "Continue without setup" }).click();
    await expect(failedSetup.getByRole("status", { name: "Setup status" })).toHaveText("Bypassed");

    await app.window.getByRole("button", { name: "New Task" }).click();
    const abortedCreate = app.window.getByRole("dialog", { name: "Create Task" });
    await abortedCreate.getByRole("radio", { name: "Worktree" }).check();
    await abortedCreate.getByRole("combobox", { name: "Branch or commit" }).fill("fixture-base");
    await abortedCreate.getByRole("textbox", { name: "Project setup command" }).fill("printf 'setup started\\n'; sleep 10; touch setup-finished");
    await abortedCreate.getByRole("button", { name: "Create Worktree Task" }).click();
    const abortedSetup = app.window.getByRole("region", { name: "Worktree setup" });
    await abortedSetup.getByRole("button", { name: "Run setup" }).click();
    await expect(abortedSetup.getByRole("log", { name: "Setup output" })).toContainText("setup started");
    await abortedSetup.getByRole("button", { name: "Stop setup" }).click();
    await expect(abortedSetup.getByRole("status", { name: "Setup status" })).toHaveText("Aborted");
    const abortedTask = await app.window.evaluate(async () => {
      const tasks = (await (window as any).pilot.getProjects()).selected.tasks;
      return tasks.find((candidate: any) => candidate.setup?.command.includes("setup started"));
    });
    await expect(readFile(path.join(abortedTask.execution.path, "setup-finished"), "utf8")).rejects.toThrow();
    const concurrentSetup = await app.window.evaluate(async ({ projectPath, taskPath }) => {
      const pilot = (window as any).pilot;
      const first = pilot.runTaskSetup(projectPath, taskPath);
      while ((await pilot.getTaskSetup(projectPath, taskPath))?.status !== "running") {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      let conflict = "";
      try { await pilot.runTaskSetup(projectPath, taskPath); }
      catch (reason) { conflict = reason instanceof Error ? reason.message : String(reason); }
      let branchConflict = "";
      try { await pilot.createTaskWorktreeBranch(projectPath, taskPath, "must-not-branch"); }
      catch (reason) { branchConflict = reason instanceof Error ? reason.message : String(reason); }
      let archiveConflict = "";
      try { await pilot.setTaskArchived(projectPath, taskPath, true); }
      catch (reason) { archiveConflict = reason instanceof Error ? reason.message : String(reason); }
      await pilot.abortTaskSetup(taskPath);
      await first;
      return { conflict, branchConflict, archiveConflict, status: (await pilot.getTaskSetup(projectPath, taskPath))?.status };
    }, { projectPath: project, taskPath: abortedTask.path });
    expect(concurrentSetup).toEqual({
      conflict: expect.stringContaining("already running"),
      branchConflict: expect.stringContaining("running in this Worktree"),
      archiveConflict: expect.stringContaining("running in this Worktree"),
      status: "aborted",
    });
  } finally {
    await close(app);
    await provider.close();
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("finishes and removes managed Worktree Tasks explicitly", async () => {
  test.setTimeout(90_000);
  const environment = await fixture();
  const repository = await realpath(environment.project);
  const projectDirectory = path.join(repository, "packages", "app");
  await mkdir(projectDirectory, { recursive: true });
  const project = await realpath(projectDirectory);
  const tools = path.join(environment.root, "tools");
  const editorLog = path.join(environment.root, "editor.log");
  const terminalLog = path.join(environment.root, "terminal.log");
  const removalPause = path.join(environment.root, "pause-worktree-removal");
  const editor = path.join(tools, process.platform === "win32" ? "code.cmd" : "code");
  const terminal = path.join(tools, process.platform === "win32" ? "test-terminal.cmd" : "test-terminal");
  await mkdir(tools, { recursive: true });
  await writeFile(editor, process.platform === "win32"
    ? `@echo off\r\n>"%PILOT_EDITOR_LOG%" echo %~1\r\n`
    : `#!/bin/sh\nprintf '%s\\n' "$1" > "$PILOT_EDITOR_LOG"\n`);
  await writeFile(terminal, process.platform === "win32"
    ? `@echo off\r\n>"%PILOT_TERMINAL_LOG%" echo %CD%\r\n`
    : `#!/bin/sh\nprintf '%s\\n' "$PWD" > "$PILOT_TERMINAL_LOG"\n`);
  if (process.platform !== "win32") await Promise.all([chmod(editor, 0o755), chmod(terminal, 0o755)]);
  await execute("git", ["init"], { cwd: repository });
  await execute("git", ["config", "user.email", "pilot@example.test"], { cwd: repository });
  await execute("git", ["config", "user.name", "PiLot Test"], { cwd: repository });
  const submoduleSource = path.join(environment.root, "submodule-source");
  await mkdir(submoduleSource);
  await execute("git", ["init"], { cwd: submoduleSource });
  await execute("git", ["config", "user.email", "pilot@example.test"], { cwd: submoduleSource });
  await execute("git", ["config", "user.name", "PiLot Test"], { cwd: submoduleSource });
  await writeFile(path.join(submoduleSource, "submodule.txt"), "clean submodule\n");
  await execute("git", ["add", "."], { cwd: submoduleSource });
  await execute("git", ["commit", "-m", "submodule fixture"], { cwd: submoduleSource });
  await execute("git", ["-c", "protocol.file.allow=always", "submodule", "add", submoduleSource, "dependency"], { cwd: repository });
  await Promise.all([
    writeFile(path.join(project, "tracked.txt"), "committed\n"),
    writeFile(path.join(project, "hidden.txt"), "committed hidden\n"),
    writeFile(path.join(project, "literal-*.txt"), "committed literal\n"),
    writeFile(path.join(project, "literal-safe.txt"), "committed sibling\n"),
    writeFile(path.join(project, "mode-only.sh"), "#!/bin/sh\necho mode\n"),
    writeFile(path.join(project, "skip-deleted.txt"), "committed skip-worktree file\n"),
  ]);
  await execute("git", ["add", "."], { cwd: repository });
  await execute("git", ["commit", "-m", "fixture base"], { cwd: repository });
  const baseCommit = (await execute("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
  const toolPath = `${tools}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ""}`;
  const appEnvironment = {
    PILOT_TEST_PROJECT_DIR: project,
    PILOT_TEST_TERMINAL_COMMAND: terminal,
    PILOT_TEST_TERMINAL_ID: "wezterm",
    PILOT_TEST_WORKTREE_REMOVAL_PAUSE_FILE: removalPause,
    PILOT_EDITOR_LOG: editorLog,
    PILOT_TERMINAL_LOG: terminalLog,
    PATH: toolPath,
    ...(process.platform === "win32" ? { Path: toolPath } : {}),
  };
  let app = await launch(environment.agentDir, false, appEnvironment);

  const createWorktree = async () => {
    await app.window.getByRole("button", { name: "New Task" }).click();
    const create = app.window.getByRole("dialog", { name: "Create Task" });
    await create.getByRole("radio", { name: "Worktree" }).check();
    await create.getByRole("combobox", { name: "Branch or commit" }).fill(baseCommit);
    await create.getByRole("button", { name: "Create Worktree Task" }).click();
    await expect(create).toHaveCount(0);
    await expect.poll(() => app.window.evaluate(async () => {
      const state = await (window as any).pilot.getProjects();
      return Boolean(state.selected.tasks.find((task: any) => task.lifecycle === "active" && task.execution.kind === "worktree"));
    })).toBe(true);
    return app.window.evaluate(async () => {
      const state = await (window as any).pilot.getProjects();
      return state.selected.tasks.find((task: any) => task.lifecycle === "active" && task.execution.kind === "worktree");
    });
  };

  try {
    await app.window.getByRole("button", { name: "Settings" }).click();
    const settings = app.window.getByRole("main", { name: "Settings" });
    await settings.getByRole("radio", { name: /WezTerm/ }).check();
    await expect(settings.getByRole("radio", { name: /WezTerm/ })).toBeChecked();
    await app.window.getByRole("button", { name: "Back to command center" }).click();
    await app.window.getByRole("button", { name: "Add project" }).click();
    await app.window.getByRole("dialog", { name: "Project access" }).getByRole("button", { name: "Allow agent execution" }).click();
    const cleanTask = await createWorktree();
    const inspector = app.window.getByRole("complementary", { name: "Inspector" });
    await inspector.getByRole("tab", { name: /Changes/ }).click();
    const changes = inspector.getByRole("tabpanel", { name: /Changes/ });
    const worktree = changes.getByRole("region", { name: "Worktree actions" });
    await expect(worktree.getByRole("status", { name: "Branch status" })).toContainText("Detached");
    await worktree.getByRole("button", { name: "Create branch" }).click();
    await worktree.getByRole("textbox", { name: "New branch name" }).fill("safe-finish");
    await worktree.getByRole("button", { name: "Create branch" }).click();
    await expect(worktree.getByRole("status", { name: "Branch status" })).toHaveText("On branch safe-finish");
    expect((await execute("git", ["symbolic-ref", "--short", "HEAD"], { cwd: cleanTask.execution.path })).stdout.trim()).toBe("safe-finish");

    await changes.getByRole("button", { name: "Choose application for execution location" }).click();
    await changes.getByRole("menu", { name: "Applications" }).getByRole("menuitemradio", { name: "VS Code" }).click();
    await expect.poll(() => readFile(editorLog, "utf8").then((value) => value.trim(), () => "")).toBe(cleanTask.execution.path);
    await worktree.getByRole("button", { name: "Open in terminal" }).click();
    await expect.poll(() => readFile(terminalLog, "utf8").then((value) => value.trim(), () => "")).toBe(cleanTask.execution.path);

    await writeFile(path.join(cleanTask.execution.path, "kept-on-branch.txt"), "kept\n");
    await execute("git", ["add", "."], { cwd: cleanTask.execution.path });
    await execute("git", ["commit", "-m", "keep worktree result"], { cwd: cleanTask.execution.path });
    await expect(changes).toContainText("No current changes");

    await app.window.getByRole("button", { name: "Command Palette" }).click();
    const palette = app.window.getByRole("dialog", { name: "Command Palette" });
    await palette.getByRole("combobox", { name: "Search actions" }).fill("Archive Task");
    await palette.getByRole("option", { name: /Archive Task/ }).click();
    await expect(app.window.getByRole("region", { name: "Archived tasks" })).toContainText("Worktree retained");
    expect((await execute("git", ["worktree", "list", "--porcelain"], { cwd: repository })).stdout).toContain(cleanTask.execution.worktreePath);

    const removableTask = await createWorktree();
    await writeFile(path.join(removableTask.execution.path, "anchored.txt"), "anchored\n");
    await execute("git", ["add", "."], { cwd: removableTask.execution.path });
    await execute("git", ["commit", "-m", "detached result"], { cwd: removableTask.execution.path });
    await execute("git", ["-c", "protocol.file.allow=always", "submodule", "update", "--init"], { cwd: removableTask.execution.worktreePath });
    await inspector.getByRole("tab", { name: /Changes/ }).click();
    const cleanChanges = inspector.getByRole("tabpanel", { name: /Changes/ });
    await cleanChanges.getByRole("button", { name: "Remove worktree" }).click();
    let cleanRemoval = app.window.getByRole("dialog", { name: "Remove managed worktree" });
    await expect(cleanRemoval).toContainText("Task history remains, but this Task cannot run or be restored after removal");
    await cleanRemoval.getByRole("button", { name: "Remove worktree" }).click();
    await expect(cleanRemoval.getByRole("alert")).toContainText("Create a branch before removing this Worktree");
    await cleanRemoval.getByRole("button", { name: "Cancel" }).click();
    const removableActions = cleanChanges.getByRole("region", { name: "Worktree actions" });
    await removableActions.getByRole("button", { name: "Create branch" }).click();
    await removableActions.getByRole("textbox", { name: "New branch name" }).fill("anchored-cleanup");
    await removableActions.getByRole("button", { name: "Create branch" }).click();
    await expect(removableActions.getByRole("status", { name: "Branch status" })).toHaveText("On branch anchored-cleanup");
    await removableActions.getByRole("button", { name: "Remove worktree" }).click();
    cleanRemoval = app.window.getByRole("dialog", { name: "Remove managed worktree" });
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      await chmod(removableTask.path, 0o444);
      await cleanRemoval.getByRole("button", { name: "Remove worktree" }).click();
      await expect(cleanRemoval.getByRole("alert")).toContainText(/EACCES|permission denied/i);
      expect((await execute("git", ["worktree", "list", "--porcelain"], { cwd: repository })).stdout).toContain(removableTask.execution.worktreePath);
      const unchanged = await app.window.evaluate(async (taskPath) => (await (window as any).pilot.getProjects()).selected.tasks.find((task: any) => task.path === taskPath), removableTask.path);
      expect(unchanged).toMatchObject({ lifecycle: "active", execution: { kind: "worktree" } });
      expect(unchanged.execution.removedAt).toBeUndefined();
      await chmod(removableTask.path, 0o644);
    }
    await execute("git", ["worktree", "lock", removableTask.execution.worktreePath], { cwd: repository });
    await cleanRemoval.getByRole("button", { name: "Remove worktree" }).click();
    await expect(cleanRemoval.getByRole("alert")).toContainText(/locked/i);
    await expect(cleanRemoval.getByRole("button", { name: "Remove worktree" })).toBeFocused();
    const rolledBack = await app.window.evaluate(async (taskPath) => (await (window as any).pilot.getProjects()).selected.tasks.find((task: any) => task.path === taskPath), removableTask.path);
    expect(rolledBack).toMatchObject({ lifecycle: "active", execution: { kind: "worktree" } });
    expect(rolledBack.execution.removedAt).toBeUndefined();
    await execute("git", ["worktree", "unlock", removableTask.execution.worktreePath], { cwd: repository });
    await cleanRemoval.getByRole("button", { name: "Remove worktree" }).click();
    const removedTask = app.window.getByRole("region", { name: "Archived tasks" }).locator("li").filter({ hasText: "Worktree removed" });
    await expect(removedTask).toBeVisible();
    await expect(removedTask.getByRole("button", { name: "Restore" })).toHaveCount(0);
    await removedTask.getByRole("button", { name: "View history" }).click();
    await expect(app.window.getByRole("heading", { name: "Task history is still available" })).toBeVisible();
    const removedInspector = app.window.getByRole("complementary", { name: "Inspector" });
    await expect(removedInspector.getByRole("tab", { name: /History/ })).toBeFocused();
    const removedHistory = removedInspector.getByRole("tabpanel", { name: /History/ });
    await expect(removedHistory).toContainText("Read only");
    await expect(removedHistory.getByRole("button", { name: "Clone active path" })).toHaveCount(0);
    const restoreError = await app.window.evaluate(async ({ projectPath, taskPath }) => {
      try {
        await (window as any).pilot.setTaskArchived(projectPath, taskPath, false);
        return "";
      } catch (reason) {
        return reason instanceof Error ? reason.message : String(reason);
      }
    }, { projectPath: project, taskPath: removableTask.path });
    expect(restoreError).toContain("cannot be restored");
    await expect(readFile(path.join(removableTask.execution.path, "tracked.txt"), "utf8")).rejects.toThrow();
    expect((await execute("git", ["show", "safe-finish:packages/app/kept-on-branch.txt"], { cwd: repository })).stdout).toBe("kept\n");
    expect((await execute("git", ["show", "anchored-cleanup:packages/app/anchored.txt"], { cwd: repository })).stdout).toBe("anchored\n");
    const listedWorktrees = (await execute("git", ["worktree", "list", "--porcelain"], { cwd: repository })).stdout;
    expect(listedWorktrees).toContain(cleanTask.execution.worktreePath);
    expect(listedWorktrees).not.toContain(removableTask.execution.worktreePath);
    await expect(readFile(path.join(project, "kept-on-branch.txt"), "utf8")).rejects.toThrow();

    const dirtyTask = await createWorktree();
    await inspector.getByRole("tab", { name: /Changes/ }).click();
    const dirtyChanges = inspector.getByRole("tabpanel", { name: /Changes/ });
    await execute("git", ["update-index", "--assume-unchanged", "packages/app/hidden.txt"], { cwd: dirtyTask.execution.worktreePath });
    const discardCount = process.platform === "win32" ? 7 : 8;
    if (process.platform !== "win32") {
      await execute("git", ["update-index", "--assume-unchanged", "packages/app/mode-only.sh"], { cwd: dirtyTask.execution.worktreePath });
      await chmod(path.join(dirtyTask.execution.path, "mode-only.sh"), 0o755);
    }
    await execute("git", ["update-index", "--skip-worktree", "packages/app/skip-deleted.txt"], { cwd: dirtyTask.execution.worktreePath });
    await rm(path.join(dirtyTask.execution.path, "skip-deleted.txt"));
    const nestedRepository = path.join(dirtyTask.execution.worktreePath, "nested-repository");
    await mkdir(nestedRepository);
    await execute("git", ["init"], { cwd: nestedRepository });
    await execute("git", ["config", "user.email", "pilot@example.test"], { cwd: nestedRepository });
    await execute("git", ["config", "user.name", "PiLot Test"], { cwd: nestedRepository });
    await writeFile(path.join(nestedRepository, "nested.txt"), "reviewed nested content\n");
    await execute("git", ["add", "."], { cwd: nestedRepository });
    await execute("git", ["commit", "-m", "nested fixture"], { cwd: nestedRepository });
    await Promise.all([
      writeFile(path.join(dirtyTask.execution.path, "tracked.txt"), "discard me\n"),
      writeFile(path.join(dirtyTask.execution.path, "hidden.txt"), "hidden from ordinary Git status\n"),
      writeFile(path.join(dirtyTask.execution.path, "literal-*.txt"), "literal pathspec\n"),
      writeFile(path.join(dirtyTask.execution.path, "scratch.txt"), "discard me too\n"),
      writeFile(path.join(dirtyTask.execution.worktreePath, "root-only.txt"), "outside the admitted Project\n"),
    ]);
    const dirtyFiles = dirtyChanges.getByRole("list", { name: "Changed files" });
    await expect(dirtyFiles.getByRole("button", { name: /Modified tracked\.txt/ })).toBeVisible();
    await expect(dirtyFiles.getByRole("button", { name: /Untracked scratch\.txt/ })).toBeVisible();
    await dirtyChanges.getByRole("button", { name: "Remove worktree" }).click();
    const dirtyRemoval = app.window.getByRole("dialog", { name: "Remove managed worktree" });
    await expect(dirtyRemoval.getByRole("list", { name: "Files that will be discarded" })).toContainText("tracked.txt");
    await expect(dirtyRemoval.getByRole("list", { name: "Files that will be discarded" })).toContainText("scratch.txt");
    await expect(dirtyRemoval.getByRole("list", { name: "Files that will be discarded" })).toContainText("root-only.txt");
    await expect(dirtyRemoval.getByRole("list", { name: "Files that will be discarded" })).toContainText("hidden.txt");
    await expect(dirtyRemoval.getByRole("list", { name: "Files that will be discarded" })).toContainText("literal-*.txt");
    await expect(dirtyRemoval.getByRole("list", { name: "Files that will be discarded" })).toContainText("nested-repository");
    if (process.platform !== "win32") await expect(dirtyRemoval.getByRole("list", { name: "Files that will be discarded" })).toContainText("mode-only.sh");
    await expect(dirtyRemoval.getByRole("list", { name: "Files that will be discarded" })).toContainText("skip-deleted.txt");
    const blocked = await app.window.evaluate(async ({ projectPath, taskPath }) => {
      try {
        const worktree = await (window as any).pilot.getTaskWorktree(projectPath, taskPath);
        await (window as any).pilot.removeTaskWorktree(projectPath, taskPath, false, worktree.files);
        return "";
      } catch (reason) {
        return reason instanceof Error ? reason.message : String(reason);
      }
    }, { projectPath: project, taskPath: dirtyTask.path });
    expect(blocked).toContain("uncommitted changes");
    await writeFile(path.join(dirtyTask.execution.path, "tracked.txt"), "changed after review\n");
    await dirtyRemoval.getByRole("button", { name: `Discard ${discardCount} files and remove worktree` }).click();
    await expect(dirtyRemoval.getByRole("alert")).toContainText("Worktree changes changed");
    expect(await readFile(path.join(dirtyTask.execution.path, "tracked.txt"), "utf8")).toBe("changed after review\n");
    await dirtyRemoval.getByRole("button", { name: "Cancel" }).click();
    await dirtyChanges.getByRole("button", { name: "Remove worktree" }).click();
    const nestedDirtyRemoval = app.window.getByRole("dialog", { name: "Remove managed worktree" });
    await expect(nestedDirtyRemoval).toBeVisible();
    await writeFile(path.join(nestedRepository, "nested.txt"), "changed after directory review\n");
    await nestedDirtyRemoval.getByRole("button", { name: `Discard ${discardCount} files and remove worktree` }).click();
    await expect(nestedDirtyRemoval.getByRole("alert")).toContainText("Worktree changes changed");
    expect(await readFile(path.join(nestedRepository, "nested.txt"), "utf8")).toBe("changed after directory review\n");
    await nestedDirtyRemoval.getByRole("button", { name: "Cancel" }).click();
    await dirtyChanges.getByRole("button", { name: "Remove worktree" }).click();
    const refreshedDirtyRemoval = app.window.getByRole("dialog", { name: "Remove managed worktree" });
    await refreshedDirtyRemoval.getByRole("button", { name: `Discard ${discardCount} files and remove worktree` }).focus();
    await app.window.keyboard.press("Enter");
    await expect(refreshedDirtyRemoval).toHaveCount(0);
    await expect(readFile(path.join(dirtyTask.execution.path, "scratch.txt"), "utf8")).rejects.toThrow();
    expect(await readFile(path.join(project, "tracked.txt"), "utf8")).toBe("committed\n");
    expect(await readFile(path.join(project, "hidden.txt"), "utf8")).toBe("committed hidden\n");
    expect(await readFile(path.join(project, "literal-safe.txt"), "utf8")).toBe("committed sibling\n");
    expect((await execute("git", ["worktree", "list", "--porcelain"], { cwd: repository })).stdout).not.toContain(dirtyTask.execution.worktreePath);

    const interruptedRemovalTask = await createWorktree();
    await writeFile(removalPause, "10000");
    await app.window.evaluate(({ projectPath, taskPath }) => {
      void (window as any).pilot.removeTaskWorktree(projectPath, taskPath, false, []).catch(() => undefined);
    }, { projectPath: project, taskPath: interruptedRemovalTask.path });
    await expect.poll(async () => {
      const entries = (await readFile(interruptedRemovalTask.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      return Boolean(entries.filter((entry) => entry.customType === "pilot.task").at(-1)?.data.execution?.removedAt);
    }).toBe(true);
    const pendingJournal = path.join(environment.agentDir, "pilot-user-data", "pending-worktree-removals", (await readdir(path.join(environment.agentDir, "pilot-user-data", "pending-worktree-removals"))).find((name) => name.endsWith(".json"))!);
    expect(JSON.parse(await readFile(pendingJournal, "utf8")).operationStartedAt).toBeUndefined();
    await terminate(app);
    await rm(removalPause, { force: true });
    app = await launch(environment.agentDir, false, appEnvironment);
    await expect.poll(async () => {
      const state = await app.window.evaluate(() => (window as any).pilot.getProjects());
      return state.selected?.tasks.find((task: any) => task.path === interruptedRemovalTask.path);
    }).toMatchObject({ lifecycle: "active", execution: { kind: "worktree" } });
    const recoveredTask = await app.window.evaluate(async (taskPath) => (await (window as any).pilot.getProjects()).selected.tasks.find((task: any) => task.path === taskPath), interruptedRemovalTask.path);
    expect(recoveredTask.execution.removedAt).toBeUndefined();
    expect((await execute("git", ["worktree", "list", "--porcelain"], { cwd: repository })).stdout).toContain(interruptedRemovalTask.execution.worktreePath);
    expect((await readdir(path.join(environment.agentDir, "pilot-user-data", "pending-worktree-removals")).catch(() => [])).filter((name) => name.endsWith(".json"))).toEqual([]);
  } finally {
    await close(app);
    await rm(environment.root, { recursive: true, force: true });
  }
});

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
    await expect(composer).toBeVisible({ timeout: 10_000 });
    await expect(app.window.getByRole("dialog", { name: "Create Task" })).toHaveCount(0);

    const modelControl = composer.getByRole("button", { name: /Provider and model/ });
    await expect(modelControl).toBeVisible();
    await modelControl.focus();
    await expect(modelControl).toBeFocused();
    await composer.getByRole("combobox", { name: "Prompt" }).fill("Reply with a deterministic greeting");
    const send = composer.getByRole("button", { name: "Send" });
    await expect(send).toHaveAttribute("title", "Send");
    await expect.poll(() => composer.locator(".composer-controls button:visible").evaluateAll((buttons) => buttons.map((button) => getComputedStyle(button).height))).toEqual(["32px", "32px", "32px", "32px"]);
    await expect(send.locator("svg")).toBeVisible();
    await send.click();
    const run = app.window.getByRole("region", { name: "Run timeline" });
    await expect(run).toContainText("Streaming ");
    await expect(run).toContainText("Running");
    await expect(run).toContainText("Streaming from PiLot.");
    await expect(run).toContainText("Settled");
    await expect(composer.getByRole("button", { name: "Send" })).toBeVisible();

    const directory = sessionDirectory(environment.agentDir, project);
    const firstFile = path.join(directory, (await readdir(directory)).find((file) => file.endsWith(".jsonl"))!);
    const firstEntries = (await readFile(firstFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(firstEntries[0]).toMatchObject({ type: "session", version: 3, cwd: project });
    expect(firstEntries.filter((entry) => entry.type === "message").map((entry) => entry.message.role)).toEqual(["user", "assistant"]);
    expect(firstEntries.filter((entry) => entry.customType === "pilot.run").at(-1)?.data.outcome).toBe("settled");
    expect(firstEntries.filter((entry) => entry.type === "custom_message")).toHaveLength(0);
    const context = SessionManager.open(firstFile).buildSessionContext();
    expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(context)).not.toContain("pilot.run");
    expect(JSON.stringify(context)).not.toContain("pilot.task");

    await app.window.getByRole("button", { name: "New Task" }).click();
    const abortComposer = app.window.getByRole("form", { name: "Task composer" });
    await abortComposer.getByRole("combobox", { name: "Prompt" }).fill("run abort tool");
    await abortComposer.getByRole("button", { name: "Send" }).click();
    const abortRun = app.window.getByRole("region", { name: "Run timeline" });
    await expect(abortRun.locator('details[aria-label="bash tool, running"]')).toBeVisible();
    const localConflict = await app.window.evaluate(async ({ projectPath, taskPath }) => {
      try {
        await (window as any).pilot.submitPrompt(projectPath, taskPath, "must serialize");
        return "";
      } catch (reason) {
        return reason instanceof Error ? reason.message : String(reason);
      }
    }, { projectPath: project, taskPath: firstFile });
    expect(localConflict).toContain("Another Local Task is already running in this Project");
    const stopToolRun = abortComposer.getByRole("button", { name: "Stop Run" });
    await expect(stopToolRun).toHaveAttribute("title", "Stop Run");
    await expect(stopToolRun.locator("svg")).toBeVisible();
    await stopToolRun.click();
    await expect(abortRun).toContainText("Aborted");
    await expect(abortRun.getByRole("button", { name: /Abort/ })).toHaveCount(0);
    await expect.poll(() => readFile(provider.started, "utf8").catch(() => "")).toBe("started");
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(await readFile(provider.finished, "utf8").catch(() => "")).toBe("");

    await app.window.getByRole("button", { name: "New Task" }).click();
    const commandComposer = app.window.getByRole("form", { name: "Task composer" });
    await commandComposer.getByRole("combobox", { name: "Prompt" }).fill("!(sleep 1; printf leaked > abort-descendant.txt) & wait");
    await commandComposer.getByRole("button", { name: "Send" }).click();
    const commandRun = app.window.getByRole("region", { name: "Run timeline" });
    await expect(commandRun.getByRole("region", { name: /Command:/ })).toContainText("Running");
    await commandComposer.getByRole("button", { name: "Stop Run" }).click();
    await expect(commandRun).toContainText("Aborted");
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    expect(await readFile(path.join(project, "abort-descendant.txt"), "utf8").catch(() => "")).toBe("");

    await app.window.getByRole("button", { name: "New Task" }).click();
    const modelComposer = app.window.getByRole("form", { name: "Task composer" });
    await modelComposer.getByRole("combobox", { name: "Prompt" }).fill("abort model");
    await modelComposer.getByRole("button", { name: "Send" }).click();
    const modelRun = app.window.getByRole("region", { name: "Run timeline" });
    await expect(modelRun).toContainText("Still streaming");
    await modelComposer.getByRole("button", { name: "Stop Run" }).click();
    await expect(modelRun).toContainText("Aborted");
    await expect.poll(() => readFile(provider.modelStopped, "utf8").catch(() => "")).toBe("stopped");

    const files = await readdir(directory);
    expect(files.filter((file) => file.endsWith(".jsonl"))).toHaveLength(4);
    const outcomes = await Promise.all(files.filter((file) => file.endsWith(".jsonl")).map(async (file) =>
      (await readFile(path.join(directory, file), "utf8")).trim().split("\n").map((line) => JSON.parse(line))
        .filter((entry) => entry.customType === "pilot.run").at(-1)?.data.outcome));
    expect(outcomes.sort()).toEqual(["aborted", "aborted", "aborted", "settled"]);
  } finally {
    await close(app);
    await provider.close();
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("orchestrates queued Runs across Projects and Worktrees", async () => {
  test.setTimeout(90_000);
  const environment = await fixture();
  const projectA = await realpath(environment.project);
  const projectB = path.join(environment.root, "second-project");
  await mkdir(projectB, { recursive: true });
  const canonicalProjectB = await realpath(projectB);
  for (const project of [projectA, canonicalProjectB]) {
    await execute("git", ["init"], { cwd: project });
    await execute("git", ["config", "user.email", "pilot@example.test"], { cwd: project });
    await execute("git", ["config", "user.name", "PiLot Test"], { cwd: project });
    await writeFile(path.join(project, "README.md"), `# ${path.basename(project)}\n`);
    await execute("git", ["add", "."], { cwd: project });
    await execute("git", ["commit", "-m", "fixture"], { cwd: project });
  }

  const timestamp = "2026-01-02T00:00:00.000Z";
  const attentionTask = async (name: string, title: string, outcome: "failed" | "running") => writeSession(environment.agentDir, projectA, name, [
    { type: "session", version: 3, id: name, timestamp, cwd: projectA },
    { type: "custom", customType: "pilot.task", id: `${name}-task`, parentId: null, timestamp, data: { version: 1, title, lifecycle: "active", projectPath: projectA, execution: { kind: "local", path: projectA } } },
    { type: "custom", customType: "pilot.run", id: `${name}-start`, parentId: `${name}-task`, timestamp, data: { version: 1, runId: `${name}-run`, inputKind: "prompt", input: title, outcome: "running" } },
    ...(outcome === "failed" ? [{ type: "custom", customType: "pilot.run", id: `${name}-finish`, parentId: `${name}-start`, timestamp, data: { version: 1, runId: `${name}-run`, outcome: "failed", error: "Fixture failure" } }] : []),
  ]);
  await attentionTask("failed-attention", "Failed release repair", "failed");
  await attentionTask("interrupted-attention", "Interrupted migration", "running");
  await writeSession(environment.agentDir, projectA, "abandoned-failure", [
    { type: "session", version: 3, id: "abandoned-failure", timestamp, cwd: projectA },
    { type: "custom", customType: "pilot.task", id: "abandoned-task", parentId: null, timestamp, data: { version: 1, title: "Healthy active branch", lifecycle: "active", projectPath: projectA, execution: { kind: "local", path: projectA } } },
    { type: "custom", customType: "pilot.run", id: "abandoned-start", parentId: "abandoned-task", timestamp, data: { version: 1, runId: "abandoned-run", inputKind: "prompt", input: "Old branch", outcome: "running" } },
    { type: "custom", customType: "pilot.run", id: "abandoned-finish", parentId: "abandoned-start", timestamp, data: { version: 1, runId: "abandoned-run", outcome: "failed", error: "Abandoned failure" } },
    { type: "custom", customType: "pilot.run", id: "healthy-start", parentId: "abandoned-task", timestamp, data: { version: 1, runId: "healthy-run", inputKind: "prompt", input: "Current branch", outcome: "running" } },
    { type: "custom", customType: "pilot.run", id: "healthy-finish", parentId: "healthy-start", timestamp, data: { version: 1, runId: "healthy-run", outcome: "settled" } },
  ]);

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
  await writeFile(path.join(environment.agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture-model" }));
  const userData = path.join(environment.agentDir, "pilot-user-data");
  await mkdir(userData, { recursive: true });
  await writeFile(path.join(userData, "projects.json"), JSON.stringify({
    recentProjects: [projectA, canonicalProjectB],
    selectedProject: projectA,
    executionConsent: { [projectA]: true, [canonicalProjectB]: true },
    setupCommands: {},
  }));

  const app = await launch(environment.agentDir, false, { PILOT_USER_DATA_DIR: userData });
  try {
    const attention = app.window.getByRole("region", { name: "Task attention overview" });
    await expect(attention.getByRole("region", { name: "Interrupted Tasks" })).toContainText("Interrupted migration");
    await expect(attention.getByRole("region", { name: "Failed Tasks" })).toContainText("Failed release repair");
    await expect(attention).not.toContainText("Healthy active branch");

    await app.window.getByRole("button", { name: "Settings" }).click();
    const settings = app.window.getByRole("main", { name: "Settings" });
    const runLimit = settings.getByRole("spinbutton", { name: "Active Run limit" });
    await expect(runLimit).toHaveValue("4");
    await runLimit.fill("");
    await runLimit.blur();
    await expect(settings.getByRole("alert")).toContainText("Choose a whole number from 1 to 16");
    await expect(runLimit).toHaveValue("4");
    await runLimit.fill("2");
    await runLimit.blur();
    await expect(runLimit).toHaveValue("2");
    await app.window.getByRole("button", { name: "Back to command center" }).click();

    const tasks = await app.window.evaluate(async ({ firstProject, secondProject }) => {
      const pilot = (window as any).pilot;
      return {
        localA: await pilot.createTask(firstProject, { kind: "local" }),
        localAConflict: await pilot.createTask(firstProject, { kind: "local" }),
        localB: await pilot.createTask(secondProject, { kind: "local" }),
        worktreeA: await pilot.createTask(firstProject, { kind: "worktree", ref: "HEAD" }),
        worktreeB: await pilot.createTask(firstProject, { kind: "worktree", ref: "HEAD" }),
        worktreeCancelled: await pilot.createTask(firstProject, { kind: "worktree", ref: "HEAD" }),
        worktreeRevoked: await pilot.createTask(firstProject, { kind: "worktree", ref: "HEAD" }),
      };
    }, { firstProject: projectA, secondProject: canonicalProjectB });
    SessionManager.open(tasks.localA.path).appendSessionInfo("Project A local");
    SessionManager.open(tasks.localAConflict.path).appendSessionInfo("Project A local conflict");
    SessionManager.open(tasks.localB.path).appendSessionInfo("Project B local");
    SessionManager.open(tasks.worktreeA.path).appendSessionInfo("Project A worktree first");
    SessionManager.open(tasks.worktreeB.path).appendSessionInfo("Project A worktree second");
    SessionManager.open(tasks.worktreeCancelled.path).appendSessionInfo("Project A cancelled wait");
    SessionManager.open(tasks.worktreeRevoked.path).appendSessionInfo("Project A revoked wait");

    await app.window.getByRole("navigation", { name: "Projects and tasks" }).getByRole("button", { name: path.basename(projectA), exact: true }).click();
    await app.window.getByRole("button", { name: "Open command center" }).click();

    await app.window.evaluate(({ project, task }) => { void (window as any).pilot.submitPrompt(project, task, "hold concurrent project A"); }, { project: projectA, task: tasks.localA.path });
    await expect.poll(() => provider.requests.map(latestUserText)).toContain("hold concurrent project A");
    await app.window.evaluate(({ project, task }) => { void (window as any).pilot.submitPrompt(project, task, "hold concurrent project B"); }, { project: canonicalProjectB, task: tasks.localB.path });
    await expect.poll(() => provider.requests.map(latestUserText)).toContain("hold concurrent project B");
    expect(provider.activeConcurrent).toBe(2);

    await app.window.evaluate(({ project, task }) => { void (window as any).pilot.submitPrompt(project, task, "hold concurrent worktree first"); }, { project: projectA, task: tasks.worktreeA.path });
    const waiting = attention.getByRole("region", { name: "Waiting Tasks" });
    await expect(waiting).toContainText("Project A worktree first");
    await app.window.evaluate(({ project, task }) => { void (window as any).pilot.submitPrompt(project, task, "hold concurrent worktree second"); }, { project: projectA, task: tasks.worktreeB.path });
    await expect(waiting).toContainText("Project A worktree second");
    await app.window.evaluate(({ project, task }) => { void (window as any).pilot.executeCommand(project, task, "printf should-not-run > cancelled.txt", false); }, { project: projectA, task: tasks.worktreeCancelled.path });
    await expect(waiting).toContainText("Project A cancelled wait");
    await expect.poll(() => provider.requests.map(latestUserText)).not.toContain("hold concurrent worktree first");

    await app.window.reload();
    await expect(attention.getByRole("region", { name: "Running Tasks" })).toContainText("Project A local");
    await expect(attention.getByRole("region", { name: "Running Tasks" })).toContainText("Project B local");
    await expect(waiting).toContainText("Project A worktree first");

    await waiting.getByRole("button", { name: /Project A cancelled wait/ }).click();
    const cancelledTimeline = app.window.getByRole("region", { name: "Run timeline" });
    await expect(cancelledTimeline).toContainText("Queue position 3");
    await expect(cancelledTimeline.getByRole("region", { name: "Command: printf should-not-run > cancelled.txt" })).toContainText("Waiting");
    await expect(app.window.getByRole("navigation", { name: "Projects and tasks" }).getByRole("list", { name: `Active Tasks in ${path.basename(projectA)}` }).getByRole("button", { name: /Project A cancelled wait/ })).toContainText("Waiting");
    await app.window.getByRole("form", { name: "Task composer" }).getByRole("button", { name: "Stop Run" }).click();
    await expect(cancelledTimeline.getByRole("article").last()).toContainText("Aborted");
    await app.window.getByRole("button", { name: "Open command center" }).click();
    await expect(waiting).not.toContainText("Project A cancelled wait");

    const conflict = await app.window.evaluate(async ({ project, task }) => {
      try {
        await (window as any).pilot.submitPrompt(project, task, "must not overlap Local");
        return "";
      } catch (reason) {
        return reason instanceof Error ? reason.message : String(reason);
      }
    }, { project: projectA, task: tasks.localAConflict.path });
    expect(conflict).toContain("Another Local Task is already running in this Project");

    await waiting.getByRole("button", { name: /Project A worktree second/ }).click();
    const queuedTimeline = app.window.getByRole("region", { name: "Run timeline" });
    await expect(queuedTimeline).toContainText("Waiting");
    await expect(queuedTimeline).toContainText("Queue position 2");
    const navigation = app.window.getByRole("navigation", { name: "Projects and tasks" });
    await expect(navigation.getByRole("list", { name: `Active Tasks in ${path.basename(projectA)}` })).toContainText("Waiting");
    await app.window.getByRole("button", { name: "Open command center" }).click();

    provider.releaseConcurrent("hold concurrent project A");
    await expect.poll(() => provider.requests.map(latestUserText)).toContain("hold concurrent worktree first");
    expect(provider.maximumConcurrent).toBe(2);
    await expect(attention.getByRole("region", { name: "Running Tasks" })).toContainText("Project A worktree first");
    await expect(attention.getByRole("region", { name: "Waiting Tasks" })).toContainText("Project A worktree second");

    provider.releaseConcurrent("hold concurrent project B");
    await expect.poll(() => provider.requests.map(latestUserText)).toContain("hold concurrent worktree second");
    expect(provider.requests.map(latestUserText).filter((text) => text.startsWith("hold concurrent "))).toEqual([
      "hold concurrent project A",
      "hold concurrent project B",
      "hold concurrent worktree first",
      "hold concurrent worktree second",
    ]);
    await expect(readFile(path.join(tasks.worktreeCancelled.execution.path, "cancelled.txt"), "utf8")).rejects.toThrow();
    await expect(attention.getByRole("region", { name: "Waiting Tasks" })).toHaveCount(0);

    provider.releaseConcurrent("hold concurrent worktree first");
    provider.releaseConcurrent("hold concurrent worktree second");
    await expect.poll(() => provider.activeConcurrent).toBe(0);
    await expect(attention.getByRole("region", { name: "Running Tasks" })).toHaveCount(0);

    await app.window.evaluate(() => (window as any).pilot.setGlobalRunCap(1));
    await app.window.evaluate(({ project, task }) => { void (window as any).pilot.submitPrompt(project, task, "hold concurrent consent gate"); }, { project: canonicalProjectB, task: tasks.localB.path });
    await expect.poll(() => provider.requests.map(latestUserText)).toContain("hold concurrent consent gate");
    await app.window.evaluate(({ project, task }) => { void (window as any).pilot.submitPrompt(project, task, "must not start after consent revoke"); }, { project: projectA, task: tasks.worktreeRevoked.path });
    await expect(attention.getByRole("region", { name: "Waiting Tasks" })).toContainText("Project A revoked wait");
    const revokedProjects = JSON.parse(await readFile(path.join(userData, "projects.json"), "utf8"));
    revokedProjects.executionConsent[projectA] = false;
    await writeFile(path.join(userData, "projects.json"), JSON.stringify(revokedProjects));
    provider.releaseConcurrent("hold concurrent consent gate");
    await expect.poll(() => provider.activeConcurrent).toBe(0);
    await expect(attention.getByRole("region", { name: "Failed Tasks" })).toContainText("Project A revoked wait");
    expect(provider.requests.map(latestUserText)).not.toContain("must not start after consent revoke");
    revokedProjects.executionConsent[projectA] = true;
    await writeFile(path.join(userData, "projects.json"), JSON.stringify(revokedProjects));

    await app.window.getByRole("navigation", { name: "Projects and tasks" }).getByRole("button", { name: path.basename(projectA), exact: true }).click();
    await app.window.getByRole("list", { name: `Active Tasks in ${path.basename(projectA)}` }).getByRole("button", { name: "Project A cancelled wait", exact: true }).click();
    await expect(app.window.getByRole("region", { name: "Command: printf should-not-run > cancelled.txt" })).toContainText("Aborted");
    expect(JSON.parse(await readFile(path.join(userData, "preferences.json"), "utf8"))).toMatchObject({ globalRunCap: 1 });
  } finally {
    provider.releaseConcurrent("hold concurrent project A");
    provider.releaseConcurrent("hold concurrent project B");
    provider.releaseConcurrent("hold concurrent worktree first");
    provider.releaseConcurrent("hold concurrent worktree second");
    provider.releaseConcurrent("hold concurrent consent gate");
    await close(app);
    await provider.close();
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("pauses externally changed Tasks until Reload or Fork", async () => {
  test.setTimeout(60_000);
  const environment = await fixture();
  const project = await realpath(environment.project);
  const provider = await deterministicProvider(environment.root);
  await execute("git", ["init"], { cwd: project });
  await execute("git", ["config", "user.email", "pilot@example.test"], { cwd: project });
  await execute("git", ["config", "user.name", "PiLot Test"], { cwd: project });
  await writeFile(path.join(project, "README.md"), "# Fixture\n");
  await execute("git", ["add", "."], { cwd: project });
  await execute("git", ["commit", "-m", "fixture"], { cwd: project });
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
  const app = await launch(environment.agentDir, false, { PILOT_TEST_PROJECT_DIR: project });

  try {
    await app.window.getByRole("button", { name: "Add project" }).click();
    await app.window.getByRole("dialog", { name: "Project access" }).getByRole("button", { name: "Allow agent execution" }).click();
    await app.window.getByRole("button", { name: "New Task" }).click();
    await app.window.getByRole("dialog", { name: "Create Task" }).getByRole("button", { name: "Create Local Task" }).click();
    const composer = app.window.getByRole("form", { name: "Task composer" });
    const prompt = composer.getByRole("combobox", { name: "Prompt" });
    const timeline = app.window.getByRole("region", { name: "Run timeline" });
    await prompt.fill("establish PiLot history");
    await composer.getByRole("button", { name: "Send" }).click();
    await expect(timeline.getByRole("article").last()).toContainText("Settled");

    const directory = sessionDirectory(environment.agentDir, project);
    const file = path.join(directory, (await readdir(directory)).find((value) => value.endsWith(".jsonl"))!);
    const externalId = SessionManager.open(file).appendCustomEntry("fixture.external", { writer: "cli" });
    const continuity = app.window.getByRole("alert", { name: "Task changed outside PiLot" });
    await expect(continuity).toContainText("Review the Run timeline and Changes before continuing");
    await expect(continuity.getByRole("button", { name: "Reload Task" })).toBeVisible();
    await expect(continuity.getByRole("button", { name: "Fork Task" })).toBeVisible();
    const [continuityBox, composerBox] = await Promise.all([continuity.boundingBox(), composer.boundingBox()]);
    expect(continuityBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    expect(composerBox!.y - (continuityBox!.y + continuityBox!.height)).toBeLessThanOrEqual(8);
    await expect(prompt).toBeDisabled();
    const blocked = await app.window.evaluate(async ({ projectPath, taskPath }) => {
      try {
        await (window as any).pilot.submitPrompt(projectPath, taskPath, "must stay blocked");
        return "";
      } catch (reason) {
        return reason instanceof Error ? reason.message : String(reason);
      }
    }, { projectPath: project, taskPath: file });
    expect(blocked).toContain("changed outside PiLot");

    await writeFile(path.join(project, "external.txt"), "inspect me\n");
    const inspector = app.window.getByRole("complementary", { name: "Inspector" });
    const changesTab = inspector.getByRole("tab", { name: /Changes/ });
    await expect(changesTab).toHaveAccessibleName("Changes, 1 changed file");
    await changesTab.click();
    await expect(inspector.getByRole("button", { name: /Untracked external\.txt/ })).toBeVisible();
    await expect(timeline).toContainText("Streaming from PiLot.");

    await continuity.getByRole("button", { name: "Reload Task" }).click();
    await expect(continuity).toHaveCount(0);
    await expect(prompt).toBeEnabled();
    await prompt.fill("continue after reload");
    await composer.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => provider.requests.length).toBe(2);
    await expect(timeline.getByRole("article").last()).toContainText("Settled");
    const reloadedEntries = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const externalIndex = reloadedEntries.findIndex(({ id }) => id === externalId);
    const scheduledMarker = reloadedEntries.slice(externalIndex + 1).find((entry) => entry.customType === "pilot.run" && entry.data?.outcome === "queued");
    expect(scheduledMarker).toMatchObject({ parentId: externalId, data: { inputKind: "prompt", input: "continue after reload" } });
    const resumedMarker = reloadedEntries.slice(externalIndex + 1).find((entry) => entry.customType === "pilot.run" && entry.data?.outcome === "running" && entry.data?.runId === scheduledMarker.data.runId);
    expect(resumedMarker).toMatchObject({ parentId: scheduledMarker.id });
    expect(reloadedEntries.find((entry) => entry.type === "message" && entry.parentId === resumedMarker.id)?.message.role).toBe("user");

    await prompt.fill("run abort tool");
    await composer.getByRole("button", { name: "Send" }).click();
    await expect(timeline.getByRole("article").last().locator('details[aria-label="bash tool, running"]')).toBeVisible();
    const secondExternalId = SessionManager.open(file).appendCustomEntry("fixture.external", { writer: "cli-during-run" });
    await expect(continuity).toBeVisible();
    await expect(timeline.getByRole("article").last()).toContainText("Interrupted");
    await expect(timeline.getByRole("article").last().locator('details[aria-label="bash tool, interrupted"]')).toContainText("Interrupted");
    await expect(continuity.getByRole("button", { name: "Fork Task" })).toBeEnabled();
    const blockedEntries = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(blockedEntries.at(-1)?.id).toBe(secondExternalId);
    await continuity.getByRole("button", { name: "Fork Task" }).click();
    const forkDialog = app.window.getByRole("dialog", { name: "Create Task" });
    await expect(forkDialog.getByRole("note")).toContainText("uncommitted files are never transferred");
    await forkDialog.getByRole("button", { name: "Create Local Task" }).click();
    await expect(continuity).toHaveCount(0);
    await expect(prompt).toBeEnabled();
    await expect.poll(async () => {
      const files = (await readdir(directory)).filter((value) => value.endsWith(".jsonl"));
      for (const value of files) {
        const candidate = path.join(directory, value);
        if (candidate === file) continue;
        const body = await readFile(candidate, "utf8");
        const header = JSON.parse(body.split("\n", 1)[0]);
        if (header.parentSession === file) return { candidate, body };
      }
      return undefined;
    }).toBeTruthy();
    const child = await childSession(directory, file);
    expect(child).not.toBe("");
    expect(await readFile(child, "utf8")).not.toContain(secondExternalId);
    await prompt.fill("continue on fork");
    await composer.getByRole("button", { name: "Send" }).click();
    await expect(timeline.getByRole("article").last()).toContainText("Settled");
  } finally {
    await close(app);
    await provider.close();
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("opens a compatible legacy Task without reporting its migration as external", async () => {
  const environment = await fixture(2);
  const file = path.join(environment.agentDir, "sessions", "fixture", "task.jsonl");
  await writeFile(file, `${JSON.stringify({
    type: "message",
    id: "legacy-prompt",
    parentId: null,
    timestamp: historyTimestamp(1),
    message: { role: "user", content: "Legacy Task", timestamp: Date.parse(historyTimestamp(1)) },
  })}\n`, { flag: "a" });
  const app = await launch(environment.agentDir, false, { PILOT_TEST_PROJECT_DIR: environment.project });

  try {
    await app.window.getByRole("button", { name: "Add project" }).click();
    await app.window.getByRole("dialog", { name: "Project access" }).getByRole("button", { name: "Allow agent execution" }).click();
    await app.window.getByRole("region", { name: "Active tasks" }).getByRole("button", { name: "Legacy Task" }).click();
    await expect(app.window.getByRole("form", { name: "Task composer" }).getByRole("combobox", { name: "Prompt" })).toBeEnabled();
    const continuity = app.window.getByRole("alert", { name: "Task changed outside PiLot" });
    await expect(continuity).toHaveCount(0);
    await expect.poll(async () => JSON.parse((await readFile(file, "utf8")).split("\n", 1)[0]).version).toBe(3);

    const legacyAgain = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    legacyAgain[0].version = 2;
    await writeFile(file, `${legacyAgain.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    await expect(continuity).toBeVisible();
    await continuity.getByRole("button", { name: "Reload Task" }).click();
    await expect(continuity).toHaveCount(0);
    await expect(app.window.getByRole("form", { name: "Task composer" }).getByRole("combobox", { name: "Prompt" })).toBeEnabled();
    await expect.poll(async () => JSON.parse((await readFile(file, "utf8")).split("\n", 1)[0]).version).toBe(3);
  } finally {
    await close(app);
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("reopens a process-terminated Run as Interrupted without replay", async () => {
  test.setTimeout(60_000);
  const environment = await fixture();
  const project = await realpath(environment.project);
  const provider = await deterministicProvider(environment.root);
  await execute("git", ["init"], { cwd: project });
  await execute("git", ["config", "user.email", "pilot@example.test"], { cwd: project });
  await execute("git", ["config", "user.name", "PiLot Test"], { cwd: project });
  await writeFile(path.join(project, "README.md"), "# Fixture\n");
  await execute("git", ["add", "."], { cwd: project });
  await execute("git", ["commit", "-m", "fixture"], { cwd: project });
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
  let app = await launch(environment.agentDir, false, { PILOT_TEST_PROJECT_DIR: project });

  try {
    await app.window.getByRole("button", { name: "Add project" }).click();
    await app.window.getByRole("dialog", { name: "Project access" }).getByRole("button", { name: "Allow agent execution" }).click();
    await app.window.getByRole("button", { name: "New Task" }).click();
    await app.window.getByRole("dialog", { name: "Create Task" }).getByRole("button", { name: "Create Local Task" }).click();
    let composer = app.window.getByRole("form", { name: "Task composer" });
    await composer.getByRole("combobox", { name: "Prompt" }).fill("abort model");
    await composer.getByRole("button", { name: "Send" }).click();
    await expect(app.window.getByRole("region", { name: "Run timeline" })).toContainText("Still streaming");
    let requestsBeforeRestart = provider.requests.length;
    await terminate(app);

    app = await launch(environment.agentDir, false, { PILOT_TEST_PROJECT_DIR: project });
    await app.window.getByRole("list", { name: "Active Tasks in fixture-project" }).getByRole("button").first().click();
    let timeline = app.window.getByRole("region", { name: "Run timeline" });
    await expect(timeline.getByRole("article").last()).toContainText("Interrupted");
    await expect(timeline.getByRole("article").last()).toContainText("abort model");
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(provider.requests).toHaveLength(requestsBeforeRestart);

    composer = app.window.getByRole("form", { name: "Task composer" });
    await composer.getByRole("combobox", { name: "Prompt" }).fill("crash after file write");
    await composer.getByRole("button", { name: "Send" }).click();
    await expect(app.window.locator('details[aria-label="bash tool, running"]')).toBeVisible();
    await expect.poll(() => readFile(path.join(project, "crash.txt"), "utf8").catch(() => "")).toBe("interrupted");
    requestsBeforeRestart = provider.requests.length;
    await terminate(app);

    app = await launch(environment.agentDir, false, { PILOT_TEST_PROJECT_DIR: project });
    await app.window.getByRole("list", { name: "Active Tasks in fixture-project" }).getByRole("button").first().click();
    timeline = app.window.getByRole("region", { name: "Run timeline" });
    const interrupted = timeline.getByRole("article").last();
    await expect(interrupted).toContainText("Interrupted");
    await expect(interrupted).toContainText("crash after file write");
    await expect(interrupted.locator('details[aria-label="bash tool, interrupted"]')).toContainText("Interrupted");
    await expect(app.window.getByRole("status", { name: "Interrupted Run recovery" })).toContainText("PiLot did not retry the interrupted input. Review the timeline and Changes before continuing.");
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(provider.requests).toHaveLength(requestsBeforeRestart);

    const inspector = app.window.getByRole("complementary", { name: "Inspector" });
    const changesTab = inspector.getByRole("tab", { name: /Changes/ });
    await expect(changesTab).toHaveAccessibleName("Changes, 1 changed file");
    await changesTab.click();
    await expect(inspector.getByRole("button", { name: /Untracked crash\.txt/ })).toBeVisible();

    const recoveredComposer = app.window.getByRole("form", { name: "Task composer" });
    await expect(recoveredComposer.getByRole("combobox", { name: "Prompt" })).toBeEnabled();
    await recoveredComposer.getByRole("combobox", { name: "Prompt" }).fill("continue after interruption");
    await recoveredComposer.getByRole("button", { name: "Send" }).click();
    await expect(timeline.getByRole("article").last()).toContainText("Settled");
    expect(provider.requests.length).toBeGreaterThan(requestsBeforeRestart);
  } finally {
    await close(app);
    await provider.close();
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("surfaces retry and compaction lifecycles through the Electron boundary", async () => {
  const environment = await fixture();
  const project = await realpath(environment.project);
  const provider = await deterministicProvider(environment.root);
  await writeFile(path.join(environment.agentDir, "models.json"), JSON.stringify({
    providers: {
      fixture: {
        baseUrl: provider.baseUrl,
        api: "openai-completions",
        apiKey: "fixture-key",
        models: [{ id: "fixture-model", name: "Fixture model", contextWindow: 200, maxTokens: 50 }],
      },
    },
  }));
  await writeFile(path.join(environment.agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "fixture",
    defaultModel: "fixture-model",
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 500 },
    compaction: { enabled: true, reserveTokens: 10, keepRecentTokens: 1 },
  }));
  const app = await launch(environment.agentDir, false, { PILOT_TEST_PROJECT_DIR: environment.project });

  try {
    await app.window.getByRole("button", { name: "Add project" }).click();
    await app.window.getByRole("dialog", { name: "Project access" }).getByRole("button", { name: "Allow agent execution" }).click();
    await app.window.getByRole("button", { name: "New Task" }).click();

    const composer = app.window.getByRole("form", { name: "Task composer" });
    const prompt = composer.getByRole("combobox", { name: "Prompt" });
    const timeline = app.window.getByRole("region", { name: "Run timeline" });

    await prompt.fill("retry then succeed");
    await composer.getByRole("button", { name: "Send" }).click();
    await expect(timeline).toContainText("Retrying");
    await expect(timeline).toContainText("Attempt 1 of 2 · retrying in 500 ms");
    await expect(timeline).toContainText("Retry succeeded");
    await expect(timeline).toContainText("Attempt 2 of 2");
    await expect(timeline).toContainText("Retry recovered.");
    await expect(timeline.getByRole("article").last()).toContainText("Settled");
    await expect(timeline.getByRole("button", { name: /Abort/ })).toHaveCount(0);

    await prompt.fill("two retry episodes");
    await composer.getByRole("button", { name: "Send" }).click();
    const repeatedRetries = timeline.getByRole("article").last();
    await expect(repeatedRetries).toContainText("Both retry episodes recovered.");
    await expect(repeatedRetries.getByRole("region", { name: "Provider retry succeeded" })).toHaveCount(2);
    await expect(repeatedRetries.getByRole("button", { name: /Abort/ })).toHaveCount(0);

    await prompt.fill("abort pending retry");
    await composer.getByRole("button", { name: "Send" }).click();
    const retryingRun = timeline.getByRole("article").last();
    await expect(retryingRun).toContainText("Retrying");
    await expect(retryingRun.getByRole("button", { name: /Abort/ })).toHaveCount(0);
    await composer.getByRole("button", { name: "Stop Run" }).click();
    await expect(retryingRun).toContainText("Aborted");

    await prompt.fill("Task remains usable");
    await composer.getByRole("button", { name: "Send" }).click();
    await expect(timeline.getByRole("article").last()).toContainText("Settled");

    await app.window.getByRole("button", { name: "Compact context" }).click();
    const manual = timeline.getByRole("article").last();
    await expect(manual).toContainText("Manual compaction");
    await expect(manual).toContainText("Succeeded");
    await expect(manual).toContainText("Full Task history remains in the Pi session");

    await app.window.getByRole("button", { name: "Compact context" }).click();
    const failedCompaction = timeline.getByRole("article").last();
    await expect(failedCompaction).toContainText("Compaction failed");
    await expect(failedCompaction).toContainText(/Nothing to compact|Already compacted/);
    await expect(composer.getByRole("combobox", { name: "Prompt" })).toBeEnabled();

    await prompt.fill("cross compaction threshold");
    await composer.getByRole("button", { name: "Send" }).click();
    const threshold = timeline.getByRole("article").last();
    await expect(threshold).toContainText("Threshold compaction");
    await expect(threshold).toContainText("Succeeded");
    await expect(threshold).toContainText("Settled");

    await prompt.fill("recover overflow");
    await composer.getByRole("button", { name: "Send" }).click();
    const overflow = timeline.getByRole("article").last();
    await expect(overflow).toContainText("Overflow recovery");
    await expect(overflow).toContainText("Succeeded");
    await expect(overflow).toContainText("Overflow recovered.");
    await expect(overflow).toContainText("Settled");

    await prompt.fill("prepare stop compaction");
    await composer.getByRole("button", { name: "Send" }).click();
    await expect(timeline.getByRole("article").last()).toContainText("Settled");
    await app.window.getByRole("button", { name: "Compact context" }).click();
    const stoppedCompaction = timeline.getByRole("article").last();
    await expect(stoppedCompaction).toContainText("Manual compaction");
    await composer.getByRole("button", { name: "Stop Run" }).click();
    await expect(stoppedCompaction).toContainText("Aborted");

    const directory = sessionDirectory(environment.agentDir, project);
    const file = path.join(directory, (await readdir(directory)).find((value) => value.endsWith(".jsonl"))!);
    const saved = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(saved.filter((entry) => entry.type === "message" && entry.message.role === "user").map((entry) => latestUserText(JSON.stringify({ messages: [entry.message] })))).toEqual([
      "retry then succeed",
      "two retry episodes",
      "abort pending retry",
      "Task remains usable",
      "cross compaction threshold",
      "recover overflow",
      "prepare stop compaction",
    ]);
    expect(saved.filter((entry) => entry.type === "compaction")).toHaveLength(3);
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
    const prompt = composer.getByRole("combobox", { name: "Prompt" });
    await prompt.fill("start live queue check");
    await composer.getByRole("button", { name: "Send" }).click();
    await expect(app.window.locator('details[aria-label="bash tool, running"]')).toBeVisible();

    const liveMode = composer.getByRole("radiogroup", { name: "Live input mode" });
    await expect(liveMode.getByRole("radio", { name: "Steer" })).toBeChecked();
    await expect(liveMode.getByRole("radio", { name: "Follow-up" })).not.toBeChecked();

    await prompt.fill("steer with keyboard");
    await prompt.press("Enter");
    await expect(composer.getByRole("list", { name: "Pending steering" })).toContainText("steer with keyboard");

    await liveMode.getByRole("radio", { name: "Follow-up" }).check();
    await prompt.fill("follow up with pointer");
    await expect(composer.getByRole("button", { name: "Send" })).toBeVisible();
    await expect(composer.getByRole("button", { name: "Stop Run" })).toHaveCount(0);
    await composer.getByRole("button", { name: "Send" }).click();
    await expect(composer.getByRole("list", { name: "Pending follow-ups" })).toContainText("follow up with pointer");
    await expect(app.window.getByRole("region", { name: "Run timeline" })).toContainText("Follow-up received.");
    await expect.poll(() => provider.requests.map(latestUserText)).toEqual([
      "start live queue check",
      "steer with keyboard",
      "follow up with pointer",
    ]);

    await prompt.fill("start abort queue check");
    await composer.getByRole("button", { name: "Send" }).click();
    await expect(app.window.locator('details[aria-label="bash tool, running"]')).toBeVisible();
    await prompt.fill("recover queued follow-up");
    await prompt.press("Alt+Enter");
    await expect(composer.getByRole("list", { name: "Pending follow-ups" })).toContainText("recover queued follow-up");
    await prompt.fill("");
    await composer.getByRole("button", { name: "Stop Run" }).click();
    await expect(prompt).toHaveValue("recover queued follow-up");
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
    const prompt = composer.getByRole("combobox", { name: "Prompt" });
    const timeline = app.window.getByRole("region", { name: "Run timeline" });

    await prompt.fill("!!printf hidden-command-output");
    await composer.getByRole("button", { name: "Send" }).click();
    const hiddenCommand = timeline.getByRole("region", { name: "Command: printf hidden-command-output" });
    await expect(hiddenCommand).toContainText("hidden-command-output");
    await expect(hiddenCommand).toContainText("Local only");

    await prompt.fill("!printf visible-command-output");
    await composer.getByRole("button", { name: "Send" }).click();
    const visibleCommand = timeline.getByRole("region", { name: "Command: printf visible-command-output" });
    await expect(visibleCommand).toContainText("visible-command-output");
    await expect(visibleCommand).toContainText("Included in next Pi context");

    await prompt.fill("show evidence");
    await composer.getByRole("button", { name: "Send" }).click();
    await expect(timeline).toContainText("Evidence complete.");
    await expect(timeline.getByRole("article")).toHaveCount(3);
    const workspace = app.window.locator(".workspace-main");
    const distanceFromLatest = () => workspace.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
    await expect.poll(distanceFromLatest).toBeLessThanOrEqual(1);
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

    await prompt.fill("start live queue check");
    await composer.getByRole("button", { name: "Send" }).click();
    await expect(app.window.locator('details[aria-label="bash tool, running"]')).toBeVisible();
    await workspace.evaluate((element) => { element.scrollTop = 0; });
    await expect.poll(() => workspace.evaluate((element) => element.scrollTop)).toBe(0);
    await expect(app.window.getByRole("button", { name: "Jump to latest Run evidence" })).toHaveCount(0);
    await prompt.fill("steer with keyboard");
    await prompt.press("Enter");
    await expect(composer.getByRole("list", { name: "Pending steering" })).toContainText("steer with keyboard");
    await expect(app.window.getByRole("button", { name: "Jump to latest Run evidence" })).toHaveCount(0);
    const jumpToLatest = app.window.getByRole("button", { name: "Jump to latest Run evidence" });
    await expect(jumpToLatest).toBeVisible();
    await expect.poll(() => workspace.evaluate((element) => element.scrollTop)).toBe(0);
    await jumpToLatest.click();
    await expect.poll(distanceFromLatest).toBeLessThanOrEqual(1);
    await expect(timeline).toContainText("Steering received.");
    await expect(timeline.getByRole("article").last()).toContainText("Settled");

    await prompt.fill("show failure");
    await composer.getByRole("button", { name: "Send" }).click();
    await expect(timeline).toContainText("Failure recorded.");
    const failedTool = timeline.locator('details[aria-label="bash tool, failed"]');
    await expect(failedTool).toHaveAttribute("open", "");
    await expect(failedTool).toContainText("Command exited with code 7");

    await workspace.evaluate((element) => { element.scrollTop = 0; });
    await app.window.getByRole("navigation", { name: "Projects and tasks" }).getByRole("button", { name: /fixture-project/ }).click();
    await app.window.getByRole("list", { name: "Active Tasks in fixture-project" }).getByRole("button").first().click();
    await expect(timeline.getByRole("article")).toHaveCount(6);
    await expect.poll(distanceFromLatest).toBeLessThanOrEqual(1);

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

test("reviews aggregate Task changes through the Electron boundary", async () => {
  test.setTimeout(60_000);
  const environment = await fixture();
  const provider = await deterministicProvider(environment.root);
  const executionPath = await realpath(environment.project);
  const sourceDirectory = path.join(environment.project, "src");
  const editorDirectory = path.join(environment.root, "editors");
  const editorScript = path.join(environment.root, "configured-editor.mjs");
  const editorLog = path.join(environment.root, "editor.log");
  const generatedContent = Array.from({ length: 1_500 }, (_, index) => `export const generated${index} = ${index};`).join("\n") + "\n";
  await Promise.all([mkdir(sourceDirectory, { recursive: true }), mkdir(editorDirectory, { recursive: true })]);
  const fakeEditor = async (name: string) => {
    const target = path.join(editorDirectory, process.platform === "win32" ? `${name}.cmd` : name);
    await writeFile(target, process.platform === "win32"
      ? `@echo off\r\n>>\"%PILOT_EDITOR_LOG%\" echo ${name}:%~1\r\n`
      : `#!/bin/sh\nprintf '${name}:%s\\n' \"$1\" >> \"$PILOT_EDITOR_LOG\"\n`);
    if (process.platform !== "win32") await chmod(target, 0o755);
  };
  await Promise.all([fakeEditor("cursor"), fakeEditor("code"), fakeEditor("emacs")]);
  await Promise.all([
    writeFile(path.join(sourceDirectory, "app.ts"), "export const value = 1;\nkeep\n"),
    writeFile(path.join(sourceDirectory, "a[1].ts"), "export const bracket = 1;\n"),
    writeFile(path.join(sourceDirectory, "a1.ts"), "export const plain = 1;\n"),
    writeFile(path.join(sourceDirectory, "old-name.ts"), "export const renamed = true;\n"),
    writeFile(path.join(sourceDirectory, "mode.sh"), "#!/bin/sh\necho ready\n"),
    writeFile(path.join(environment.project, "obsolete.txt"), "remove me\n"),
    writeFile(editorScript, `import { appendFileSync } from "node:fs";\nappendFileSync(process.argv[2], "configured:" + process.argv[3] + "\\n");\n`),
  ]);
  await execute("git", ["init"], { cwd: environment.project });
  await execute("git", ["config", "user.email", "pilot@example.test"], { cwd: environment.project });
  await execute("git", ["config", "user.name", "PiLot Test"], { cwd: environment.project });
  await execute("git", ["config", "core.filemode", "false"], { cwd: environment.project });
  await execute("git", ["add", "."], { cwd: environment.project });
  await execute("git", ["commit", "-m", "fixture"], { cwd: environment.project });
  await execute("git", ["mv", "src/old-name.ts", "src/new-name.ts"], { cwd: environment.project });
  await execute("git", ["update-index", "--chmod=+x", "src/mode.sh"], { cwd: environment.project });
  await Promise.all([
    rm(path.join(environment.project, "obsolete.txt")),
    writeFile(path.join(environment.project, "asset.bin"), Buffer.from([0, 1, 2, 3])),
    writeFile(path.join(sourceDirectory, "a[1].ts"), "export const bracket = 2;\n"),
    writeFile(path.join(sourceDirectory, "a1.ts"), "export const plain = 2;\n"),
    writeFile(path.join(sourceDirectory, "generated.ts"), generatedContent),
    writeFile(path.join(environment.agentDir, "models.json"), JSON.stringify({
      providers: {
        fixture: {
          baseUrl: provider.baseUrl,
          api: "openai-completions",
          apiKey: "fixture-key",
          models: [{ id: "fixture-model", name: "Fixture model", contextWindow: 32_000, maxTokens: 1_000 }],
        },
      },
    })),
    writeFile(path.join(environment.agentDir, "settings.json"), JSON.stringify({
      defaultProvider: "fixture",
      defaultModel: "fixture-model",
      externalEditor: `"${process.execPath}" "${editorScript}" "${editorLog}"`,
    })),
  ]);
  const editorPath = `${editorDirectory}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ""}`;
  const appEnvironment = {
    PILOT_TEST_PROJECT_DIR: environment.project,
    PILOT_EDITOR_LOG: editorLog,
    EDITOR: "vim",
    VISUAL: "",
    PATH: editorPath,
    ...(process.platform === "win32" ? { Path: editorPath } : {}),
  };
  let app = await launch(environment.agentDir, false, appEnvironment);

  try {
    await app.window.getByRole("button", { name: "Add project" }).click();
    await app.window.getByRole("dialog", { name: "Project access" }).getByRole("button", { name: "Allow agent execution" }).click();
    await app.window.getByRole("button", { name: "New Task" }).click();
    await app.window.getByRole("dialog", { name: "Create Task" }).getByRole("button", { name: "Create Local Task" }).click();
    const prompt = app.window.getByRole("combobox", { name: "Prompt" });
    await prompt.fill("edit tracked file");
    await app.window.getByRole("button", { name: "Send" }).click();
    await expect(app.window.getByRole("region", { name: "Run timeline" })).toContainText("Changes ready.");

    const inspector = app.window.getByRole("complementary", { name: "Inspector" });
    const detailsTab = inspector.getByRole("tab", { name: "Details" });
    const changesTab = inspector.getByRole("tab", { name: /Changes/ });
    await expect(changesTab).toHaveAccessibleName("Changes, 8 changed files");
    await detailsTab.focus();
    await writeFile(path.join(sourceDirectory, "later.ts"), "export const later = true;\n");
    await expect(changesTab).toHaveAccessibleName("Changes, 9 changed files");
    await expect(detailsTab).toHaveAttribute("aria-selected", "true");
    await expect(detailsTab).toBeFocused();

    const editEvidence = app.window.getByRole("button", { name: "Review src/app.ts in Changes" });
    await editEvidence.click();
    await expect(changesTab).toHaveAttribute("aria-selected", "true");
    const changes = inspector.getByRole("tabpanel", { name: /Changes/ });
    await expect(changes).toContainText("9 files");
    await expect(changes).toContainText("+1,505");
    await expect(changes).toContainText("−4");
    const changedFiles = changes.getByRole("list", { name: "Changed files" });
    await expect(changedFiles.getByRole("button", { name: /Modified src\/app\.ts/ })).toHaveAttribute("aria-current", "true");
    await expect(changedFiles.getByRole("button", { name: /Deleted obsolete\.txt/ })).toBeVisible();
    await expect(changedFiles.getByRole("button", { name: "Renamed src/new-name.ts, from src/old-name.ts, 0 additions, 0 deletions" })).toBeVisible();
    await expect(changedFiles.getByRole("button", { name: "Untracked asset.bin, binary file" })).toBeVisible();
    await expect(changedFiles.getByRole("button", { name: /Untracked src\/generated\.ts/ })).toBeVisible();

    await changedFiles.getByRole("button", { name: /Modified src\/a\[1\]\.ts/ }).click();
    const literalDiff = changes.getByRole("grid", { name: "Unified diff for src/a[1].ts" });
    await expect(literalDiff.getByRole("row", { name: "Added line 1: export const bracket = 2;" })).toBeVisible();
    await expect(literalDiff).not.toContainText("plain");

    await changedFiles.getByRole("button", { name: /Modified src\/mode\.sh/ }).click();
    const metadata = changes.getByRole("list", { name: "Git change metadata" });
    await expect(metadata).toContainText("old mode 100644");
    await expect(metadata).toContainText("new mode 100755");
    await expect(changes).toContainText("No text hunks to display.");

    await changedFiles.getByRole("button", { name: /Untracked src\/generated\.ts/ }).click();
    const diff = changes.getByRole("grid", { name: "Unified diff for src/generated.ts" });
    await expect(diff).toHaveAttribute("aria-rowcount", "1501");
    expect(await diff.getByRole("row").count()).toBeLessThan(100);
    await expect(diff.getByRole("row", { name: "Added line 1: export const generated0 = 0;" })).toBeVisible();
    await diff.focus();
    await diff.press("ArrowDown");
    await expect(diff).toHaveAttribute("aria-activedescendant", /-row-1$/);
    await expect(diff.locator('[role="row"][aria-selected="true"]')).toHaveAttribute("aria-rowindex", "2");
    expect(await diff.evaluate((element) => getComputedStyle(element).userSelect)).toBe("text");
    await writeFile(path.join(sourceDirectory, "generated.ts"), generatedContent.replace("generated0 = 0", "generated0 = 9"));
    await expect(diff.getByRole("row", { name: "Added line 1: export const generated0 = 9;" })).toBeVisible();
    await expect(diff).toBeFocused();
    await expect(changesTab).toHaveAttribute("aria-selected", "true");
    await diff.press("End");
    await expect(diff.locator('[role="row"][aria-selected="true"]')).toHaveAttribute("aria-rowindex", "1501");
    const shortenedContent = generatedContent.replace("generated0 = 0", "generated0 = 9").split("\n").slice(0, 3).join("\n") + "\n";
    await writeFile(path.join(sourceDirectory, "generated.ts"), shortenedContent);
    await expect(diff).toHaveAttribute("aria-rowcount", "4");
    await expect(diff).toBeFocused();
    const activeDescendant = await diff.getAttribute("aria-activedescendant");
    await expect(diff.locator(`[id="${activeDescendant}"]`)).toHaveCount(1);

    const executionEditor = changes.getByRole("group", { name: "Open execution location externally" });
    const configuredEditor = executionEditor.getByRole("button", { name: "Open execution location in Pi configured editor" });
    await expect(configuredEditor).toBeVisible();
    const editorChooser = executionEditor.getByRole("button", { name: "Choose application for execution location" });
    await editorChooser.click();
    const editorMenu = app.window.getByRole("menu", { name: "Applications" });
    const configuredOption = editorMenu.getByRole("menuitemradio", { name: "Pi configured editor" });
    await expect(configuredOption).toBeFocused();
    await configuredOption.press("ArrowDown");
    await expect(configuredOption).not.toBeFocused();
    await app.window.keyboard.press("Escape");
    await expect(editorChooser).toBeFocused();
    await editorChooser.click();
    await configuredOption.press("Tab");
    await expect(editorMenu).not.toBeVisible();
    await configuredEditor.click();
    await editorChooser.click();
    await editorMenu.getByRole("menuitemradio", { name: "VS Code" }).click();
    const fileEditor = changes.getByRole("group", { name: "Open src/generated.ts externally" });
    await fileEditor.getByRole("button", { name: "Open src/generated.ts in VS Code" }).click();
    await expect.poll(async () => (await readFile(editorLog, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).sort()).toEqual([
      `code:${path.join(executionPath, "src", "generated.ts")}`,
      `code:${executionPath}`,
      `configured:${executionPath}`,
    ].sort());
    await expect.poll(async () => JSON.parse(await readFile(path.join(environment.agentDir, "pilot-user-data", "preferences.json"), "utf8"))).toMatchObject({ preferredApplication: "vscode" });
    const unchangedFileError = await openCurrentTaskPathError(app.window, ".git/config");
    expect(unchangedFileError).toContain("not a current Git change");
    if (process.platform !== "win32") {
      const insideLink = path.join(sourceDirectory, "inside-link.ts");
      const danglingLink = path.join(sourceDirectory, "dangling-link.ts");
      const outsideFile = path.join(environment.root, "outside.ts");
      const nestedTarget = path.join(sourceDirectory, "nested-target.ts");
      const rootLink = path.join(sourceDirectory, "root-link");
      await writeFile(outsideFile, "export const outside = true;\n");
      await Promise.all([
        symlink("app.ts", insideLink),
        symlink("missing.ts", danglingLink),
        symlink(outsideFile, path.join(sourceDirectory, "outside-link.ts")),
        symlink(path.join(environment.root, "missing.ts"), nestedTarget),
        symlink("nested-target.ts", path.join(sourceDirectory, "nested-link.ts")),
        symlink("..", rootLink),
      ]);
      await expect(changesTab).toHaveAccessibleName("Changes, 15 changed files");

      await changedFiles.getByRole("button", { name: /Untracked src\/inside-link\.ts/ }).click();
      await changes.getByRole("group", { name: "Open src/inside-link.ts externally" }).getByRole("button", { name: "Open src/inside-link.ts in VS Code" }).click();
      await expect.poll(async () => (await readFile(editorLog, "utf8")).split("\n")).toContain(`code:${path.join(executionPath, "src", "inside-link.ts")}`);

      await changedFiles.getByRole("button", { name: /Untracked src\/dangling-link\.ts/ }).click();
      await changes.getByRole("group", { name: "Open src/dangling-link.ts externally" }).getByRole("button", { name: "Open src/dangling-link.ts in VS Code" }).click();
      await expect.poll(async () => (await readFile(editorLog, "utf8")).split("\n")).toContain(`code:${path.join(executionPath, "src", "dangling-link.ts")}`);

      await changedFiles.getByRole("button", { name: /Untracked src\/root-link/ }).click();
      await changes.getByRole("group", { name: "Open src/root-link externally" }).getByRole("button", { name: "Open src/root-link in VS Code" }).click();
      await expect.poll(async () => (await readFile(editorLog, "utf8")).split("\n")).toContain(`code:${path.join(executionPath, "src", "root-link")}`);

      const symlinkError = await openCurrentTaskPathError(app.window, "src/outside-link.ts");
      expect(symlinkError).toContain("must stay within the Execution location");
      const nestedSymlinkError = await openCurrentTaskPathError(app.window, "src/nested-link.ts");
      expect(nestedSymlinkError).toContain("must stay within the Execution location");
    }
    expect(await openCurrentTaskPathError(app.window, "src/generated.ts", "file-manager")).toBe("");

    await close(app);
    app = await launch(environment.agentDir, false, appEnvironment);
    await app.window.getByRole("navigation", { name: "Projects and tasks" }).getByRole("list", { name: "Active Tasks in fixture-project" }).getByRole("button", { name: "Untitled task" }).first().click();
    const reopenedInspector = app.window.getByRole("complementary", { name: "Inspector" });
    await reopenedInspector.getByRole("tab", { name: /Changes/ }).click();
    await expect(reopenedInspector.getByRole("group", { name: "Open execution location externally" }).getByRole("button", { name: "Open execution location in VS Code" })).toBeVisible();

    await close(app);
    const preferencesPath = path.join(environment.agentDir, "pilot-user-data", "preferences.json");
    const stalePreferences = JSON.parse(await readFile(preferencesPath, "utf8"));
    delete stalePreferences.preferredApplication;
    await Promise.all([
      writeFile(preferencesPath, JSON.stringify({ ...stalePreferences, preferredEditor: "configured" }, null, 2)),
      writeFile(path.join(environment.agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture-model" })),
    ]);
    app = await launch(environment.agentDir, false, appEnvironment);
    await app.window.getByRole("navigation", { name: "Projects and tasks" }).getByRole("list", { name: "Active Tasks in fixture-project" }).getByRole("button", { name: "Untitled task" }).first().click();
    const fallbackInspector = app.window.getByRole("complementary", { name: "Inspector" });
    await fallbackInspector.getByRole("tab", { name: /Changes/ }).click();
    const fallbackEditor = fallbackInspector.getByRole("group", { name: "Open execution location externally" }).getByRole("button", { name: "Open execution location in Cursor" });
    await expect(fallbackEditor).toBeVisible();
    await expect(fallbackInspector.getByText(/vim needs an attached terminal/)).toBeVisible();
    await expect.poll(async () => JSON.parse(await readFile(preferencesPath, "utf8"))).toMatchObject({ preferredEditor: "configured" });
    await fallbackEditor.click();
    await expect.poll(async () => JSON.parse(await readFile(preferencesPath, "utf8"))).toMatchObject({ preferredApplication: "cursor" });

    const projectEditorDirectory = path.join(environment.project, "tools");
    const projectEditor = path.join(projectEditorDirectory, process.platform === "win32" ? "editor.cmd" : "editor");
    await Promise.all([mkdir(projectEditorDirectory, { recursive: true }), mkdir(path.join(environment.project, ".pi"), { recursive: true })]);
    await Promise.all([
      writeFile(projectEditor, process.platform === "win32"
        ? "@echo off\r\n>>\"%PILOT_EDITOR_LOG%\" echo relative:%~1\r\n"
        : "#!/bin/sh\nprintf 'relative:%s\\n' \"$1\" >> \"$PILOT_EDITOR_LOG\"\n"),
      writeFile(path.join(environment.project, ".pi", "settings.json"), JSON.stringify({ externalEditor: process.platform === "win32" ? "./tools/editor.cmd" : "./tools/editor" })),
    ]);
    if (process.platform !== "win32") await chmod(projectEditor, 0o755);
    await app.window.evaluate(() => window.dispatchEvent(new Event("focus")));
    const fallbackChooser = fallbackInspector.getByRole("group", { name: "Open execution location externally" }).getByRole("button", { name: "Choose application for execution location" });
    await fallbackChooser.click();
    await app.window.getByRole("menu", { name: "Applications" }).getByRole("menuitemradio", { name: "Pi configured editor" }).click();
    await expect.poll(async () => (await readFile(editorLog, "utf8")).split("\n")).toContain(`relative:${executionPath}`);
    await expect.poll(async () => JSON.parse(await readFile(preferencesPath, "utf8"))).toMatchObject({ preferredApplication: "configured" });

    await close(app);
    await writeFile(path.join(environment.project, ".pi", "settings.json"), JSON.stringify({ externalEditor: "emacs" }));
    app = await launch(environment.agentDir, false, appEnvironment);
    await app.window.getByRole("navigation", { name: "Projects and tasks" }).getByRole("list", { name: "Active Tasks in fixture-project" }).getByRole("button", { name: "Untitled task" }).first().click();
    const emacsInspector = app.window.getByRole("complementary", { name: "Inspector" });
    await emacsInspector.getByRole("tab", { name: /Changes/ }).click();
    await emacsInspector.getByRole("group", { name: "Open execution location externally" }).getByRole("button", { name: "Open execution location in Pi configured editor" }).click();
    await expect.poll(async () => (await readFile(editorLog, "utf8")).split("\n")).toContain(`emacs:${executionPath}`);

    const admissionError = await app.window.evaluate(async () => {
      const pilot = (window as any).pilot;
      const state = await pilot.getProjects();
      const project = state.selected;
      const task = project.tasks.reduce((latest: { modified: string }, candidate: { modified: string }) => candidate.modified > latest.modified ? candidate : latest);
      await pilot.removeProject(project.path);
      try {
        await pilot.openTaskPathInApplication(project.path, task.path, "vscode");
        return "";
      } catch (reason) {
        return reason instanceof Error ? reason.message : String(reason);
      }
    });
    expect(admissionError).toContain("Admit this Project");
  } finally {
    await close(app);
    await provider.close();
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("recognizes configured GUI editor commands through the Electron boundary", async () => {
  const environment = await fixture();
  const editorDirectory = path.join(environment.root, "gui-editor");
  const executable = path.join(editorDirectory, process.platform === "win32" ? "vim.cmd" : "vim");
  await mkdir(editorDirectory, { recursive: true });
  await Promise.all([
    writeFile(executable, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\nexit 0\n"),
    writeFile(path.join(environment.agentDir, "settings.json"), JSON.stringify({ externalEditor: "vim -g" })),
  ]);
  if (process.platform !== "win32") await chmod(executable, 0o755);
  const editorPath = `${editorDirectory}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ""}`;
  const app = await launch(environment.agentDir, false, {
    PILOT_TEST_PROJECT_DIR: environment.project,
    PATH: editorPath,
    ...(process.platform === "win32" ? { Path: editorPath } : {}),
  });

  try {
    await app.window.getByRole("button", { name: "Add project" }).click();
    await app.window.getByRole("dialog", { name: "Project access" }).getByRole("button", { name: "Allow agent execution" }).click();
    const applicationState = await app.window.evaluate(async () => {
      const pilot = (window as any).pilot;
      const project = (await pilot.getProjects()).selected;
      return pilot.getApplicationState(project.path, project.tasks[0].path);
    });
    expect(applicationState.available).toContainEqual(expect.objectContaining({ id: "configured", label: "Pi configured editor" }));
  } finally {
    await close(app);
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("renders and navigates branched Task history through the Electron boundary", async () => {
  const environment = await fixture();
  const provider = await deterministicProvider(environment.root);
  const historyFile = await writeBranchedHistory(environment.agentDir, environment.project);
  await Promise.all([
    writeFile(path.join(environment.agentDir, "models.json"), JSON.stringify({
      providers: {
        fixture: {
          baseUrl: provider.baseUrl,
          api: "openai-completions",
          apiKey: "fixture-key",
          models: [{ id: "fixture-model", name: "Fixture model", reasoning: true, contextWindow: 32_000, maxTokens: 2_048 }],
        },
      },
    })),
    writeFile(path.join(environment.agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture-model" })),
  ]);
  const app = await launch(environment.agentDir, false, { PILOT_TEST_PROJECT_DIR: environment.project });

  try {
    await app.window.getByRole("button", { name: "Add project" }).click();
    await app.window.getByRole("dialog", { name: "Project access" }).getByRole("button", { name: "Allow agent execution" }).click();
    await app.window.getByRole("navigation", { name: "Projects and tasks" }).getByRole("button", { name: "History fixture", exact: true }).click();

    const inspector = app.window.getByRole("complementary", { name: "Inspector" });
    await inspector.getByRole("tab", { name: /History/ }).click();
    const tree = inspector.getByRole("tree", { name: "Task history" });
    await expect(tree.getByRole("treeitem", { name: /Shared answer/ })).toContainText("2 branches");
    await expect(tree.getByRole("treeitem", { name: /Branch B done/ })).toContainText("Current leaf");
    await expect(tree.getByRole("treeitem", { name: /Implement branch B/ })).toContainText("Preferred route");
    await expect(tree.getByRole("treeitem", { name: /Compaction/ })).toContainText("12,000 tokens");
    await expect(tree.getByRole("treeitem", { name: /Model change/ })).toContainText("fixture/fixture-model");
    await expect(tree.getByRole("treeitem", { name: /Thinking change/ })).toContainText("High");

    const branchPoint = tree.getByRole("treeitem", { name: /Shared answer/ });
    await branchPoint.focus();
    await branchPoint.press("ArrowLeft");
    await expect(branchPoint).toHaveAttribute("aria-expanded", "false");
    await expect(tree.getByRole("treeitem", { name: /Branch A done/ })).toHaveCount(0);
    await branchPoint.press("ArrowRight");
    await expect(branchPoint).toHaveAttribute("aria-expanded", "true");
    await branchPoint.press("ArrowRight");
    await expect(tree.getByRole("treeitem", { name: /Implement branch A/ })).toBeFocused();

    const firstEntry = tree.getByRole("treeitem").first();
    await firstEntry.focus();
    await firstEntry.press("End");
    await expect(tree.getByRole("treeitem", { name: /Branch B done/ })).toBeFocused();
    await app.window.keyboard.press("ArrowUp");
    await expect(tree.getByRole("treeitem", { name: /Implement branch B/ })).toBeFocused();

    const compaction = tree.getByRole("treeitem", { name: /Compaction/ });
    await compaction.focus();
    await compaction.press("Enter");
    const label = inspector.getByRole("textbox", { name: "History label" });
    const saveLabel = inspector.getByRole("button", { name: "Save label" });
    const clearLabel = inspector.getByRole("button", { name: "Clear label" });
    await label.fill("Compact checkpoint");
    await label.press("Tab");
    await expect(saveLabel).toBeFocused();
    await saveLabel.press("Enter");
    await expect(compaction).toContainText("Compact checkpoint");
    await label.fill("Revised checkpoint");
    await label.press("Tab");
    await saveLabel.press("Enter");
    await expect(compaction).toContainText("Revised checkpoint");
    await label.focus();
    await label.press("Tab");
    await saveLabel.press("Tab");
    await expect(clearLabel).toBeFocused();
    await clearLabel.press("Enter");
    await expect(compaction).not.toContainText("Revised checkpoint");

    const branchA = tree.getByRole("treeitem", { name: /Branch A done/ });
    await branchA.focus();
    await branchA.press("Enter");
    await branchA.press("Tab");
    await expect(label).toBeFocused();
    await label.press("Tab");
    const summarizeBranch = inspector.getByRole("checkbox", { name: "Summarize abandoned branch" });
    await expect(summarizeBranch).toBeFocused();
    await summarizeBranch.press("Tab");
    const navigate = inspector.getByRole("button", { name: "Navigate here" });
    await expect(navigate).toBeFocused();
    await navigate.press("Enter");
    await expect(inspector.getByRole("status")).toContainText("History position changed");
    await expect(tree.getByRole("treeitem", { name: /Navigation point/ })).toContainText("Current leaf");
    await expect(tree.getByRole("treeitem", { name: /Branch A done/ })).toBeVisible();
    await expect(tree.getByRole("treeitem", { name: /Branch B done/ })).toBeVisible();

    const branchB = tree.getByRole("treeitem", { name: /Branch B done/ });
    await branchB.focus();
    await branchB.press("Enter");
    await branchB.press("Tab");
    await label.press("Tab");
    await expect(summarizeBranch).toBeFocused();
    await summarizeBranch.press("Space");
    await summarizeBranch.press("Tab");
    const summaryFocus = inspector.getByRole("textbox", { name: "Summary focus" });
    await expect(summaryFocus).toBeFocused();
    await summaryFocus.fill("Preserve the chosen approach");
    await summaryFocus.press("Tab");
    await expect(navigate).toBeFocused();
    await navigate.press("Enter");
    await expect(inspector.getByRole("status")).toContainText("History position changed");
    await expect(tree.getByRole("treeitem", { name: /Branch summary/ })).toContainText("Current leaf");
    await expect(tree.getByRole("treeitem", { name: /Branch A done/ })).toBeVisible();
    expect(provider.requests.some((request) => latestUserText(request).startsWith("<conversation>"))).toBe(true);

    const saved = await readFile(historyFile, "utf8");
    expect(saved).toContain('"type":"branch_summary"');
    expect(saved).toContain("Branch B done");
    expect(() => SessionManager.open(historyFile).getTree()).not.toThrow();
  } finally {
    await close(app);
    await provider.close();
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("forks prompts and clones active paths as standard Pi Tasks", async () => {
  const environment = await fixture();
  const historyFile = await writeBranchedHistory(environment.agentDir, environment.project);
  const app = await launch(environment.agentDir, false, { PILOT_TEST_PROJECT_DIR: environment.project });

  try {
    await app.window.getByRole("button", { name: "Add project" }).click();
    await app.window.getByRole("dialog", { name: "Project access" }).getByRole("button", { name: "Allow agent execution" }).click();
    const taskNavigation = app.window.getByRole("navigation", { name: "Projects and tasks" }).getByRole("list", { name: /Active Tasks in/ });
    await taskNavigation.getByRole("button", { name: "History fixture", exact: true }).click();

    const inspector = app.window.getByRole("complementary", { name: "Inspector" });
    await inspector.getByRole("tab", { name: /History/ }).click();
    const tree = inspector.getByRole("tree", { name: "Task history" });
    const branchPrompt = tree.getByRole("treeitem", { name: /Implement branch B/ });
    await branchPrompt.focus();
    await branchPrompt.press("Enter");
    await branchPrompt.press("Tab");
    const fork = inspector.getByRole("button", { name: "Fork from prompt" });
    await expect(fork).toBeFocused();
    await fork.press("Enter");
    await expect(taskNavigation.getByRole("button")).toHaveCount(3);
    await expect(app.window.getByRole("combobox", { name: "Prompt" })).toHaveValue("Implement branch B");

    const directory = sessionDirectory(environment.agentDir, environment.project);
    await expect.poll(() => childSession(directory, historyFile)).not.toBe("");
    const forkFile = await childSession(directory, historyFile);
    const forkContent = await readFile(forkFile, "utf8");
    expect(forkContent).toContain("Shared answer");
    expect(forkContent).not.toContain('"id":"branch-b-prompt"');

    const clone = inspector.getByRole("button", { name: "Clone active path" });
    await clone.focus();
    await clone.press("Enter");
    await expect(taskNavigation.getByRole("button")).toHaveCount(4);
    await expect.poll(() => childSession(directory, forkFile)).not.toBe("");
    const cloneFile = await childSession(directory, forkFile);
    const forkEntries = SessionManager.open(forkFile).getEntries();
    expect(SessionManager.open(cloneFile).getEntries().slice(0, forkEntries.length)).toEqual(forkEntries);

    for (const file of [historyFile, forkFile, cloneFile]) expect(() => SessionManager.open(file).getTree()).not.toThrow();
    expect(await readFile(historyFile, "utf8")).toContain("Branch B done");
  } finally {
    await close(app);
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
      google: {
        baseUrl: provider.baseUrl,
        api: "openai-completions",
        apiKey: "fixture-key",
        models: [{ id: "alternate-reasoning", name: "Alternate Reasoning" }],
      },
      locked: {
        baseUrl: provider.baseUrl,
        api: "openai-completions",
        models: [{ id: "locked-model", name: "Locked model" }],
      },
    },
  }));
  await writeFile(settingsPath, JSON.stringify({ defaultProvider: "fixture", defaultModel: "basic-model", defaultThinkingLevel: "high" }));
  await writeFile(path.join(environment.agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "fixture-secret" } }));
  const userData = path.join(environment.root, "pilot-user-data");
  const first = await launch(environment.agentDir, true, { PILOT_TEST_PROJECT_DIR: environment.project, PILOT_USER_DATA_DIR: userData });
  let taskFile = "";

  try {
    await first.window.getByRole("button", { name: "Add project" }).click();
    await first.window.getByRole("dialog", { name: "Project access" }).getByRole("button", { name: "Allow agent execution" }).click();
    await first.window.getByRole("button", { name: "New Task" }).click();

    const composer = first.window.getByRole("form", { name: "Task composer" });
    const modelControl = composer.getByRole("button", { name: /Provider and model/ });
    await expect(modelControl.locator(":scope > span").first()).toHaveText("Basic model");
    await expect(modelControl.locator('[data-provider-icon="generic"]')).toBeVisible();
    await expect(modelControl.locator('[role="tooltip"]')).toHaveCount(0);
    await modelControl.focus();
    await expect(modelControl).toBeFocused();
    const thinking = composer.getByRole("button", { name: /Thinking level/ });
    await expect(thinking).toBeDisabled();
    await expect(thinking).toContainText("Thinking · Off");

    await modelControl.press("Enter");
    const picker = first.window.getByRole("dialog", { name: "Choose model" });
    const providerRail = picker.getByRole("tablist", { name: "Available providers" });
    await expect(providerRail).toHaveAttribute("aria-orientation", "vertical");
    expect(await providerRail.evaluate((element) => ({
      overflowY: getComputedStyle(element).overflowY,
      scrollbarWidth: getComputedStyle(element).scrollbarWidth,
    }))).toEqual({ overflowY: "auto", scrollbarWidth: "auto" });
    await expect(picker.getByRole("tab")).toHaveCount(3);
    await expect(picker.getByRole("tab").nth(0)).toHaveAccessibleName("Anthropic (Claude Pro/Max)");
    await expect(picker.getByRole("tab").nth(1)).toHaveAccessibleName("Fixture");
    await expect(picker.getByRole("tab").nth(2)).toHaveAccessibleName("Google Gemini");
    const anthropicTab = picker.getByRole("tab", { name: "Anthropic (Claude Pro/Max)" });
    await expect(anthropicTab).toHaveAttribute("title", "Anthropic (Claude Pro/Max)");
    const anthropicIcon = anthropicTab.locator('[data-provider-icon="anthropic"]');
    await expect(anthropicIcon).toBeVisible();
    expect(await anthropicIcon.evaluate((element) => getComputedStyle(element).fill)).toBe("rgb(25, 25, 25)");
    await first.window.evaluate(() => { document.documentElement.dataset.appearance = "dark"; });
    expect(await anthropicIcon.evaluate((element) => getComputedStyle(element).fill)).toBe("rgb(242, 242, 239)");
    await first.window.evaluate(() => { document.documentElement.dataset.appearance = "light"; });
    await expect(picker.getByRole("tab", { name: "Google Gemini" }).locator('[data-provider-icon="generic"]')).toBeVisible();
    await expect(picker).not.toContainText("Locked");
    const search = picker.getByRole("combobox", { name: "Search models" });
    await expect(search).toBeFocused();
    await search.fill("altrsn");
    await expect(picker.getByRole("tab")).toHaveCount(0);
    const alternate = picker.getByRole("option", { name: /Alternate Reasoning/ });
    await expect(alternate).toContainText("Google Gemini");
    await expect(alternate.locator('[data-provider-icon="generic"]')).toBeVisible();
    await search.fill("");
    const fixtureTab = picker.getByRole("tab", { name: "Fixture" });
    const googleTab = picker.getByRole("tab", { name: "Google Gemini" });
    await search.press("Shift+Tab");
    await expect(fixtureTab).toBeFocused();
    await fixtureTab.press("ArrowDown");
    await expect(googleTab).toHaveAttribute("aria-selected", "true");
    await googleTab.press("ArrowUp");
    await expect(fixtureTab).toHaveAttribute("aria-selected", "true");
    await search.focus();
    await search.fill("rsng mdl");
    const reasoningModel = picker.getByRole("option", { name: /Reasoning model/ });
    await search.press("ArrowDown");
    await expect(reasoningModel).toBeFocused();
    await reasoningModel.press("Enter");
    await expect(picker).toBeHidden();
    await expect(modelControl.locator(":scope > span").first()).toHaveText("Reasoning model");
    await expect(modelControl.locator('[role="tooltip"]')).toHaveCount(0);
    await expect(thinking).toBeEnabled();
    await thinking.press("Enter");
    const thinkingPicker = first.window.getByRole("dialog", { name: "Choose thinking level" });
    await expect(thinkingPicker.getByRole("option").locator("strong")).toHaveText(["Off", "High", "Max"]);
    const maxThinking = thinkingPicker.getByRole("option", { name: "Max" });
    await maxThinking.focus();
    await maxThinking.press("Enter");
    await expect(thinkingPicker).toBeHidden();
    await expect(thinking).toContainText("Thinking · Max");

    const prompt = composer.getByRole("combobox", { name: "Prompt" });
    await prompt.fill("model controls stats");
    await composer.getByRole("button", { name: "Send" }).click();
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
    await expect(first.window.getByRole("form", { name: "Task composer" }).getByRole("button", { name: /Provider and model/ }).locator(":scope > span").first()).toHaveText("Basic model");
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
  await writeFile(path.join(environment.agentDir, "auth.json"), "{}");
  const second = await launch(environment.agentDir, true, { PILOT_USER_DATA_DIR: userData });
  try {
    await second.window.getByRole("list", { name: "Active Tasks in fixture-project" }).getByRole("button", { name: "model controls stats" }).click();
    const fallback = second.window.getByRole("status", { name: "Model fallback" });
    await expect(fallback).toContainText("Could not restore fixture/reasoning-model");
    await expect(fallback).toContainText("Using fixture/basic-model");
    const choose = fallback.getByRole("button", { name: "Choose another model" });
    await choose.focus();
    await choose.press("Enter");
    const fallbackPicker = second.window.getByRole("dialog", { name: "Choose model" });
    await expect(fallbackPicker.getByRole("tablist", { name: "Available providers" })).toHaveCount(0);
    const fallbackSearch = fallbackPicker.getByRole("combobox", { name: "Search models" });
    await expect(fallbackSearch).toBeFocused();
    await fallbackSearch.press("Escape");
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

test("projects Pi's automatic model before the first Run", async () => {
  const environment = await fixture();
  const provider = await deterministicProvider(environment.root);
  await writeFile(path.join(environment.agentDir, "models.json"), JSON.stringify({
    providers: {
      anthropic: {
        baseUrl: provider.baseUrl,
        api: "openai-completions",
        apiKey: "fixture-key",
        models: [
          { id: "claude-fable-5", name: "First registry model", contextWindow: 32_000, maxTokens: 1_000 },
          { id: "claude-opus-4-8", name: "Canonical Anthropic default", contextWindow: 32_000, maxTokens: 1_000 },
        ],
      },
    },
  }));
  await writeFile(path.join(environment.agentDir, "settings.json"), "{}");
  const app = await launch(environment.agentDir, false, { PILOT_TEST_PROJECT_DIR: environment.project });

  try {
    await app.window.getByRole("button", { name: "Add project" }).click();
    await app.window.getByRole("dialog", { name: "Project access" }).getByRole("button", { name: "Allow agent execution" }).click();
    await app.window.getByRole("button", { name: "New Task" }).click();
    const composer = app.window.getByRole("form", { name: "Task composer" });
    await expect(composer.getByRole("button", { name: /Provider and model/ })).toContainText("Canonical Anthropic default");
    const taskPath = await app.window.evaluate(async () => {
      const state = await (window as any).pilot.getProjects();
      return [...state.selected.tasks].sort((left: { modified: string }, right: { modified: string }) => right.modified.localeCompare(left.modified))[0].path as string;
    });
    expect((await readFile(taskPath, "utf8")).includes('"type":"model_change"')).toBe(false);

    await composer.getByRole("combobox", { name: "Prompt" }).fill("confirm automatic model");
    await composer.getByRole("button", { name: "Send" }).click();
    await expect(app.window.getByRole("region", { name: "Run timeline" })).toContainText("Settled");
    expect(provider.requests.some((body) => JSON.parse(body).model === "claude-opus-4-8")).toBe(true);
    expect((await readFile(taskPath, "utf8")).split("\n").some((line) => line && JSON.parse(line).type === "model_change" && JSON.parse(line).modelId === "claude-opus-4-8")).toBe(true);
  } finally {
    await close(app);
    await provider.close();
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("reads and durably writes canonical Pi agent defaults", async () => {
  const environment = await fixture();
  const settingsPath = path.join(environment.agentDir, "settings.json");
  await writeFile(path.join(environment.agentDir, "models.json"), JSON.stringify({
    providers: {
      fixture: {
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        apiKey: "fixture-key",
        models: [
          { id: "basic-model", name: "Basic model", contextWindow: 32_000, maxTokens: 1_000 },
          { id: "reasoning-model", name: "Reasoning model", reasoning: true, contextWindow: 32_000, maxTokens: 1_000 },
        ],
      },
    },
  }));
  await writeFile(settingsPath, JSON.stringify({
    defaultProvider: "fixture",
    defaultModel: "basic-model",
    defaultThinkingLevel: "low",
    enabledModels: ["fixture/basic-model:off"],
    retry: { enabled: false, maxRetries: 5, baseDelayMs: 750, provider: { maxRetries: 1, maxRetryDelayMs: 45_000 } },
    compaction: { enabled: false, reserveTokens: 4_096, keepRecentTokens: 8_192 },
    theme: "terminal-only",
  }));
  const app = await launch(environment.agentDir, false, { PILOT_TEST_PROJECT_DIR: environment.project });

  try {
    await app.window.getByRole("button", { name: "Settings" }).click();
    await app.window.getByRole("button", { name: "Agent" }).click();
    const settings = app.window.getByRole("region", { name: "Agent defaults" });
    const defaultModel = settings.getByRole("combobox", { name: "Default model" });
    const defaultThinking = settings.getByRole("combobox", { name: "Default thinking level" });
    const modelScope = settings.getByRole("textbox", { name: "Scoped model patterns" });
    const retry = settings.getByRole("checkbox", { name: "Automatic retry" });
    const maxRetries = settings.getByRole("spinbutton", { name: "Maximum retries" });
    const retryDelay = settings.getByRole("spinbutton", { name: "Base delay (milliseconds)" });
    const compaction = settings.getByRole("checkbox", { name: "Automatic compaction" });
    const recentTokens = settings.getByRole("spinbutton", { name: "Recent tokens to keep" });
    const reserveTokens = settings.getByRole("spinbutton", { name: "Reserved tokens" });

    await expect(defaultModel).toHaveValue("fixture/basic-model");
    await expect(defaultThinking).toHaveValue("low");
    await expect(modelScope).toHaveValue("fixture/basic-model:off");
    await expect(retry).not.toBeChecked();
    await expect(maxRetries).toHaveValue("5");
    await expect(retryDelay).toHaveValue("750");
    await expect(compaction).not.toBeChecked();
    await expect(recentTokens).toHaveValue("8192");
    await expect(reserveTokens).toHaveValue("4096");
    await expect(settings).toContainText(settingsPath);

    await defaultModel.selectOption("fixture/reasoning-model");
    await defaultThinking.selectOption("high");
    await modelScope.fill("fixture/reasoning-model:high\nfixture/basic-model");
    await settings.getByRole("button", { name: "Save model scope" }).click();

    await retry.check();
    await maxRetries.fill("7");
    await retryDelay.fill("1250");
    await mkdir(`${settingsPath}.lock`);
    await settings.getByRole("button", { name: "Save retry defaults" }).click();
    const error = settings.getByRole("alert");
    await expect(error).toContainText("Pi settings are locked by another process");
    await expect(retry).not.toBeChecked();
    await rm(`${settingsPath}.lock`, { recursive: true, force: true });
    await retry.check();
    await maxRetries.fill("7");
    await retryDelay.fill("1250");
    await settings.getByRole("button", { name: "Save retry defaults" }).click();
    await expect(error).toHaveCount(0);
    await compaction.check();
    await recentTokens.fill("12000");
    await reserveTokens.fill("6000");
    await settings.getByRole("button", { name: "Save compaction defaults" }).click();

    const saved = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(saved).toMatchObject({
      defaultProvider: "fixture",
      defaultModel: "reasoning-model",
      defaultThinkingLevel: "high",
      enabledModels: ["fixture/reasoning-model:high", "fixture/basic-model"],
      retry: { enabled: true, maxRetries: 7, baseDelayMs: 1_250, provider: { maxRetries: 1, maxRetryDelayMs: 45_000 } },
      compaction: { enabled: true, reserveTokens: 6_000, keepRecentTokens: 12_000 },
      theme: "terminal-only",
    });
    const desktopPreferences = JSON.parse(await readFile(path.join(environment.agentDir, "pilot-user-data", "preferences.json"), "utf8").catch(() => "{}"));
    expect(desktopPreferences).not.toHaveProperty("defaultModel");
    expect(desktopPreferences).not.toHaveProperty("enabledModels");
    expect(desktopPreferences).not.toHaveProperty("retry");
    expect(desktopPreferences).not.toHaveProperty("compaction");

    await writeFile(settingsPath, "{ malformed");
    await settings.getByRole("button", { name: "Reload Pi settings" }).click();
    await expect(error).toContainText("Pi settings could not be read");
    await expect(error).toContainText("settings.json");
    await writeFile(settingsPath, JSON.stringify(saved));
    await settings.getByRole("button", { name: "Reload Pi settings" }).click();
    await expect(error).toHaveCount(0);

    await app.window.getByRole("button", { name: "Back to command center" }).click();
    await app.window.getByRole("button", { name: "Add project" }).click();
    await app.window.getByRole("dialog", { name: "Project access" }).getByRole("button", { name: "Allow agent execution" }).click();
    await app.window.getByRole("button", { name: "New Task" }).click();
    const composer = app.window.getByRole("form", { name: "Task composer" });
    await expect(composer.getByRole("button", { name: /Provider and model/ })).toContainText("Reasoning model");
    await expect(composer.getByRole("button", { name: /Thinking level/ })).toContainText("Thinking · High");
  } finally {
    await close(app);
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("restores PiLot-owned desktop preferences without polluting Pi settings", async () => {
  const environment = await fixture();
  const userData = path.join(environment.root, "pilot-user-data");
  await mkdir(userData, { recursive: true });
  await writeFile(path.join(userData, "preferences.json"), JSON.stringify({
    window: { width: 860, height: 620, maximized: false },
  }));
  const first = await launch(environment.agentDir, false, { PILOT_USER_DATA_DIR: userData, PILOT_TEST_PROJECT_DIR: environment.project });
  let taskPath = "";

  try {
    await expect.poll(() => first.window.evaluate(() => [window.outerWidth, window.outerHeight])).toEqual([860, 620]);
    await first.window.getByRole("button", { name: "Settings" }).click();
    const settings = first.window.getByRole("main", { name: "Settings" });
    await expect(settings.getByRole("group", { name: "Appearance" }).getByRole("radio", { name: "System" })).toBeChecked();
    await settings.getByRole("radio", { name: "Dark" }).check();
    await settings.getByRole("checkbox", { name: "Run completed" }).check();
    await expect.poll(() => first.window.evaluate(() => getComputedStyle(document.documentElement).color)).toBe("rgb(232, 232, 229)");
    await expect(first.window.getByRole("button", { name: "General" })).toHaveAttribute("aria-current", "page");
    await first.window.getByRole("button", { name: "Providers" }).click();
    await expect(settings.getByRole("region", { name: "Provider authentication" })).toBeVisible();
    expect(await first.window.evaluate(() => {
      const background = (selector: string) => getComputedStyle(document.querySelector(selector)!).backgroundColor;
      return background(".provider-setup") === background(".settings-main");
    })).toBe(true);
    await first.window.getByRole("button", { name: "Back to command center" }).click();

    await first.window.getByRole("button", { name: "Add project" }).click();
    await first.window.getByRole("dialog", { name: "Project access" }).getByRole("button", { name: "Allow agent execution" }).click();
    await first.window.getByRole("button", { name: "New Task" }).click();
    await expect.poll(async () => JSON.parse(await readFile(path.join(userData, "preferences.json"), "utf8")).recentSelection?.taskPath ?? "").not.toBe("");
    taskPath = JSON.parse(await readFile(path.join(userData, "preferences.json"), "utf8")).recentSelection.taskPath;

    await first.window.evaluate(() => window.resizeTo(900, 640));
    await expect.poll(() => first.window.evaluate(() => [window.outerWidth, window.outerHeight])).toEqual([900, 640]);
    await first.window.getByRole("button", { name: "Command Palette" }).click();
    const palette = first.window.getByRole("dialog", { name: "Command Palette" });
    await palette.getByRole("combobox", { name: "Search actions" }).fill("show details");
    await palette.getByRole("option", { name: /Show Details/ }).click();
    const inspector = first.window.getByRole("complementary", { name: "Inspector" });
    await expect(inspector).toBeVisible();
    await inspector.getByRole("tab", { name: /Changes/ }).click();

    await expect.poll(async () => JSON.parse(await readFile(path.join(userData, "preferences.json"), "utf8"))).toMatchObject({
      appearance: "dark",
      globalRunCap: 4,
      notifications: { runCompleted: true, runFailed: true, attentionRequired: true },
      panes: { inspectorVisible: true, inspectorView: "changes" },
      recentSelection: { projectPath: await realpath(environment.project), taskPath },
      window: { width: 900, height: 640, maximized: false },
    });
  } finally {
    await close(first);
  }

  const second = await launch(environment.agentDir, false, { PILOT_USER_DATA_DIR: userData });
  try {
    await expect.poll(() => second.window.evaluate(() => [window.outerWidth, window.outerHeight])).toEqual([900, 640]);
    await second.window.getByRole("navigation", { name: "Projects and tasks" }).getByRole("button", { name: "fixture-project", exact: true }).click();
    await expect(second.window.getByRole("form", { name: "Task composer" })).toBeVisible();
    const inspector = second.window.getByRole("complementary", { name: "Inspector" });
    await expect(inspector).toBeVisible();
    await expect(inspector.getByRole("tab", { name: /Changes/ })).toHaveAttribute("aria-selected", "true");
    await second.window.getByRole("button", { name: "Settings" }).click();
    await expect(second.window.getByRole("radio", { name: "Dark" })).toBeChecked();
    await expect(second.window.getByRole("checkbox", { name: "Run completed" })).toBeChecked();
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

test("layers explicit Project overrides over the captured login environment", async () => {
  const environment = await fixture();
  const project = await realpath(environment.project);
  const provider = await deterministicProvider(environment.root);
  const loginHome = path.join(environment.root, "login home ü with spaces");
  const loginTools = path.join(loginHome, "bin");
  const projectTools = path.join(environment.root, "project tools");
  const projectEditor = path.join(projectTools, process.platform === "win32" ? "pilot-project-editor.cmd" : "pilot-project-editor");
  const capturedEditor = path.join(loginTools, process.platform === "win32" ? "pilot-captured-editor.cmd" : "pilot-captured-editor");
  const gitTrace = path.join(environment.root, "project-git.trace");
  const shell = getShellConfig();
  await Promise.all([mkdir(loginTools, { recursive: true }), mkdir(projectTools, { recursive: true })]);
  await Promise.all([
    writeFile(path.join(environment.agentDir, "models.json"), JSON.stringify({
      providers: {
        fixture: {
          baseUrl: provider.baseUrl,
          api: "openai-completions",
          apiKey: "fixture-key",
          models: [{ id: "fixture-model", name: "Fixture model", contextWindow: 32_000, maxTokens: 1_000 }],
        },
      },
    })),
    writeFile(path.join(environment.agentDir, "settings.json"), JSON.stringify({
      defaultProvider: "fixture",
      defaultModel: "fixture-model",
      shellPath: shell.shell,
      externalEditor: "pilot-captured-editor",
    })),
    writeFile(path.join(loginHome, ".bash_profile"), [
      "export PILOT_CAPTURED_ONLY=captured-from-login",
      "export PILOT_LAYERED=captured-base",
      "unset CAPTURE_SHOULD_UNSET",
      'export PATH="$HOME/bin:$PATH"',
      "",
    ].join("\n")),
    writeFile(path.join(loginTools, "pilot-login-tool"), "#!/usr/bin/env bash\nprintf tool-from-profile\n"),
    writeFile(capturedEditor, process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n"),
    writeFile(projectEditor, process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n"),
  ]);
  if (process.platform !== "win32") await Promise.all([
    chmod(path.join(loginTools, "pilot-login-tool"), 0o755),
    chmod(capturedEditor, 0o755),
    chmod(projectEditor, 0o755),
  ]);
  const app = await launch(environment.agentDir, false, {
    HOME: loginHome,
    SHELL: shell.shell,
    PILOT_TEST_PROJECT_DIR: environment.project,
    CAPTURE_UNICODE_HOST: "captured-工具-ü",
    CAPTURE_SHOULD_UNSET: "desktop-value",
  });

  try {
    await app.window.getByRole("button", { name: "Add project" }).click();
    await app.window.getByRole("dialog", { name: "Project access" }).getByRole("button", { name: "Allow agent execution" }).click();
    const capturedApplicationState = await app.window.evaluate(async () => {
      const pilot = (window as any).pilot;
      const selected = (await pilot.getProjects()).selected;
      return pilot.getApplicationState(selected.path, selected.tasks[0].path);
    });
    expect(capturedApplicationState.available).toContainEqual(expect.objectContaining({ id: "configured", label: "Pi configured editor" }));
    await writeFile(path.join(environment.agentDir, "settings.json"), JSON.stringify({
      defaultProvider: "fixture",
      defaultModel: "fixture-model",
      shellPath: shell.shell,
      externalEditor: "pilot-project-editor",
    }));

    await app.window.getByRole("button", { name: "Project actions" }).click();
    await app.window.getByRole("menuitem", { name: "Project access" }).click();
    const access = app.window.getByRole("dialog", { name: "Project access" });
    const overrides = access.getByRole("region", { name: "Project environment overrides" });
    await expect(overrides).toContainText("captured when PiLot opened");
    await overrides.getByRole("button", { name: "Add variable" }).click();
    const row = overrides.getByRole("listitem").last();
    await row.getByRole("textbox", { name: "Variable name" }).fill("PILOT_LAYERED");
    await row.getByRole("textbox", { name: "Variable value" }).fill("project-override");
    await overrides.getByRole("button", { name: "Add variable" }).click();
    const pathRow = overrides.getByRole("listitem").last();
    await pathRow.getByRole("textbox", { name: "Variable name" }).fill(process.platform === "win32" ? "pAtH" : "PATH");
    await pathRow.getByRole("textbox", { name: "Variable value" }).fill(`${projectTools}${path.delimiter}${loginTools}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ""}`);
    await overrides.getByRole("button", { name: "Add variable" }).click();
    const traceRow = overrides.getByRole("listitem").last();
    await traceRow.getByRole("textbox", { name: "Variable name" }).fill("GIT_TRACE");
    await traceRow.getByRole("textbox", { name: "Variable value" }).fill(gitTrace);
    await overrides.getByRole("button", { name: "Save environment" }).click();
    await expect(overrides.getByRole("status")).toHaveText("3 saved");
    await expect.poll(async () => JSON.parse(await readFile(path.join(environment.agentDir, "pilot-user-data", "projects.json"), "utf8")))
      .toMatchObject({ environmentOverrides: { [project]: { PILOT_LAYERED: "project-override", GIT_TRACE: gitTrace } } });
    await access.getByRole("button", { name: "Close project access" }).click();
    await expect(access).toHaveCount(0);

    await app.window.evaluate(async () => {
      const pilot = (window as any).pilot;
      const selected = (await pilot.getProjects()).selected;
      await pilot.getTaskCreation(selected.path);
    });
    await expect.poll(async () => readFile(gitTrace, "utf8").catch(() => "")).toContain("git");
    await app.window.getByRole("button", { name: "New Task" }).click();
    const applicationState = await app.window.evaluate(async () => {
      const pilot = (window as any).pilot;
      const selected = (await pilot.getProjects()).selected;
      return pilot.getApplicationState(selected.path, selected.tasks[0].path);
    });
    expect(applicationState.available).toContainEqual(expect.objectContaining({ id: "configured", label: "Pi configured editor" }));
    const composer = app.window.getByRole("form", { name: "Task composer" });
    await composer.getByRole("combobox", { name: "Prompt" }).fill("!printf '%s|%s|%s|%s|' \"$PILOT_CAPTURED_ONLY\" \"$PILOT_LAYERED\" \"$CAPTURE_UNICODE_HOST\" \"${CAPTURE_SHOULD_UNSET-unset}\"; pilot-login-tool");
    await composer.getByRole("button", { name: "Send" }).click();
    const timeline = app.window.getByRole("region", { name: "Run timeline" });
    await expect(timeline).toContainText("captured-from-login|project-override|captured-工具-ü|unset|tool-from-profile");
    await expect(timeline.getByRole("article").last()).toContainText("Settled");

    await writeFile(path.join(loginHome, ".bash_profile"), "export PILOT_CAPTURED_ONLY=changed-after-startup\n");
    await composer.getByRole("combobox", { name: "Prompt" }).fill("inspect project environment");
    await composer.getByRole("button", { name: "Send" }).click();
    const tool = timeline.locator('details[aria-label="bash tool, succeeded"]').last();
    await expect(tool).toBeVisible();
    await tool.locator("summary").click();
    await expect(tool).toContainText("captured-from-login|project-override|captured-工具-ü|unset|tool-from-profile");
    await expect(timeline).toContainText("Environment checked.");
  } finally {
    await close(app);
    await provider.close();
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("blocks a Run with actionable configured-shell guidance", async () => {
  const environment = await fixture();
  const provider = await deterministicProvider(environment.root);
  const missingShell = path.join(environment.root, "missing-bash");
  await Promise.all([
    writeFile(path.join(environment.agentDir, "models.json"), JSON.stringify({
      providers: {
        fixture: {
          baseUrl: provider.baseUrl,
          api: "openai-completions",
          apiKey: "fixture-key",
          models: [{ id: "fixture-model", name: "Fixture model", contextWindow: 32_000, maxTokens: 1_000 }],
        },
      },
    })),
    writeFile(path.join(environment.agentDir, "settings.json"), JSON.stringify({
      defaultProvider: "fixture",
      defaultModel: "fixture-model",
      shellPath: missingShell,
    })),
  ]);
  const app = await launch(environment.agentDir, false, { PILOT_TEST_PROJECT_DIR: environment.project });

  try {
    await app.window.getByRole("button", { name: "Add project" }).click();
    await app.window.getByRole("dialog", { name: "Project access" }).getByRole("button", { name: "Allow agent execution" }).click();
    await app.window.getByRole("button", { name: "New Task" }).click();
    const composer = app.window.getByRole("form", { name: "Task composer" });
    await composer.getByRole("combobox", { name: "Prompt" }).fill("This Run must not start");
    await composer.getByRole("button", { name: "Send" }).click();
    await expect(composer.getByRole("alert")).toContainText("configured Pi shell was not found");
    await expect(composer.getByRole("alert")).toContainText("shellPath");
    if (process.platform === "win32") await expect(composer.getByRole("alert")).toContainText("Git for Windows");
    await expect(app.window.getByRole("region", { name: "Run timeline" }).getByRole("article")).toHaveCount(0);
  } finally {
    await close(app);
    await provider.close();
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("cleans up an inline command process tree before quitting", async () => {
  const environment = await fixture();
  const provider = await deterministicProvider(environment.root);
  const project = await realpath(environment.project);
  const shell = getShellConfig();
  await Promise.all([
    writeFile(path.join(environment.agentDir, "models.json"), JSON.stringify({
      providers: {
        fixture: {
          baseUrl: provider.baseUrl,
          api: "openai-completions",
          apiKey: "fixture-key",
          models: [{ id: "fixture-model", name: "Fixture model", contextWindow: 32_000, maxTokens: 1_000 }],
        },
      },
    })),
    writeFile(path.join(environment.agentDir, "settings.json"), JSON.stringify({
      defaultProvider: "fixture",
      defaultModel: "fixture-model",
      shellPath: shell.shell,
    })),
  ]);
  const app = await launch(environment.agentDir, false, { PILOT_TEST_PROJECT_DIR: environment.project });
  let quit = false;

  try {
    await app.window.getByRole("button", { name: "Add project" }).click();
    await app.window.getByRole("dialog", { name: "Project access" }).getByRole("button", { name: "Allow agent execution" }).click();
    await app.window.getByRole("button", { name: "New Task" }).click();
    const composer = app.window.getByRole("form", { name: "Task composer" });
    await composer.getByRole("combobox", { name: "Prompt" }).fill("!(sleep 2; printf leaked > quit-descendant.txt) & wait");
    await composer.getByRole("button", { name: "Send" }).click();
    await expect(app.window.getByRole("region", { name: /Command:/ })).toContainText("Running");

    const exited = app.process.exitCode === null ? once(app.process, "exit") : undefined;
    if (process.platform === "darwin") app.process.kill("SIGTERM");
    else await app.window.evaluate(() => window.close());
    if (exited) await exited;
    await app.browser.close().catch(() => undefined);
    quit = true;

    await new Promise((resolve) => setTimeout(resolve, 2_300));
    expect(await readFile(path.join(project, "quit-descendant.txt"), "utf8").catch(() => "")).toBe("");
    const directory = sessionDirectory(environment.agentDir, project);
    const file = path.join(directory, (await readdir(directory)).find((name) => name.endsWith(".jsonl"))!);
    const entries = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(entries.filter((entry) => entry.customType === "pilot.run").at(-1)?.data.outcome).toBe("aborted");
  } finally {
    if (!quit) await close(app);
    await provider.close();
    await rm(environment.root, { recursive: true, force: true });
  }
});
