import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
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
  return { agentDir, root };
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
  const exit = app.process.exitCode === null ? once(app.process, "exit") : undefined;
  app.process.kill();
  await exit;
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

test("loads the renderer from Vite during development", async () => {
  const environment = await fixture();
  const server = await createServer();
  let app: Awaited<ReturnType<typeof launch>> | undefined;

  try {
    await server.listen();
    app = await launch(environment.agentDir, false, { PILOT_DEV_SERVER: "1" });
    await expect(app.window).toHaveURL("http://127.0.0.1:5173/");
    await expect(app.window.locator('script[src*="/@vite/client"]')).toHaveCount(1);
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
    expect(JSON.parse(await readFile(path.join(userData, "preferences.json"), "utf8"))).toEqual({ appearance: "dark" });
    expect(JSON.parse(await readFile(path.join(environment.agentDir, "settings.json"), "utf8").catch(() => "{}"))).toEqual({});
  } finally {
    await close(second);
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

    const projectAccess = first.window.getByRole("region", { name: "Project access" });
    await expect(projectAccess).toContainText(project);
    await expect(projectAccess.getByRole("status", { name: "Pi resource trust" })).toContainText("Not decided");
    await expect(projectAccess.getByRole("status", { name: "Agent execution" })).toContainText("Not granted");
    await expect(projectAccess).toContainText("Prompts and setup commands are blocked");

    const trust = projectAccess.getByRole("button", { name: "Trust project resources", exact: true });
    await trust.focus();
    await trust.press("Enter");
    await expect(projectAccess.getByRole("status", { name: "Pi resource trust" })).toContainText("Trusted");
    expect(JSON.parse(await readFile(path.join(environment.agentDir, "trust.json"), "utf8"))[canonicalProject]).toBe(true);

    await projectAccess.getByRole("button", { name: "Allow agent execution" }).click();
    await expect(projectAccess.getByRole("status", { name: "Agent execution" })).toContainText("Granted");
    expect(JSON.parse(await readFile(path.join(userData, "projects.json"), "utf8")).executionConsent[canonicalProject]).toBe(true);

    await projectAccess.getByRole("button", { name: "Revoke agent execution" }).click();
    await expect(projectAccess.getByRole("status", { name: "Agent execution" })).toContainText("Not granted");
    await expect(projectAccess.getByRole("status", { name: "Pi resource trust" })).toContainText("Trusted");
    expect(JSON.parse(await readFile(path.join(environment.agentDir, "trust.json"), "utf8"))[canonicalProject]).toBe(true);
  } finally {
    await close(first);
  }

  const second = await launch(environment.agentDir, false, { PILOT_USER_DATA_DIR: userData });
  try {
    await expect(second.window.getByRole("navigation", { name: "Projects and tasks" })).toContainText("picked-project");
    const projectAccess = second.window.getByRole("region", { name: "Project access" });
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
