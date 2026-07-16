# Local development

## Prerequisites

- Node.js 22.19 or newer
- npm (the committed `package-lock.json` is authoritative)
- Git
- Bash; on Windows, install Git for Windows if Bash is unavailable

PiLot's release targets are macOS arm64 and Windows x64.

## Install and run

```sh
git clone https://github.com/hafiezul/PiLot.git
cd PiLot
npm ci
npm run dev
```

`npm run dev` performs an initial type check, builds the preload and Electron main process, starts Vite on `127.0.0.1:5173`, and opens the app. React and CSS changes hot-reload in the existing window. Changes to the main process or preload require stopping and rerunning the command.

Use `npm start` when you need a production-style build and launch from `dist/`. The development server fails rather than choosing another port if 5173 is already occupied.

### Pi data used by the app

By default, PiLot deliberately uses the canonical Pi environment at `~/.pi/agent`. Provider and project-trust changes made in PiLot therefore affect the Pi CLI too. PiLot-only preferences and recent Projects use Electron's platform-specific user-data directory.

Set these variables before starting PiLot when you want disposable development state:

| Variable | Purpose |
| --- | --- |
| `PI_CODING_AGENT_DIR` | Pi credentials, models, settings, trust decisions, and sessions |
| `PILOT_USER_DATA_DIR` | PiLot preferences and recent-Project state |

macOS or Bash:

```sh
export PI_CODING_AGENT_DIR="${TMPDIR:-/tmp}/pilot-dev/pi-agent"
export PILOT_USER_DATA_DIR="${TMPDIR:-/tmp}/pilot-dev/user-data"
mkdir -p "$PI_CODING_AGENT_DIR" "$PILOT_USER_DATA_DIR"
npx pi
npm run dev
```

PowerShell:

```powershell
$env:PI_CODING_AGENT_DIR = "$env:TEMP\pilot-dev\pi-agent"
$env:PILOT_USER_DATA_DIR = "$env:TEMP\pilot-dev\user-data"
New-Item -ItemType Directory -Force $env:PI_CODING_AGENT_DIR, $env:PILOT_USER_DATA_DIR
npx pi
npm run dev
```

Running `npx pi` initializes the selected Pi environment and lets you configure a provider. An empty environment is also valid for exercising PiLot's readiness UI.

### Shell and Project environments

PiLot reads the configured login-shell environment once when the app starts, without writing shell files. Restart PiLot after changing shell startup configuration. Explicit variables saved under **Project actions → Project access → Project environment** override that captured environment for all future Project-scoped processes, including agent tools, inline commands, Git and Worktree operations, setup commands, configured editors, and terminal launches. A Project override replaces the captured value with the same name; on Windows, names are matched case-insensitively.

On Windows, Bash resolution is deterministic:

1. Pi's `shellPath` setting (Project setting first when trusted, otherwise global)
2. Git Bash under `Program Files` or `Program Files (x86)`
3. `bash.exe` on the captured `PATH`

PiLot passes native Windows paths to Git, editors, and process working directories. Git Bash performs its normal MSYS path conversion for shell commands; PiLot does not rewrite command text or require WSL.

## Checks

```sh
npm run typecheck  # TypeScript only
npm run build      # Type-check and compile the app
npm test           # Build, launch Electron, and run Playwright tests
```

Playwright runs keep the Electron window hidden by default. Use `npm test -- --headed` to show it while debugging.

The tests create temporary Pi and PiLot data, use fixture credentials, run serially, and remove their data afterward. They do not require your canonical `~/.pi/agent` environment.

Generated output is written to `dist/`. Playwright failures and representative cross-theme/cross-viewport screenshots are written to `test-results/`; both directories are ignored by Git. The platform-smoke workflow uploads `test-results/` so the macOS and Windows UI evidence can be reviewed.

## Project structure

```text
src/main/       Electron main process and Pi SDK integration
src/preload.cts Sandboxed IPC bridge
src/renderer/   React renderer and styles
src/shared/     Types shared across process boundaries
scripts/dev.mjs Dependency-free Vite and Electron runner
tests/          Playwright Electron integration tests
docs/adr/       Architecture decisions
docs/product/   Product scope
```

Keep operating-system and Pi SDK access in the main process. Expose only the minimum typed IPC surface through the preload bridge; the renderer remains sandboxed without Node.js access.

Before changing product behavior or terminology, read [the v1 scope](product/v1-scope.md), [the domain language](../CONTEXT.md), and relevant [architecture decisions](adr/).

## Troubleshooting

- **“Create your Pi environment”**: run `npx pi` with the same `PI_CODING_AGENT_DIR` value, then restart PiLot.
- **“Install a compatible Bash shell”**: on Windows, install [Git for Windows](https://git-scm.com/download/win), add `bash.exe` to `PATH`, or configure Pi's `shellPath`; then relaunch PiLot.
- **“Load your login-shell environment”**: fix the reported shell startup error, then relaunch PiLot. PiLot temporarily uses its desktop launch environment until capture succeeds.
- **A provider is missing**: configure it in PiLot or Pi, then use **Refresh providers** or restart the app.
- **Port 5173 is already in use**: stop the other process before running `npm run dev`; PiLot intentionally does not fall through to another port.
- **A main-process or preload change is not visible**: stop Electron and run `npm run dev` again. Renderer React and CSS changes should update automatically.
