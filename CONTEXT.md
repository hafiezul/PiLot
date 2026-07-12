# PiLot

PiLot is a native macOS visual workbench for developers who already use Pi.

## Language

**Desktop workbench**:
A native visual workspace that brings projects, concurrent agent sessions, files, diffs, tool activity, and approvals together around Pi.
_Avoid_: TUI wrapper, terminal wrapper, native chat

**Pi engine**:
The supported Pi runtime and programmatic capabilities that power agent sessions independently of Pi's terminal interface.
_Avoid_: Embedded TUI, terminal scraping

**Existing Pi user**:
A developer who already uses Pi CLI and may have authentication, providers, models, settings, extensions, skills, prompts, and session history configured.
_Avoid_: Generic developer, new user

**Project**:
A local directory opened in PiLot that groups the agent sessions working against it.
_Avoid_: Workspace, repository

**Session**:
A resumable Pi-backed unit of coding work associated with one project.
_Avoid_: Chat, thread, task

**Existing setup compatibility contract**:
PiLot's explicit per-resource promise for what existing Pi state it reuses, adapts, degrades, blocks, or does not support.
_Avoid_: Full Pi compatibility, configuration import
