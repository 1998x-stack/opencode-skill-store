# Phase 2B.2 — Lifecycle transaction recovery and single writer

Date: 2026-11-24. Base: 92cb5b338068a3cf7755e19aa7c473f89328e67d (Phase 2B.1 merged; 72 tests passed). No RPC wire or SDK changes.

## Scope and invariants

A Location may have at most one live InstallManager using the same physical local install root. The lock is acquired before reading KV, deleting staging or registering Runtime. A dedicated SQLite database (Bun built-in bun:sqlite) holds a BEGIN IMMEDIATE transaction for the entire manager lifetime; no domain data is stored there. SQLite releases the OS lock on normal close or process termination. The lock file must never be removed or replaced while any server may be running. Require local filesystem and Bun-compatible Host; network mounts, separate roots sharing the same KV namespace, mixed old/new plugin versions and real Host compatibility are not validated. No lock stealing or PID heuristics. Do not deploy two processes sharing a Location state volume until real Host acceptance is complete.

Shutdown rejects new mutations, waits for accepted start requests and jobs, drains mutations, disposes Runtime and releases the lock. Initialization / RPC registration failure releases resources. The existing install journal remains compatible.

## Lifecycle transaction protocol

lifecycle-journal.json (schemaVersion 1, kind=set_enabled or uninstall, phase=prepared/committed, previous, candidate) is separate from install-journal.json; simultaneously present journals are invalid. Both use the same serialized writer. No credentials or arbitrary paths.

1. Write PREPARED before changing the Location KV installation projection.
2. Set candidate; for uninstall candidate.enabled=false and status=cleanup_pending.
3. Reload and verify exact Runtime identity/version/content or absence.
4. Write COMMITTED atomically.
5. For uninstall only, delete the validated managed directory, persist removal of tombstone, then clear journal. Never restore an installation after destructive cleanup starts.

On precommit failure restore previous, verify Runtime and clear journal only after successful rollback. After commit, failure retains journal and blocks mutations until restart. If uninstall cleanup fails, retain disabled cleanup_pending record; do not re-register. On startup, PREPARED rolls back and COMMITTED rolls forward before RPC publication; committed uninstall retries cleanup idempotently. Invalid journals or unsuccessful recovery fail initialization. Administrator may need to repair filesystem permissions/path and restart.

Deletion currently retains the existing explicit uninstall behavior. Active sessions may hold references to old files; production session-safe reclamation / deferred GC remains a separate gate. Power loss is not proven (directory/tree fsync not implemented).

## Tests and release gates

- Existing 72 tests must remain passing, including install/update subprocess SIGKILL tests.
- Seven lifecycle SIGKILL cases: enable/disable each before/after commit, uninstall before commit, after commit and after directory deletion before final KV write. Reopen state twice and assert correct Runtime, files and journal cleanup.
- Competing manager in same process and separate process must be rejected; next owner after close succeeds. Existing SIGKILL matrix also proves lock release on abrupt exit.
- Simulate unsafe cleanup path with a symlink: verify outside file survives, tombstone remains disabled and restart after repair completes cleanup.
- Actual OpenCode Host, Go Store, browser and live Agent proof remain mandatory. No umbrella PR merge until these gates are satisfied.
- Future work: tree digest, fsync/power-loss and disk-full testing, session-safe cleanup, durable operation/idempotency retention and actual host lock compatibility.
