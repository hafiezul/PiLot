# PiLot

PiLot provides a graphical desktop interface for working with Pi coding agents while preserving compatibility with the wider Pi ecosystem.

## Language

**Pi environment**:
A user's coherent collection of Pi credentials, models, customizations, settings, and session history, shared across compatible Pi interfaces.
_Avoid_: PiLot profile, app account

**PiLot**:
The desktop interface through which a user works with Pi agents and their projects.
_Avoid_: Pi wrapper, Pi TUI wrapper

**Project**:
A codebase within which a user organizes and performs tasks.
_Avoid_: Workspace, repository

**Task**:
A durable, goal-oriented body of agent work belonging to a project. Tasks are the primary work items users start, monitor, and revisit. Existing compatible Pi sessions are presented as tasks even when richer task metadata is absent.
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
