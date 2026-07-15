import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const appPath = path.resolve(import.meta.dirname, "..");
const electronPath = createRequire(import.meta.url)("electron") as string;

const privateContent = {
  secret: "sk-private-diagnostic-secret",
  transcript: "PRIVATE TRANSCRIPT: diagnose the unreleased feature",
  source: "PRIVATE SOURCE: export const customerSecret = true;",
  diff: "PRIVATE DIFF: -internal +confidential",
  shell: "PRIVATE SHELL FAILURE: /customers/acme/bootstrap.sh",
  recovery: "PRIVATE RECOVERY JOURNAL: /customers/acme/worktree",
};

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

type RunningApp = { browser: Browser; process: ChildProcess; window: Page };

async function launch(
  agentDir: string,
  userData: string,
  shellPath: string,
  exportDirectory: string,
  networkGuardPath: string,
  networkLogPath: string,
  networkGuardReadyPath: string,
): Promise<RunningApp> {
  const port = await availablePort();
  const home = path.join(path.dirname(agentDir), "private-home");
  await mkdir(home, { recursive: true });
  const requireNetworkGuard = `--require=${JSON.stringify(networkGuardPath)}`;
  const child = spawn(electronPath, [
    "--host-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    appPath,
    `--pilot-debug-port=${port}`,
    "--pilot-test-hidden",
  ], {
    env: {
      ...process.env,
      HOME: home,
      SHELL: shellPath,
      PI_CODING_AGENT_DIR: agentDir,
      PI_TELEMETRY: "1",
      PILOT_USER_DATA_DIR: userData,
      PILOT_TEST_DIAGNOSTICS_EXPORT_DIR: exportDirectory,
      PILOT_TEST_NETWORK_LOG: networkLogPath,
      PILOT_TEST_NETWORK_GUARD_READY: networkGuardReadyPath,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, requireNetworkGuard].filter(Boolean).join(" "),
    },
    stdio: "ignore",
  });
  const endpoint = `http://127.0.0.1:${port}`;
  let browser: Browser | undefined;
  for (let attempt = 0; attempt < 200 && !browser; attempt += 1) {
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

async function close(app: RunningApp) {
  const exit = app.process.exitCode === null ? once(app.process, "exit") : undefined;
  await app.browser.close();
  if (app.process.exitCode === null) app.process.kill();
  await exit;
}

function sessionDirectory(agentDir: string, project: string) {
  const encoded = path.resolve(project).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
  return path.join(agentDir, "sessions", `--${encoded}--`);
}

test("previews and explicitly exports bounded privacy-safe diagnostics while offline", async () => {
  test.setTimeout(60_000);
  const root = await mkdtemp(path.join(tmpdir(), "pilot-diagnostics-private-"));
  const agentDir = path.join(root, ".pi", "agent");
  const userData = path.join(root, "pilot-user-data");
  const projectDirectory = path.join(root, "PRIVATE-PROJECT-PATH");
  const shellPath = path.join(root, "private-login-shell.sh");
  const networkGuardPath = path.join(root, "network-guard.cjs");
  const networkLogPath = path.join(root, "network-attempts.log");
  const networkGuardReadyPath = path.join(root, "network-guard-ready.log");
  const recoveryDirectory = path.join(userData, "pending-worktree-removals");
  await mkdir(agentDir, { recursive: true });
  await mkdir(userData, { recursive: true });
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(recoveryDirectory, { recursive: true });
  const project = await realpath(projectDirectory);
  const settingsPath = path.join(agentDir, "settings.json");
  const sessionPath = path.join(sessionDirectory(agentDir, project), "private-task.jsonl");
  await mkdir(path.dirname(sessionPath), { recursive: true });
  await Promise.all([
    writeFile(path.join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: privateContent.secret } })),
    writeFile(settingsPath, JSON.stringify({ enableInstallTelemetry: true })),
    writeFile(path.join(project, "private-source.ts"), `${privateContent.source}\n${privateContent.diff}\n`),
    writeFile(sessionPath, [
      JSON.stringify({ type: "session", version: 999, id: "private-task", timestamp: "2026-01-01T00:00:00.000Z", cwd: project }),
      JSON.stringify({ type: "message", id: "private-message", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: privateContent.transcript } }),
    ].join("\n") + "\n"),
    writeFile(path.join(userData, "projects.json"), JSON.stringify({
      recentProjects: [project],
      selectedProject: project,
      executionConsent: { [project]: true },
      setupCommands: {},
      environmentOverrides: {},
    })),
    writeFile(shellPath, `#!/bin/sh\nprintf '%s\\n' '${privateContent.shell}' >&2\nexit 23\n`),
    writeFile(path.join(recoveryDirectory, "PRIVATE-RECOVERY-JOURNAL.json"), privateContent.recovery),
    writeFile(networkGuardPath, `
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.PILOT_TEST_NETWORK_GUARD_READY, "ready\\n");
const originalFetch = globalThis.fetch;
if (typeof originalFetch === "function" && !globalThis.__pilotNetworkGuardInstalled) {
  globalThis.__pilotNetworkGuardInstalled = true;
  globalThis.fetch = async (input) => {
    const target = typeof input === "string" ? input : input && typeof input.url === "string" ? input.url : "unknown";
    appendFileSync(process.env.PILOT_TEST_NETWORK_LOG, target + "\\n");
    throw new Error("Network access is disabled by the PiLot diagnostics test");
  };
}
`),
  ]);
  await chmod(shellPath, 0o700);

  let first: RunningApp | undefined;
  let second: RunningApp | undefined;
  try {
    first = await launch(agentDir, userData, shellPath, root, networkGuardPath, networkLogPath, networkGuardReadyPath);
    await first.window.evaluate(async ({ secret }) => {
      const pilot = (window as any).pilot;
      await Promise.all(Array.from({ length: 900 }, () => pilot.setApiKey("", secret).catch(() => undefined)));
    }, { secret: privateContent.secret });
    await close(first);
    first = undefined;

    second = await launch(agentDir, userData, shellPath, root, networkGuardPath, networkLogPath, networkGuardReadyPath);
    const networkRequests: string[] = [];
    second.window.on("request", (request) => {
      if (/^https?:/i.test(request.url())) networkRequests.push(request.url());
    });

    await mkdir(`${settingsPath}.lock`);
    const failures = await second.window.evaluate(async ({ projectPath, taskPath, source, transcript, secret }) => {
      const pilot = (window as any).pilot;
      const capture = async (operation: Promise<unknown>) => operation.then(() => "", (reason) => reason instanceof Error ? reason.message : String(reason));
      const projects = await pilot.getProjects();
      return {
        projectDiagnostic: projects.selected?.diagnostics?.[0]?.title ?? "",
        settings: await capture(pilot.setAgentModelScope([source])),
        runtime: await capture(pilot.submitPrompt(projectPath, taskPath, transcript)),
        auth: await capture(pilot.setApiKey("", secret)),
      };
    }, {
      projectPath: project,
      taskPath: path.join(project, "PRIVATE-MISSING-TASK.jsonl"),
      source: privateContent.source,
      transcript: privateContent.transcript,
      secret: privateContent.secret,
    });
    await rm(`${settingsPath}.lock`, { recursive: true, force: true });
    expect(failures.projectDiagnostic).toContain("Update PiLot");
    expect(failures.settings).toContain("locked by another process");
    expect(failures.runtime).toBeTruthy();
    expect(failures.auth).toContain("Enter an API key");

    await second.window.getByRole("button", { name: "Settings" }).click();
    await second.window.getByRole("button", { name: "Diagnostics" }).click({ timeout: 5_000 });
    const diagnostics = second.window.getByRole("region", { name: "Diagnostic preview" });
    await expect(second.window.getByRole("heading", { name: "Diagnostics" })).toBeVisible();
    await expect(diagnostics).toContainText("Authentication");
    await expect(diagnostics).toContainText("Settings lock");
    await expect(diagnostics).toContainText("Session compatibility");
    await expect(diagnostics).toContainText("Runtime");
    await expect(diagnostics).toContainText("Shell");
    await expect(diagnostics).toContainText("Packaging");
    await expect(second.window.getByText(/no analytics/i)).toBeVisible();
    await expect(second.window.getByText(/no automatic crash uploads/i)).toBeVisible();
    await expect(second.window.getByText(/transcripts, source, paths, and diffs are excluded/i)).toBeVisible();

    await second.window.getByRole("button", { name: "Export diagnostic bundle" }).click();
    await expect(second.window.getByRole("status")).toContainText("Diagnostic bundle exported");
    const bundlePath = path.join(root, "pilot-diagnostics.json");
    await expect.poll(() => readFile(bundlePath, "utf8").catch(() => "")).toContain('"automaticCrashUploads": false');

    const bundleText = await readFile(bundlePath, "utf8");
    const bundle = JSON.parse(bundleText) as {
      privacy: { localOnly: boolean; analytics: boolean; automaticCrashUploads: boolean; excludedContent: string[] };
      events: Array<{ category: string; summary: string; guidance: string; operation: string; code?: string }>;
    };
    expect(bundle.privacy).toEqual({
      localOnly: true,
      analytics: false,
      automaticCrashUploads: false,
      excludedContent: ["secrets", "Task transcripts", "source content", "file and Project paths", "diff content"],
    });
    expect(new Set(bundle.events.map(({ category }) => category))).toEqual(new Set([
      "auth", "settings-lock", "session-compatibility", "runtime", "shell", "packaging",
    ]));
    for (const event of bundle.events) {
      expect(event.summary).toBeTruthy();
      expect(event.guidance).toBeTruthy();
      expect(event.operation).toMatch(/^[a-z][a-z0-9.-]+$/);
    }

    const diagnosticDirectory = path.join(userData, "diagnostics");
    const logNames = (await readdir(diagnosticDirectory)).filter((name) => name.endsWith(".jsonl")).sort();
    expect(logNames.length).toBeGreaterThanOrEqual(2);
    expect(logNames.length).toBeLessThanOrEqual(3);
    for (const name of logNames) {
      const metadata = await stat(path.join(diagnosticDirectory, name));
      expect(metadata.size).toBeLessThanOrEqual(64 * 1024);
      if (process.platform !== "win32") expect(metadata.mode & 0o777).toBe(0o600);
    }
    if (process.platform !== "win32") {
      expect((await stat(diagnosticDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(bundlePath)).mode & 0o777).toBe(0o600);
    }
    const logText = (await Promise.all(logNames.map((name) => readFile(path.join(diagnosticDirectory, name), "utf8")))).join("\n");
    for (const privateValue of [...Object.values(privateContent), root, project]) {
      expect(bundleText).not.toContain(privateValue);
      expect(logText).not.toContain(privateValue);
    }
    expect(networkRequests).toEqual([]);
    expect(await readFile(networkGuardReadyPath, "utf8")).toContain("ready");
    expect(await readFile(networkLogPath, "utf8").catch(() => "")).toBe("");
  } finally {
    await rm(`${settingsPath}.lock`, { recursive: true, force: true });
    if (first) await close(first).catch(() => undefined);
    if (second) await close(second).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
