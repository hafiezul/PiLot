import { SessionManager } from "@earendil-works/pi-coding-agent";
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
    await expect(app.window.getByRole("region", { name: "Run timeline" }).getByRole("article").last()).toContainText("Settled");
    expect(provider.requests.at(-1)).toContain("Project template says widget.");

    await prompt.fill("/skill:project");
    const skillCompletion = composer.getByRole("listbox", { name: "Resource completion" });
    await expect(skillCompletion.getByRole("option", { name: /skill:project-skill/ })).toContainText("Project");
    await prompt.press("Enter");
    await expect(prompt).toHaveValue("/skill:project-skill ");
    await prompt.fill("/skill:project-skill audit now");
    await composer.getByRole("button", { name: "Send" }).click();
    await expect(app.window.getByRole("region", { name: "Run timeline" }).getByRole("article").last()).toContainText("Settled");
    expect(provider.requests.at(-1)).toContain("Project skill instructions.");
    expect(provider.requests.at(-1)).toContain("audit now");
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

    await prompt.fill("Inspect the attached images");
    await composer.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => provider.requests.length).toBe(3);
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
    await abortComposer.getByRole("combobox", { name: "Prompt" }).fill("run abort tool");
    await abortComposer.getByRole("button", { name: "Send" }).click();
    const abortRun = app.window.getByRole("region", { name: "Run timeline" });
    await expect(abortRun.locator('details[aria-label="bash tool, running"]')).toBeVisible();
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
    await commandComposer.getByRole("combobox", { name: "Prompt" }).fill("!sleep 5");
    await commandComposer.getByRole("button", { name: "Send" }).click();
    const commandRun = app.window.getByRole("region", { name: "Run timeline" });
    await expect(commandRun.getByRole("region", { name: "Command: sleep 5" })).toContainText("Running");
    await commandComposer.getByRole("button", { name: "Stop Run" }).click();
    await expect(commandRun).toContainText("Aborted");

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
        .find((entry) => entry.customType === "pilot.run")?.data.outcome));
    expect(outcomes.sort()).toEqual(["aborted", "aborted", "aborted", "settled"]);
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
  const environment = await fixture();
  const provider = await deterministicProvider(environment.root);
  const executionPath = await realpath(environment.project);
  const sourceDirectory = path.join(environment.project, "src");
  const editorScript = path.join(environment.root, "editor.mjs");
  const editorLog = path.join(environment.root, "editor.log");
  const generatedContent = Array.from({ length: 1_500 }, (_, index) => `export const generated${index} = ${index};`).join("\n") + "\n";
  await mkdir(sourceDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(sourceDirectory, "app.ts"), "export const value = 1;\nkeep\n"),
    writeFile(path.join(sourceDirectory, "a[1].ts"), "export const bracket = 1;\n"),
    writeFile(path.join(sourceDirectory, "a1.ts"), "export const plain = 1;\n"),
    writeFile(path.join(sourceDirectory, "old-name.ts"), "export const renamed = true;\n"),
    writeFile(path.join(sourceDirectory, "mode.sh"), "#!/bin/sh\necho ready\n"),
    writeFile(path.join(environment.project, "obsolete.txt"), "remove me\n"),
    writeFile(editorScript, `import { appendFileSync } from "node:fs";\nappendFileSync(process.argv[2], process.argv[3] + "\\n");\n`),
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
  const app = await launch(environment.agentDir, false, { PILOT_TEST_PROJECT_DIR: environment.project });

  try {
    await app.window.getByRole("button", { name: "Add project" }).click();
    await app.window.getByRole("dialog", { name: "Project access" }).getByRole("button", { name: "Allow agent execution" }).click();
    await app.window.getByRole("button", { name: "New Task" }).click();
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

    await changes.getByRole("button", { name: "Open src/generated.ts in editor" }).click();
    await changes.getByRole("button", { name: "Open execution location in editor" }).click();
    await expect.poll(async () => (await readFile(editorLog, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).sort()).toEqual([
      path.join(executionPath, "src", "generated.ts"),
      executionPath,
    ].sort());
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
