# Chart a native Pi desktop workbench

Label: wayfinder:map

## Destination

A standalone, decision-ready product, UX, and technical specification for an unsigned macOS-first Pi desktop workbench for existing Pi users, ready for implementation planning.

## Notes

- The first release is an unsigned DMG with a documented `xattr` workaround; Developer ID signing, notarization, and official distribution are future concerns that the architecture should not preclude.
- The product is a native-behaving visual workbench powered by the Pi engine, not an embedded or scraped TUI.
- Reuse existing Pi setup by default. Share CLI sessions when safe, and define explicit fallbacks where Pi cannot support compatibility safely.
- Framework choice is evidence-driven; macOS behavior, accessibility, keyboarding, menus, windows, drag/drop, and performance are binding.
- Pi and Pi TUI research must be extensive and evidence-backed. Consult official documentation and source, not assumptions.
- Use `/research` for external/source investigations, `/grilling` and `/domain-modeling` for product decisions, and `/prototype` plus `/impeccable` for every UI/UX ticket.
- Planning normally stops before implementation, except the final synthesis ticket may create the standalone specification.
- Refer to the comparison products as references, not templates: Codex desktop, Claude Code's desktop surfaces, and t3.chat/t3code-style agent workbenches.

## Decisions so far

- [Research Pi runtime and shared state](issues/01-research-pi-runtime-and-state.md) — Pi supports SDK and RPC desktop integration; auth/settings can share their locking managers, while each session file requires one live writer and safe handoff or forking.
- [Map Pi TUI capabilities to desktop](issues/02-research-pi-tui-portability.md) — Most Pi engine semantics port directly or through native adapters, while terminal presentation must be redesigned and extension compatibility must explicitly exclude unsupported TUI-only surfaces.
- [Research native agent workbench patterns](issues/03-research-desktop-workbenches.md) — PiLot should use a native project/session workbench with structured activity, scoped approvals, and a read-only diff inspector while rejecting chat-only, embedded-IDE, default-full-access, and web-chrome patterns.
- [Choose Pi engine sourcing and version strategy](issues/04-decide-pi-engine-strategy.md) — PiLot bundles a release-pinned Pi RPC engine, isolates each live session in its own process and store, forks CLI sessions by default, and gates unsafe shared-state operations on version drift.
- [Define existing setup compatibility contract](issues/05-define-compatibility-contract.md) — PiLot reuses compatible trusted Pi setup by default, guards shared state across version drift, degrades unsupported extension presentation explicitly, and keeps native presentation authoritative.

## Not yet specified

- Additional prototype variants needed after the first workbench interaction model is tested with the product owner.

## Out of scope

- Windows and Linux releases for the first specification.
- Optimizing first-run setup for people who have never used Pi.
- Reimplementing model-provider and agent-loop behavior independently of Pi.
- Developer ID signing, notarization, App Store distribution, and production auto-update delivery for the initial unsigned release.
- Implementing the app; this effort ends with the standalone specification.
