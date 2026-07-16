import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createServer as createPortServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const appPath = path.resolve(import.meta.dirname, "..");
const electronPath = createRequire(import.meta.url)("electron") as string;

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

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "pilot-provider-"));
  const agentDir = path.join(root, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, "auth.json"), "{}");
  return { agentDir, root };
}

async function launch(agentDir: string, extraEnv: Record<string, string> = {}): Promise<{ browser: Browser; process: ChildProcess; window: Page }> {
  const port = await availablePort();
  const testHome = path.join(agentDir, "pilot-test-home");
  await mkdir(testHome, { recursive: true });
  const child = spawn(electronPath, [
    appPath,
    `--pilot-debug-port=${port}`,
    "--pilot-test-hidden",
    ...(extraEnv.PILOT_TEST_PROVIDER_AUTH ? ["--pilot-test-provider-auth"] : []),
    ...(extraEnv.PILOT_TEST_RECREATE_WINDOW === "1" ? ["--pilot-test-lifecycle"] : []),
  ], {
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(_API_KEY|_TOKEN|_CREDENTIALS?)$/.test(name))),
      HOME: testHome,
      PILOT_USER_DATA_DIR: path.join(agentDir, "pilot-user-data"),
      PI_CODING_AGENT_DIR: agentDir,
      ...extraEnv,
    },
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
    throw new Error("PiLot did not open its provider-test connection");
  }
  const context = browser.contexts()[0];
  const window = context.pages()[0] ?? await context.waitForEvent("page");
  return { browser, process: child, window };
}

async function close(application: { browser: Browser; process: ChildProcess }) {
  const exit = application.process.exitCode === null ? once(application.process, "exit") : undefined;
  await application.browser.close();
  if (application.process.exitCode === null) application.process.kill();
  await exit;
}

async function openProviderSettings(page: Page) {
  await page.getByRole("button", { name: "Settings" }).click();
  const settings = page.getByRole("main", { name: "Settings" });
  await page.getByRole("button", { name: "Providers" }).click();
  return settings.getByRole("region", { name: "Provider authentication" });
}

function expectOAuthCredentialShape(value: unknown) {
  expect(value).toMatchObject({ type: "oauth" });
  const credential = value as Record<string, unknown>;
  expect(Object.keys(credential).sort()).toEqual(["access", "expires", "refresh", "type"]);
  expect(typeof credential.access).toBe("string");
  expect(typeof credential.refresh).toBe("string");
  expect(credential.expires).toEqual(expect.any(Number));
  expect(credential.expires as number).toBeGreaterThan(Date.now());
}

test("keeps provider login single-flight and cancellable", async () => {
  const environment = await fixture();
  const application = await launch(environment.agentDir, { PILOT_TEST_PROVIDER_AUTH: "select" });

  try {
    const setup = await openProviderSettings(application.window);
    await setup.getByLabel("Provider").selectOption("pilot-test-oauth");
    await setup.getByRole("button", { name: "Use subscription" }).click();
    await expect(setup.getByRole("region", { name: /authentication/i })).toContainText("Choose a fixture account");
    await expect(setup.getByRole("status", { name: "Authentication status" })).toContainText(/Authentication in progress.*PiLot OAuth Fixture/i);

    const competingStart = await application.window.evaluate(async () => {
      const login = (window as any).pilot.login("anthropic").then(
        () => "started",
        (reason: unknown) => reason instanceof Error ? reason.message : String(reason),
      );
      return Promise.race([login, new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 500))]);
    });
    expect(competingStart).toMatch(/already.*in progress.*cancel/i);

    await setup.getByRole("button", { name: "Cancel authentication" }).click();
    await expect(setup.getByRole("status", { name: "Authentication status" })).toContainText("Authentication cancelled");
    await expect(setup.getByRole("region", { name: /authentication/i })).toHaveCount(0);

    await setup.getByRole("button", { name: "Use subscription" }).click();
    const retry = setup.getByRole("region", { name: /authentication/i });
    await expect(retry).toContainText("Choose a fixture account");
    await retry.getByRole("button", { name: "Team account" }).click();
    await expect(setup.getByRole("status", { name: "Authentication status" })).toContainText("Signed in to PiLot OAuth Fixture");
  } finally {
    await close(application);
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("scopes prompt replies and persists completed credentials without exposing secrets", async () => {
  const environment = await fixture();
  const application = await launch(environment.agentDir, { PILOT_TEST_PROVIDER_AUTH: "prompt" });
  const authFile = path.join(environment.agentDir, "auth.json");

  try {
    await application.window.evaluate(() => {
      (window as any).__providerAuthEvents = [];
      (window as any).pilot.onOAuthEvent((event: unknown) => (window as any).__providerAuthEvents.push(event));
    });
    const setup = await openProviderSettings(application.window);
    await setup.getByLabel("Provider").selectOption("pilot-test-oauth");
    await setup.getByRole("button", { name: "Use subscription" }).click();
    const prompt = setup.getByRole("region", { name: "PiLot OAuth Fixture authentication" });
    await expect(prompt).toContainText("Enter the fixture authorization code");
    await prompt.getByLabel("Enter the fixture authorization code").fill("user-entered-secret");
    const request = await application.window.evaluate(() => {
      const events = (window as any).__providerAuthEvents as Array<Record<string, string>>;
      return events.find(({ type }) => type === "prompt");
    });
    await prompt.getByRole("button", { name: "Continue" }).click();

    await expect(setup.getByRole("status", { name: "Authentication status" })).toContainText("Signed in to PiLot OAuth Fixture");
    await expect(application.window.locator("body")).not.toContainText("user-entered-secret");
    const savedBytes = await readFile(authFile, "utf8");
    const credential = JSON.parse(savedBytes)["pilot-test-oauth"];
    expectOAuthCredentialShape(credential);

    expect(await application.window.evaluate(async ({ flowId, requestId }) =>
      (window as any).pilot.respondToOAuth(flowId, requestId, "stale-secret"), request)).toBe(false);
    expect(await readFile(authFile, "utf8")).toBe(savedBytes);
    await expect(application.window.locator("body")).not.toContainText("stale-secret");
  } finally {
    await close(application);
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("ignores stale flow and request replies without disturbing the active prompt", async () => {
  const environment = await fixture();
  const application = await launch(environment.agentDir, { PILOT_TEST_PROVIDER_AUTH: "prompt" });
  const authFile = path.join(environment.agentDir, "auth.json");

  try {
    await application.window.evaluate(() => {
      (window as any).__providerAuthEvents = [];
      (window as any).pilot.onOAuthEvent((event: unknown) => (window as any).__providerAuthEvents.push(event));
    });
    const setup = await openProviderSettings(application.window);
    await setup.getByLabel("Provider").selectOption("pilot-test-oauth");
    await setup.getByRole("button", { name: "Use subscription" }).click();
    await expect(setup.getByRole("region", { name: "PiLot OAuth Fixture authentication" })).toBeVisible();
    const firstRequest = await application.window.evaluate(() =>
      ((window as any).__providerAuthEvents as Array<Record<string, string>>).find(({ type }) => type === "prompt"));
    await setup.getByRole("button", { name: "Cancel authentication" }).click();

    await setup.getByRole("button", { name: "Use subscription" }).click();
    const prompt = setup.getByRole("region", { name: "PiLot OAuth Fixture authentication" });
    await expect(prompt).toBeVisible();
    const secondRequest = await application.window.evaluate(() =>
      ((window as any).__providerAuthEvents as Array<Record<string, string>>).filter(({ type }) => type === "prompt").at(-1));
    expect(secondRequest.flowId).not.toBe(firstRequest.flowId);
    expect(await application.window.evaluate(({ flowId, requestId }) =>
      (window as any).pilot.respondToOAuth(flowId, requestId, "stale-flow-secret"), firstRequest)).toBe(false);
    expect(await application.window.evaluate(({ flowId, requestId }) =>
      (window as any).pilot.respondToOAuth(flowId, `${requestId}-stale`, "stale-request-secret"), secondRequest)).toBe(false);
    await expect(prompt).toBeVisible();
    expect(await readFile(authFile, "utf8")).toBe("{}");

    await prompt.getByLabel("Enter the fixture authorization code").fill("current-code");
    await prompt.getByRole("button", { name: "Continue" }).click();
    await expect(setup.getByRole("status", { name: "Authentication status" })).toContainText("Signed in to PiLot OAuth Fixture");
    await expect(application.window.locator("body")).not.toContainText(/stale-(flow|request)-secret/);
  } finally {
    await close(application);
    await rm(environment.root, { recursive: true, force: true });
  }
});

for (const scenario of [
  { fixture: "browser", title: "browser callback", detail: "Complete the deterministic browser callback" },
  { fixture: "device", title: "device code", detail: "PILOT-TEST" },
] as const) {
  test(`completes the deterministic ${scenario.title} provider path`, async () => {
    const environment = await fixture();
    const application = await launch(environment.agentDir, { PILOT_TEST_PROVIDER_AUTH: scenario.fixture });

    try {
      const setup = await openProviderSettings(application.window);
      await setup.getByLabel("Provider").selectOption("pilot-test-oauth");
      await setup.getByRole("button", { name: "Use subscription" }).click();
      const flow = setup.getByRole("region", { name: "PiLot OAuth Fixture authentication" });
      await expect(flow).toContainText(scenario.detail);
      await expect(setup.getByRole("status", { name: "Authentication status" })).toContainText("Authentication in progress");
      await expect(setup.getByRole("status", { name: "Authentication status" })).toContainText("Signed in to PiLot OAuth Fixture", { timeout: 5_000 });
      const credential = JSON.parse(await readFile(path.join(environment.agentDir, "auth.json"), "utf8"))["pilot-test-oauth"];
      expectOAuthCredentialShape(credential);
    } finally {
      await close(application);
      await rm(environment.root, { recursive: true, force: true });
    }
  });
}

test("scopes a manual callback reply to its provider login", async () => {
  const environment = await fixture();
  const application = await launch(environment.agentDir, { PILOT_TEST_PROVIDER_AUTH: "manual" });

  try {
    const setup = await openProviderSettings(application.window);
    await setup.getByLabel("Provider").selectOption("pilot-test-oauth");
    await setup.getByRole("button", { name: "Use subscription" }).click();
    const callback = setup.getByRole("region", { name: "PiLot OAuth Fixture authentication" });
    await expect(callback).toContainText("Complete login in the browser or enter the manual code");
    await callback.getByLabel("Paste the redirect URL if the browser does not return automatically").fill("manual-user-secret");
    await callback.getByRole("button", { name: "Continue" }).click();

    await expect(setup.getByRole("status", { name: "Authentication status" })).toContainText("Signed in to PiLot OAuth Fixture");
    await expect(application.window.locator("body")).not.toContainText("manual-user-secret");
    const credential = JSON.parse(await readFile(path.join(environment.agentDir, "auth.json"), "utf8"))["pilot-test-oauth"];
    expectOAuthCredentialShape(credential);
  } finally {
    await close(application);
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("cancels provider login when leaving Providers or closing Settings", async () => {
  const environment = await fixture();
  const application = await launch(environment.agentDir, { PILOT_TEST_PROVIDER_AUTH: "prompt" });

  try {
    let setup = await openProviderSettings(application.window);
    await setup.getByLabel("Provider").selectOption("pilot-test-oauth");
    await application.window.evaluate(() => {
      const buttons = [...document.querySelectorAll("button")];
      const start = buttons.find(({ textContent }) => textContent === "Use subscription");
      const destination = buttons.find(({ textContent }) => textContent === "General");
      if (!start || !destination) throw new Error("Provider startup navigation controls are unavailable");
      start.click();
      destination.click();
    });
    await expect.poll(() => application.window.evaluate(() => (window as any).pilot.getProviderState().then((state: any) => Boolean(state.activeLogin)))).toBe(false);

    await application.window.getByRole("button", { name: "Providers" }).click();
    setup = application.window.getByRole("main", { name: "Settings" }).getByRole("region", { name: "Provider authentication" });
    await setup.getByLabel("Provider").selectOption("pilot-test-oauth");
    await application.window.evaluate(() => {
      const buttons = [...document.querySelectorAll("button")];
      const start = buttons.find(({ textContent }) => textContent === "Use subscription");
      const closeSettings = buttons.find(({ textContent }) => textContent?.includes("Command center"));
      if (!start || !closeSettings) throw new Error("Provider startup close controls are unavailable");
      start.click();
      closeSettings.click();
    });
    await expect.poll(() => application.window.evaluate(() => (window as any).pilot.getProviderState().then((state: any) => Boolean(state.activeLogin)))).toBe(false);

    setup = await openProviderSettings(application.window);
    await setup.getByLabel("Provider").selectOption("pilot-test-oauth");
    await setup.getByRole("button", { name: "Use subscription" }).click();
    await expect(setup.getByRole("region", { name: "PiLot OAuth Fixture authentication" })).toBeVisible();
    await setup.getByRole("button", { name: "Cancel authentication" }).click();
  } finally {
    await close(application);
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("clears provider login when its window is destroyed so a new window can retry", async () => {
  const environment = await fixture();
  const application = await launch(environment.agentDir, {
    PILOT_TEST_PROVIDER_AUTH: "prompt",
    PILOT_TEST_RECREATE_WINDOW: "1",
  });

  try {
    let setup = await openProviderSettings(application.window);
    await setup.getByLabel("Provider").selectOption("pilot-test-oauth");
    await setup.getByRole("button", { name: "Use subscription" }).click();
    await expect(setup.getByRole("region", { name: "PiLot OAuth Fixture authentication" })).toBeVisible();

    const replacementWindow = application.browser.contexts()[0].waitForEvent("page");
    await application.window.evaluate(() => (window as any).pilot.recreateWindow());
    application.window = await replacementWindow;
    await expect(application.window.getByRole("button", { name: "Settings" })).toBeVisible();
    expect(await application.window.evaluate(() => (window as any).pilot.getProviderState().then((state: any) => state.activeLogin))).toBeUndefined();

    setup = await openProviderSettings(application.window);
    await setup.getByLabel("Provider").selectOption("pilot-test-oauth");
    await setup.getByRole("button", { name: "Use subscription" }).click();
    const prompt = setup.getByRole("region", { name: "PiLot OAuth Fixture authentication" });
    await prompt.getByLabel("Enter the fixture authorization code").fill("new-window-code");
    await prompt.getByRole("button", { name: "Continue" }).click();
    await expect(setup.getByRole("status", { name: "Authentication status" })).toContainText("Signed in to PiLot OAuth Fixture");
  } finally {
    await close(application);
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("clears provider failures so a later retry can succeed", async () => {
  const environment = await fixture();
  const application = await launch(environment.agentDir, { PILOT_TEST_PROVIDER_AUTH: "failure-once" });

  try {
    const setup = await openProviderSettings(application.window);
    await setup.getByLabel("Provider").selectOption("pilot-test-oauth", { timeout: 2_000 });
    const start = setup.getByRole("button", { name: "Use subscription" });
    await start.click();
    await expect(setup.getByRole("alert")).toContainText("Fixture provider rejected authentication");
    expect(await application.window.evaluate(() => (window as any).pilot.getProviderState().then((state: any) => state.activeLogin))).toBeUndefined();
    await expect(start).toBeEnabled();

    await start.click();
    const prompt = setup.getByRole("region", { name: "PiLot OAuth Fixture authentication" });
    await prompt.getByLabel("Enter the fixture authorization code").fill("retry-code");
    await prompt.getByRole("button", { name: "Continue" }).click();
    await expect(setup.getByRole("status", { name: "Authentication status" })).toContainText("Signed in to PiLot OAuth Fixture");
  } finally {
    await close(application);
    await rm(environment.root, { recursive: true, force: true });
  }
});
