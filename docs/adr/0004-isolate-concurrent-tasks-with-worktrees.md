# Isolate concurrent tasks with worktrees

PiLot will run multiple tasks concurrently while allowing each Git task to use either the local checkout or a dedicated managed worktree. Only one active task may use a project's local checkout at a time; additional concurrent tasks must use worktrees, preventing file and Git-state collisions without forcing every task into an isolated copy.
