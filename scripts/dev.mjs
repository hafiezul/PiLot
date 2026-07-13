import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const server = await createServer();
await server.listen();
server.printUrls();

const electron = spawn(electronPath, ["."], {
  env: { ...process.env, PILOT_DEV_SERVER: "1" },
  stdio: "inherit",
});
let stopping = false;

async function stop(signal) {
  if (stopping) return;
  stopping = true;
  if (electron.exitCode === null) electron.kill(signal);
  await server.close();
}

process.once("SIGINT", () => {
  process.exitCode = 130;
  void stop("SIGINT");
});
process.once("SIGTERM", () => {
  process.exitCode = 143;
  void stop("SIGTERM");
});
electron.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
  void stop();
});
electron.once("exit", (code) => {
  process.exitCode ??= code ?? 0;
  void stop();
});
