# PiLot

PiLot is a desktop interface for working with [Pi](https://github.com/badlogic/pi-mono) coding agents. It provides a task-focused command center while sharing the credentials, models, settings, trust decisions, and session history in the user's existing Pi environment.

> PiLot is under active development and is not yet a packaged release.

## Run locally

Requirements:

- Node.js 22.19 or newer
- npm
- A compatible Bash shell (Git for Windows provides one on Windows)

```sh
npm ci
npm run dev
```

The development command hot-reloads React and CSS changes. Use `npm start` for a production-style build and launch.

PiLot reads `~/.pi/agent` by default. If that environment does not exist yet, run the bundled Pi CLI once:

```sh
npx pi
```

See [Local development](docs/local-development.md) for isolated development data, available checks, project structure, and troubleshooting.

## Project documentation

- [Product definition](PRODUCT.md)
- [v1 scope](docs/product/v1-scope.md)
- [Domain language](CONTEXT.md)
- [Design system](DESIGN.md)
- [Architecture decisions](docs/adr/)
- [Issue workflow](docs/agents/issue-tracker.md)
