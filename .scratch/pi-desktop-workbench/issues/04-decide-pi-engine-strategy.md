# Choose Pi engine sourcing and version strategy

Type: grilling
Status: resolved
Blocked by: 01

## Question

How should PiLot locate, launch, isolate, and version the Pi engine while reusing an existing Pi setup by default, sharing sessions only when safe, and avoiding silent incompatibility between desktop and CLI usage?

## Answer

PiLot will bundle an exact, tested Pi engine and launch it through its supported RPC mode using bundle-relative paths rather than discovering the user's CLI executable. Each live PiLot session owns one managed RPC subprocess and one session file in a separate PiLot session store. Subprocesses run with the user's normal permissions: this is crash and lifecycle isolation, not a security sandbox.

Existing CLI sessions are discovered read-only and forked by default into PiLot's store before continuation. PiLot never assumes an unmodified CLI has released a shared session file, so it does not write CLI-owned sessions in place.

The engine version is pinned to the PiLot release and updates only with PiLot. The installed CLI is a compatibility input, not the runtime: when it falls outside the tested matrix, PiLot remains usable but gates shared-state operations that could write or migrate incompatible data and shows a diagnostic. The exact matrix and per-resource degradation belong to **Define existing setup compatibility contract**.

If an engine subprocess exits unexpectedly, PiLot marks that session interrupted and offers an explicit restart from persisted state. It never automatically replays an in-flight prompt. Exact packaging, environment capture, and native host mechanics belong to **Choose macOS desktop architecture**.
