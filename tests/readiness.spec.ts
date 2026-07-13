import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

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
  return { agentDir, root };
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
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
    env: { ...env, ...extraEnv, PI_CODING_AGENT_DIR: agentDir },
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
  await app.browser.close();
  app.process.kill();
}

test("launches a sandboxed command center from the canonical Pi environment", async () => {
  const environment = await fixture();
  const app = await launch(environment.agentDir);

  try {
    await expect(app.window).toHaveTitle("PiLot");
    await expect(app.window.getByRole("navigation", { name: "Projects and tasks" })).toContainText("fixture-project");
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

test("configures providers and persists the selected model in the shared Pi environment", async () => {
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
  let app = await launch(environment.agentDir, false, { OPENAI_API_KEY: "fixture-env-secret" });

  try {
    await app.window.getByRole("button", { name: "Providers and models" }).click();
    const setup = app.window.getByRole("region", { name: "Providers and models" });
    await expect(setup).toContainText("Anthropic");
    await expect(setup).toContainText("Stored API key");
    await expect(setup).toContainText("Environment");
    await expect(setup).toContainText("models.json");
    await expect(setup).not.toContainText("fixture-secret");
    await expect(setup).not.toContainText("fixture-env-secret");
    await expect(setup).not.toContainText("local-placeholder");

    await setup.getByLabel("Model").selectOption("fixture/fixture-model");
    await expect(setup).toContainText("Model saved");
    expect(JSON.parse(await readFile(path.join(environment.agentDir, "settings.json"), "utf8"))).toMatchObject({
      defaultProvider: "fixture",
      defaultModel: "fixture-model",
    });

    await setup.getByLabel("Provider").selectOption("anthropic");
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

    await close(app);
    app = await launch(environment.agentDir, false, { OPENAI_API_KEY: "fixture-env-secret" });
    await app.window.getByRole("button", { name: "Providers and models" }).click();
    await expect(app.window.getByLabel("Model", { exact: true })).toHaveValue("fixture/fixture-model");
  } finally {
    await close(app);
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("shows only actionable readiness gaps", async () => {
  const environment = await fixture(99);
  await rm(path.join(environment.agentDir, "auth.json"));
  await writeFile(path.join(environment.agentDir, "settings.json"), JSON.stringify({ shellPath: path.join(environment.root, "missing-bash") }));
  const app = await launch(environment.agentDir, true);

  try {
    const readiness = app.window.getByRole("region", { name: "Readiness" });
    await expect(readiness).toContainText("Connect a provider");
    await expect(readiness).toContainText("Install a compatible Bash shell");
    await expect(readiness).toContainText("Update PiLot to open newer tasks");
    await expect(readiness).not.toContainText("Pi environment");
    await readiness.focus();
    await expect(readiness).toBeFocused();
  } finally {
    await close(app);
    await rm(environment.root, { recursive: true, force: true });
  }
});
