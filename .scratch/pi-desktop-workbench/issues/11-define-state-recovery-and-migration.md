# Define state recovery and migration behavior

Type: grilling
Status: resolved
Blocked by: 08

## Question

What exact recovery, migration, and concurrency behavior should PiLot specify for PiLot-owned session files, failed CLI-session forks or imports, interrupted engine subprocesses, settings persistence failures, and engine/session schema changes—including which repairs may be automatic, which require user consent, and which data must remain recoverable?

## Answer

PiLot follows **preserve, then repair**: preserve source bytes and the last durable state before intervention; perform only provably lossless, unambiguous repairs automatically; require user consent for destructive, lossy, or ambiguous recovery.

### Durable recovery contract

For every PiLot-owned session, PiLot must recover all valid persisted Pi session entries, PiLot-owned session metadata, and the saved composer draft. Unpersisted stream fragments may be lost. An interrupted prompt or tool call is marked interrupted and is never replayed or retried automatically because its external side effects may already have occurred.

The supervisor offers an explicit restart from persisted state after an unexpected engine exit. Restart creates a new engine process against the same exclusively owned session only after validating its durable state; unrelated sessions remain running.

### Session repair and concurrency

After retaining the original bytes, PiLot may automatically remove only an incomplete trailing JSONL fragment, rebuild derived indexes or metadata from canonical durable data, and complete or remove an interrupted temporary-file commit whose intended state is unambiguous. Any malformed record within the durable history, conflicting tree structure, or uncertain commit requires action.

Ambiguous corruption never modifies the original in place. PiLot identifies the affected range, permits read-only export, and—with explicit consent—creates a new recovered session from verified entries with every gap disclosed.

Each PiLot-owned session has one exclusive writer lease across app windows and instances. A live owner is focused or observed read-only. A stale lease is reclaimed automatically only when owner death can be proven; otherwise PiLot requires consent to fork a separate session rather than forcing ownership. CLI-owned source sessions remain read-only.

### Forks, imports, and migrations

A CLI-session fork or import is staged: copy without altering the source, validate and migrate the copy through the bundled engine, then publish it atomically into PiLot's store. Failure publishes no usable session, retains a diagnostic recovery copy, and offers retry, read-only export, or consent-based salvage into a new recovered session.

Engine/session-schema migrations apply only to inactive PiLot-owned sessions. PiLot copies the file, migrates it through the release-pinned engine, verifies the result, and atomically replaces the active copy. It retains the pre-migration original for rollback. Lossy, unsupported, or unverifiable migrations require consent; PiLot never migrates a CLI-owned source. A version that cannot safely open a newer schema must remain read-only rather than downgrade-write it.

Failed-operation recovery copies remain until a successful retry supersedes them or the user explicitly discards them. After migration, PiLot retains at least one rollback generation even after the migrated session opens and saves successfully; a newer verified rollback generation may supersede it.

### Settings persistence

Shared Pi settings continue through Pi's locking manager and must flush successfully before PiLot reports a change as saved. App-owned persistent state uses atomic replacement and keeps its last-known-good version. On parse, lock, flush, or disk failure, PiLot keeps sessions running, marks the attempted change unsaved, and blocks only further writes to that settings scope until retry succeeds or the user discards the pending change. It never overwrites the last-known-good file with partial data or silently drops unknown shared fields.

Every blocked or recovered operation reports the affected resource and path, durable state retained, action taken, possible loss, available recovery copy, and next action without exposing credentials.
