# PiLot

PiLot provides a graphical desktop interface for working with Pi coding agents while preserving compatibility with the wider Pi ecosystem.

## Language

**Pi environment**:
A user's coherent collection of Pi credentials, models, customizations, settings, and session history, shared across compatible Pi interfaces.
_Avoid_: PiLot profile, app account

**PiLot**:
The desktop interface through which a user works with Pi agents and their projects.
_Avoid_: Pi wrapper, Pi TUI wrapper

**Available provider**:
A provider in the Pi environment that currently exposes at least one model Pi can use.
_Avoid_: Configured provider, connected provider

**Built-in provider**:
A provider whose identity and model integration are supplied by PiLot's pinned Pi SDK.
_Avoid_: First-party provider, official provider

**Custom provider**:
A provider defined by the user’s Pi environment rather than by PiLot's pinned Pi SDK.
_Avoid_: Unknown provider

**Available model**:
A provider-scoped model Pi can currently use for a Task.
_Avoid_: Configured model, set-up model

**Project**:
A codebase within which a user organizes and performs tasks.
_Avoid_: Workspace, repository

**Project admission**:
The deliberate addition of a manually selected folder to PiLot after the user approves both Pi resource trust and agent execution. A selected folder is not yet a Project until admission completes.
_Avoid_: Mounting a Project, pending Project

**Project removal**:
The deliberate exclusion of an admitted Project from PiLot. Removal revokes PiLot agent execution consent and hides its Tasks while preserving canonical Pi resource trust and Pi session history. Re-admission is required to show it again.
_Avoid_: Deleting a Project, deleting Tasks

**Task**:
A durable, goal-oriented body of agent work belonging to a project. Tasks are the primary work items users start, monitor, and revisit. Existing compatible Pi sessions within admitted Projects are presented as tasks even when richer task metadata is absent.
_Avoid_: Pi session, thread, chat

**Execution location**:
The project checkout in which a task reads and changes files. It is either the user's local checkout or a managed worktree dedicated to that task.
_Avoid_: Workspace, sandbox, task environment

**Active task**:
A task the user intends to keep available for continued work. Agent inactivity does not make a task complete.
_Avoid_: Open task, incomplete task

**Archived task**:
A task the user has deliberately removed from active work without deleting its history.
_Avoid_: Completed task, closed task

**Run**:
A period of agent activity initiated by accepted input and ending when no retry, compaction retry, or queued continuation remains.
_Avoid_: Turn, task, session

**Stop Run**:
A user request to end the active Run before it settles naturally. The resulting Run outcome is Aborted.
_Avoid_: Abort Run, Cancel Run

**Thinking level**:
The selected amount of model reasoning for a Task, limited to the levels supported by its current model.
_Avoid_: Thinking mode, reasoning mode
