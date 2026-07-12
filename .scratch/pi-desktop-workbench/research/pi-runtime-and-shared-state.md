# Pi runtime and shared-state integration research

Researched against the official Pi `v0.80.6` package, documentation, and source on 2026-07-12. Source links below are pinned to that tag.

## Executive answer

Pi exposes two supported integration surfaces suitable for a desktop workbench:

1. **The TypeScript SDK** in `@earendil-works/pi-coding-agent`, including `createAgentSession()`, the higher-level `createAgentSessionRuntime()`, `AgentSessionRuntime`, `SessionManager`, `SettingsManager`, `AuthStorage`, `ModelRegistry`, and `DefaultResourceLoader. This is the richest and preferred same-process interface for a Node-compatible host.
2. **A long-lived `pi --mode rpc` subprocess** using LF-delimited JSON over stdin/stdout. It provides process isolation and a broad command/event protocol, including prompting, streaming, models, queues, compaction, session switching/forking/cloning, entry/tree reads, commands, and extension UI requests.

Pi also has print and JSON modes, but they are one-shot/event-output modes rather than a complete interactive desktop control plane.

Existing CLI configuration can be reused by constructing SDK services with the default agent directory (`~/.pi/agent`) and project cwd, or by launching RPC without overriding those locations. Existing sessions can be discovered and sequentially resumed through supported APIs. **The same session file must not be opened for writing by desktop and CLI concurrently:** session writes are append-only but have no interprocess lock, each process keeps an independent in-memory leaf/index, and migration can rewrite the whole file. Auth and settings do have interprocess locks and merge-under-lock behavior.

The safest first-release boundary is therefore:

- share the existing auth, model, settings, skill, prompt, extension/package, trust, and session-discovery locations;
- give each live session exactly one writer process/runtime;
- hand off an inactive session sequentially, or fork/clone it to a new file before desktop work;
- never edit Pi-owned JSON/JSONL directly when a public manager/API exists;
- pin one Pi package/runtime version per app release and treat the user's CLI version as a separate compatibility target, not as an interchangeable binary by assumption.

## 1. Supported runtime surfaces

### 1.1 SDK: same-process embedding

The official SDK documentation explicitly names desktop apps and custom UIs as use cases. The main package exports the complete embedding API; no separate SDK package is required. [`createAgentSession()`](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/docs/sdk.md#quick-start) creates one `AgentSession`. It can:

- submit prompts and images;
- queue steering and follow-up messages;
- stream agent, message, turn, tool, queue, compaction, and retry events;
- inspect messages/model/thinking/streaming state;
- switch model or thinking level;
- navigate the current session tree;
- compact, abort, and dispose.

Session replacement is intentionally a higher-level concern. [`createAgentSessionRuntime()` and `AgentSessionRuntime`](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/docs/sdk.md#createagentsessionruntime-and-agentsessionruntime) own `newSession()`, `switchSession()`, `fork()`, clone flows, and JSONL import while rebuilding cwd-bound services. Replacement changes `runtime.session`; subscribers and extension bindings are attached to the old session and must be recreated.

For a desktop shell, this runtime layer is more appropriate than manually swapping `SessionManager` instances because it follows the same replacement lifecycle as Pi's built-in TUI, print, and RPC modes.

Relevant public packages are:

- `@earendil-works/pi-coding-agent`: sessions, resources, built-in coding tools, run modes, SDK/runtime, auth/model/settings managers;
- `@earendil-works/pi-agent-core`: the low-level agent loop and agent event/state types;
- `@earendil-works/pi-ai`: provider/model types and provider implementations;
- `@earendil-works/pi-tui`: terminal components, only needed for Pi TUI rendering or TUI-specific extension UI.

The published package requires Node `>=22.19.0` and declares matching `^0.80.6` Pi package dependencies in its [package manifest](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/package.json).

### 1.2 RPC: subprocess embedding

[`pi --mode rpc`](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/docs/rpc.md) is the supported process-integration interface. It uses strict JSONL framing: records are split on LF only; generic readers that also split on Unicode line separators are explicitly unsupported.

The protocol supports:

- prompt, steer, follow-up, abort;
- state, messages, model selection/listing, thinking levels;
- queue modes, compaction, retry controls;
- user-initiated bash execution;
- session stats, HTML export, new/switch/fork/clone;
- append-order session entries with a durable `since` cursor and current `leafId`;
- complete session trees and fork candidates;
- session names;
- extension commands, prompt templates, and skill commands;
- streaming lifecycle/tool events;
- an extension dialog/notification subprotocol.

RPC does **not** expose every TUI facility. Built-in TUI commands such as `/settings` and `/hotkeys` are not RPC commands. TUI-only extension APIs such as arbitrary `custom()` components degrade or become no-ops; dialogs and notifications work through the RPC extension-UI protocol.

RPC is the natural isolation boundary if the desktop host is not Node-based, if crashes/extensions must be contained, or if Pi should remain independently replaceable. The SDK is the natural boundary when direct typed state, custom resource injection, and lower IPC complexity matter more.

### 1.3 Other process modes

Pi also supports interactive TUI, `-p` print, and `--mode json` event output ([CLI reference](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/README.md#cli-reference)). Print and JSON modes can automate one-shot work, but neither is the documented full desktop protocol. Scraping or embedding the TUI is unnecessary and would bypass supported SDK/RPC contracts.

## 2. Runtime construction and lifecycle

### 2.1 Services and cwd-bound state

`createAgentSession()` defaults to a `DefaultResourceLoader`. The `cwd` controls project resources, context discovery, tool paths, and default session-directory naming; `agentDir` controls global resources and state. By default, `agentDir` is `~/.pi/agent` ([SDK directories](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/docs/sdk.md#directories)).

The higher-level runtime factory is important because changing sessions can also change effective cwd. It recreates settings, resources, models, trust-sensitive inputs, and tools for that cwd rather than retaining stale project state.

### 2.2 Prompt and run lifecycle

`AgentSession.subscribe()` emits structured events for agent start/end, message streaming, turns, tool execution, queues, compaction, and retry. `agent_end` only means one low-level run ended; retries, overflow compaction, or queued continuations may follow. `agent_settled` is the final idle boundary in RPC and extension lifecycles ([RPC events](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/docs/rpc.md#events)).

During streaming, an additional prompt must declare `steer` or `followUp`; otherwise SDK/RPC rejects it. This is a runtime invariant the desktop UI must represent rather than hiding behind concurrent `prompt()` calls.

### 2.3 Extension lifecycle hooks

Pi extensions are first-class TypeScript modules, loaded by the resource loader and run with full process/user permissions. The documented lifecycle includes ([extension lifecycle](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/docs/extensions.md#lifecycle-overview)):

- startup/trust/resources: `project_trust`, `session_start`, `resources_discover`;
- input/run: `input`, `before_agent_start`, `agent_start`, `agent_end`, `agent_settled`;
- turn/messages: `turn_start`, `context`, provider request/response hooks, `message_start`, `message_update`, `message_end`, `turn_end`;
- tools: `tool_execution_start/update/end`, blocking/mutating `tool_call`, mutating `tool_result`, `user_bash`;
- sessions: `session_before_switch`, `session_before_fork`, `session_before_compact`, `session_compact`, `session_before_tree`, `session_tree`, `session_info_changed`, `session_shutdown`;
- model state: `model_select`, `thinking_level_select`.

On new/resume/fork/reload, Pi shuts down the old extension runtime, rebuilds/rebinds the new one, and starts it again. Old session contexts and managers are stale after replacement. Long-lived resources should begin at `session_start` (not extension factory load) and close idempotently at `session_shutdown` ([replacement footguns](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/docs/extensions.md#session-replacement-lifecycle-and-footguns)).

This matters for desktop integration: an embedded runtime must preserve this lifecycle or extensions that own subprocesses, sockets, watchers, UI state, or persisted state will leak or act on the wrong session.

## 3. Authentication and provider/model reuse

### 3.1 Auth storage and resolution

`AuthStorage.create()` uses `~/.pi/agent/auth.json` by default. Pi stores API keys and OAuth credentials there; OAuth tokens refresh automatically. The documented key priority is:

1. runtime override (`--api-key` / `setRuntimeApiKey`, not persisted);
2. `auth.json`;
3. provider environment variable;
4. custom-provider fallback from `models.json`.

See [SDK API keys and OAuth](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/docs/sdk.md#api-keys-and-oauth) and [provider resolution](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/docs/providers.md#resolution-order).

The auth file is created with mode `0600`; its parent is created as `0700`. API-key values may be literals, environment interpolation, or shell commands. Provider-scoped environment values may also be stored in a credential entry.

**Concurrency:** auth reads/writes and OAuth refresh use `proper-lockfile`. Provider changes re-read and merge the current file while holding the lock, and refresh rechecks the token under an asynchronous lock before writing. This explicitly protects multiple Pi instances refreshing simultaneously ([auth storage source](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/src/core/auth-storage.ts)). Sharing the same auth store through `AuthStorage` is therefore supported.

**Security:** sharing auth means the desktop process and every loaded extension can access credentials with the user's permissions. Pi has no in-process sandbox. A desktop app must not display raw auth data, copy it into app storage, or expose it to renderer/web content. Use `AuthStorage` and auth-status APIs rather than parsing or surfacing secrets.

### 3.2 Providers and models

`ModelRegistry.create(authStorage)` combines Pi's release-bundled model list with `~/.pi/agent/models.json`. It can find all configured models, filter to models with auth, resolve request keys/headers, and refresh from disk. Built-in model metadata is updated with each Pi release ([providers](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/docs/providers.md)).

`models.json` supports compatible OpenAI Completions, OpenAI Responses, Anthropic Messages, and Google Generative AI endpoints, provider overrides, model upserts, model-specific compatibility, cost/context metadata, headers, and command/env key resolution ([custom models](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/docs/models.md)). Non-standard APIs and custom OAuth flows use extension `registerProvider()`.

Important behavior for a desktop:

- custom models are read on registry construction/refresh; `/model` refreshes them in the TUI;
- invalid custom configuration leaves built-in models available and reports a registry load error;
- command-backed keys can execute arbitrary local commands at request time;
- model availability checks do not execute those commands;
- a session records provider/model IDs, not a frozen model definition. Resuming under another Pi version or changed `models.json` can fail or resolve differently. `createAgentSession()` reports model fallback when restoration is impossible.

There is no documented manager for writing `models.json`; treat it as user-owned, read-only compatibility input in v1.

## 4. Configuration and reusable resources

### 4.1 Settings

Global settings live in `~/.pi/agent/settings.json`; project settings live in `<cwd>/.pi/settings.json` and override global settings with nested merge behavior ([settings](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/docs/settings.md)). `SettingsManager.create(cwd, agentDir)` is the supported API.

Setters update memory synchronously and queue persistence asynchronously. `flush()` is the durability boundary; `drainErrors()` is how an embedding reports I/O failures. The manager tracks fields changed by that process and, under a file lock, merges only those fields into the latest on-disk file ([settings source](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/src/core/settings-manager.ts)). That makes concurrent manager-mediated changes substantially safer than whole-file writes.

Caveats:

- a desktop must call `flush()` before shutdown where durability matters;
- parse errors stop safe persistence and must be surfaced;
- project settings must not load or write before project trust is resolved;
- direct JSON writes bypass field-level merge and locking semantics.

### 4.2 Skills, prompt templates, context, extensions, and packages

`DefaultResourceLoader` discovers the same resources as the CLI:

- global skills: `~/.pi/agent/skills`, `~/.agents/skills`;
- project skills: `.pi/skills` and `.agents/skills` from cwd through ancestors;
- global/project prompts: `~/.pi/agent/prompts`, `.pi/prompts`;
- global/project extensions: `~/.pi/agent/extensions`, `.pi/extensions`;
- global/project context: `AGENTS.md`/`CLAUDE.md`, plus system prompt files;
- package resources configured in settings and installed beneath global/project `npm/` and `git/` stores.

Sources: [skills](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/docs/skills.md), [prompt templates](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/docs/prompt-templates.md), [packages](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/docs/packages.md), and [SDK ResourceLoader](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/docs/sdk.md#resourceloader).

The SDK supports resource overrides and additions without copying files. Extensions can contribute more skill/prompt/theme paths during `resources_discover`. `/reload` and `ctx.reload()` rebuild extensions, skills, prompts, themes, and context.

Compatibility implications:

- skills/prompts are data interpreted by the active Pi version and current model;
- extensions are executable code coupled to Pi's API/types and may include TUI-only behavior;
- package install/update mutates settings and package directories and can reset/clean git package clones;
- project packages/extensions are trust-gated;
- an app should not update package trees underneath a live runtime. Perform package management while runtimes are stopped, then rebuild/reload.

Themes and keybindings belong to the TUI surface, not the agent engine. They may be discoverable as setup compatibility, but a native desktop should not promise visual or keyboard equivalence unless it deliberately maps them.

### 4.3 Project trust

Project trust protects loading project-local settings, resources, packages, extensions, and system prompts. It is an input-loading guard, not a sandbox. Context files (`AGENTS.md`/`CLAUDE.md`) still load regardless unless disabled. Non-interactive modes do not prompt and use saved decisions, `defaultProjectTrust`, or `--approve`/`--no-approve` ([security](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/docs/security.md)).

A graphical app using SDK services must provide an equivalent trust decision flow rather than silently setting trusted. RPC can surface extension dialogs, but the desktop still needs a product-level project trust experience. Saved decisions live in `~/.pi/agent/trust.json`.

## 5. Sessions: discovery, resume, and sharing safety

### 5.1 Format and APIs

Sessions default to:

```text
~/.pi/agent/sessions/--<encoded-cwd>--/<timestamp>_<session-id>.jsonl
```

The header records format version, session UUID, timestamp, cwd, and optional parent session. Entries form an append-only tree using stable `id` and `parentId` fields. Current format v3 stores messages, model/thinking changes, compactions, branch summaries, extension entries/messages, labels, and display names. v1/v2 files migrate automatically on load ([session format](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/docs/session-format.md)).

Supported discovery and persistence APIs include:

- `SessionManager.create`, `open`, `continueRecent`, `inMemory`, `forkFrom`;
- `SessionManager.list(cwd)` and `listAll()`;
- tree/path/entry/label/context reads;
- append methods, branch navigation, and branch extraction;
- runtime `newSession`, `switchSession`, `fork`, clone, import;
- RPC `get_entries` with durable cursor, `get_tree`, `switch_session`, `fork`, and `clone`.

Use these APIs instead of deriving folder names or parsing only message lines. The format is versioned, extensible, and auto-migrated.

### 5.2 What is safe to share

**Safe or explicitly supported:**

- listing sessions while other independent session files are active;
- reading a snapshot of a valid append-only session;
- sequentially opening/resuming a session after the prior owner has stopped;
- forking/cloning to a new session file and continuing there;
- different Pi processes writing different session files;
- migrating an inactive older session through `SessionManager`.

**Unsafe:** two processes writing the same session file.

The source shows why ([SessionManager source](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/src/core/session-manager.ts)):

- each manager loads entries once and maintains its own `byId`, labels, and `leafId`;
- appends use synchronous `appendFileSync` without a session lock;
- IDs are collision-checked only against that process's in-memory map;
- parent IDs are selected from that process's in-memory leaf;
- migration and some flows rewrite the complete file;
- malformed lines are skipped on parse rather than repaired.

Even if individual OS appends happen atomically in a particular run, independent leaves can create unintended branches, ordering is nondeterministic, and a rewrite can lose concurrent appends. Pi provides no documented active-session lease, owner marker, or same-file writer lock. Therefore “not currently active” cannot be proven from the session file alone.

A desktop needs an ownership policy outside the current Pi session format. Minimal safe options for the later engine decision are:

1. the desktop owns sessions it starts and refuses to open the same path twice;
2. “continue CLI session” defaults to fork/clone into a desktop-owned file;
3. in-place sequential resume is allowed only after explicit user confirmation that no CLI process owns it;
4. if cross-app seamless handoff is required, introduce a shared advisory lease/lock understood by both launch paths, or route all writes through one long-lived Pi runtime. A desktop-only lock cannot constrain an unmodified CLI.

### 5.3 Read-during-write behavior

Because entries are newline-delimited and readers skip malformed lines, a reader may tolerate a partially written final line by omitting it. That is an implementation observation, not a documented consistency guarantee. RPC `get_entries` against the owning runtime is preferable to repeatedly tailing its file because it returns entries plus the active `leafId` from the authoritative process.

External file watching can detect additions, but it cannot infer the authoritative active branch after another process's in-memory branch movement until a new entry is written.

## 6. Concurrency and corruption matrix

| Shared state | Pi mechanism | Concurrent use assessment | Desktop rule |
|---|---|---|---|
| `auth.json` | `AuthStorage`; sync/async `proper-lockfile`; merge under lock | Supported through API, including OAuth refresh races | Reuse through one `AuthStorage` per runtime; never expose raw file |
| global/project `settings.json` | `SettingsManager`; file lock; changed-field merge; queued writes | Supported through manager with `flush()`/error handling | Never overwrite whole JSON; stop on parse error |
| `models.json` | `ModelRegistry` reads/refreshes; no writer API | Concurrent reads okay; writes/reloads can race semantically | Treat as user-owned read-only input; refresh explicitly |
| one session JSONL | append/rewrite, in-memory leaf, no lock | **Not safe for multiple writers** | One live writer per file; fork or sequential handoff |
| distinct session JSONL files | independent files, UUID names | Safe barring shared package/config side effects | Preferred parallel model |
| skills/prompts/context files | discovered/read/reloaded | Reads are fine; live edits only become visible on reload | Snapshot per runtime; explicit reload |
| extensions | executable modules loaded by runtime | Version/API and lifecycle coupled; side effects arbitrary | Load only trusted; rebuild on replacement/reload |
| package directories/settings | installer updates npm/git trees and settings | Do not mutate beneath live extension/resource loads | Stop runtimes for install/update/remove |
| trust store | saved canonical directory decisions | Shared policy state; security-sensitive | Use Pi trust flow/API, not silent approval |

## 7. Version management

Pi's model catalog, provider compatibility, session migrations, resource semantics, RPC protocol, and SDK types ship together in `@earendil-works/pi-coding-agent`. The CLI offers `pi --version`, `pi update`, and package-specific update commands. `PI_SKIP_VERSION_CHECK=1` disables only the latest-version request; `--offline`/`PI_OFFLINE=1` disables startup network checks and telemetry ([README telemetry/update behavior](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/README.md#telemetry-and-update-checks)).

For an unsigned desktop release, the supported facts imply:

- **Bundled SDK/RPC runtime:** pin the exact coding-agent version in the app lockfile/bundle. This makes the protocol, model catalog, session migrations, and extension API testable. Do not run `pi update` inside the app bundle.
- **System CLI runtime:** discover `pi` on PATH and inspect `pi --version`, but do not assume arbitrary versions match the desktop protocol or native UI expectations. Negotiate a tested version range and show a diagnostic outside it.
- **Shared files across versions:** newer Pi may migrate a session on open; changed settings/model/resource schemas may not be backward compatible with an older CLI. Never use an older process to write a file after a newer process has migrated or extended it unless that version pair is tested.
- **Packages/extensions:** their versions are independent compatibility inputs. Pinned npm/git package sources reduce drift; unpinned updates should be user-initiated and tested after runtime reload.

There is no documented stable cross-version compatibility promise for arbitrary SDK/RPC versions. The app specification should therefore define and test a concrete version matrix rather than infer compatibility from semver alone.

## 8. Failure and diagnostic requirements surfaced by the research

A decision-ready compatibility contract should distinguish at least these failures:

- Pi runtime unavailable or outside tested range;
- Node/runtime mismatch for SDK embedding;
- invalid/unreadable `auth.json`, settings, `models.json`, trust store, or session file;
- auth configured but key command/environment unresolved;
- OAuth refresh failure or lock acquisition failure;
- recorded session model missing, with Pi's fallback message surfaced;
- project resources skipped because trust is unresolved/declined;
- resource/extension load diagnostics;
- extension requiring TUI-only UI while running under SDK-native/RPC UI;
- session path already owned by the desktop, or potentially active in CLI;
- session migration required, especially before any in-place resume;
- settings write queued but not flushed, or `drainErrors()` non-empty;
- package/resource update attempted while runtimes are live.

## 9. Implications for the next map decisions

This research does not choose the engine strategy, but narrows the valid choices:

- **Embedded SDK** and **managed RPC subprocess** are both supported; TUI scraping is not needed.
- Full reuse of the user's setup is technically possible through default `agentDir`/cwd discovery, but executable extensions and project trust make it a security and compatibility promise, not merely a path choice.
- Auth and settings can be shared through their managers. Session files require strict single-writer ownership.
- “Use the installed CLI” maximizes version identity with the user's terminal at the cost of protocol drift and process management. “Bundle Pi” gives a testable engine at the cost of a deliberate compatibility boundary with the user's possibly different CLI.
- The first release can safely discover all CLI sessions and offer forked continuation. Seamless concurrent editing of one session is not supported by current Pi storage.

These facts directly unblock **Choose Pi engine sourcing and version strategy** and later **Define existing setup compatibility contract**.

## Primary sources

- [Pi README and CLI reference, v0.80.6](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/README.md)
- [SDK documentation, v0.80.6](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/docs/sdk.md)
- [RPC documentation, v0.80.6](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/docs/rpc.md)
- [Session format, v0.80.6](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/docs/session-format.md)
- [Extensions and lifecycle, v0.80.6](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/docs/extensions.md)
- [Providers, v0.80.6](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/docs/providers.md)
- [Models, v0.80.6](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/docs/models.md)
- [Settings, v0.80.6](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/docs/settings.md)
- [Skills, prompts, and packages, v0.80.6](https://github.com/earendil-works/pi-mono/tree/v0.80.6/packages/coding-agent/docs)
- [Security model, v0.80.6](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/docs/security.md)
- [SessionManager source, v0.80.6](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/src/core/session-manager.ts)
- [AuthStorage source, v0.80.6](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/src/core/auth-storage.ts)
- [SettingsManager source, v0.80.6](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/src/core/settings-manager.ts)
- [ModelRegistry source, v0.80.6](https://github.com/earendil-works/pi-mono/blob/v0.80.6/packages/coding-agent/src/core/model-registry.ts)
