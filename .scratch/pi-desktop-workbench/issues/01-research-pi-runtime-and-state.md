# Research Pi runtime and shared state

Type: research
Status: resolved
Blocked by:

## Question

What supported Pi APIs, packages, processes, files, and lifecycle hooks can a desktop app use for the agent runtime, authentication, providers/models, configuration, skills/prompts, session discovery/resume, and version management—and what compatibility, concurrency, or corruption risks arise when sharing an existing Pi CLI setup?

The answer must be an extensive, evidence-backed Markdown research asset linked here, prioritizing current official documentation and source code.

## Answer

[Pi runtime and shared-state integration research](../research/pi-runtime-and-shared-state.md) establishes the supported SDK and RPC integration surfaces and inventories runtime, auth, provider/model, settings, resources, sessions, lifecycle, and version behavior against official Pi v0.80.6 documentation and source. Auth and settings are safe to share through Pi's locking managers; a session file has no interprocess writer lock and must have one live owner, with fork/clone or sequential handoff as the safe compatibility boundary.
