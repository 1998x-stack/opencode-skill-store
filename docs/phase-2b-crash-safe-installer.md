# Phase 2B.1 — Durable install/update journal

Date: 2026-11-24. Base: skill-store-mvp at 61a52e146217bbd1dc65b69300f839a1e146c4d5 (Phase 2A merged). No RPC contract or OpenCode SDK change.

## Scope

This increment covers install/update and process crash recovery under a single writer per Location. It does not claim power-loss durability, cross-process concurrent writers, transactional uninstall, real OpenCode Host or Go Store acceptance. The umbrella integration PR remains Draft.

## Commit protocol

- Download, verify SHA/size and extract untrusted ZIP in staging; create immutable candidate version directory.
- Persist one private install-journal.json under the Location install root. schemaVersion=1, operationId, phase=prepared, previous installation (or null), candidate installation. The previous KV installation is the authoritative before-image; active.json is a projection. No external paths or secrets in the journal.
- Switch active.json; persist candidate KV; reload Runtime. Verify exact single ID, resolved version SKILL.md path, content (against extracted candidate body), or absence for disabled Skills.
- Atomically replace journal with phase=committed. This is the process-crash commit boundary. Persist installed terminal operation, then remove journal. Never roll back after committed even if operation persistence/cleanup fails.
- Incomplete normal rollback or post-commit projection failure blocks new mutations until restart; do not delete a candidate version when rollback has not succeeded.

Journal writes use exclusive temporary file, file sync, atomic rename, private permissions. The directory and full extracted tree are not fsynced: power-loss behavior is not verified. Multi-process access to the same Location is unsupported. Existing installed-tree tampering/digest validation remains separate.

## Recovery

Before transform registration and RPC publication, validate journal and operation identity. prepared -> project previous record (or remove active pointer for first install); committed -> project candidate. Persist KV, rebuild Runtime snapshot, reload and verify. Finalize operation as interrupted or installed respectively, persist, then remove journal. An invalid/corrupt or mismatched journal, failed verification or storage failure aborts plugin initialization rather than exposing an unverified candidate. Repeat recovery is idempotent. Candidate directories left by an abrupt kill are retained, not garbage collected without ownership/reachability evidence.

Operations retention keeps active operations plus 100 recent terminal records. Current legacy installations without a journal are handled by existing reconciliation; a journal cannot retroactively establish what happened before this implementation.

## Tests

The shared fixture simulates OpenCode Host storage with an atomically replaced JSON file and uses deterministic valid ZIPs and a mock Runtime. A separate Bun process runs the actual InstallManager, is killed with SIGKILL at four externally observed checkpoints, then a fresh manager reopens the same disk state twice. Matrix: first install and update x after active pointer/before candidate KV, after candidate KV, after Runtime reload, after commit/before operation projection. Verify exact version, Runtime body/path supporting file, operation terminal state and journal cleanup. This is process-level installer coverage, not real OpenCode process or browser E2E.

## Remaining gates

- Crash around version rename / journal creation, disk full, fsync and real Host KV failure semantics.
- Durable uninstall tombstone and cleanup_pending; enable/disable transaction recovery.
- Single writer enforcement for same Location across processes; session-safe retention/GC.
- Full extracted-tree integrity and collision handling.
- Real Go Store contract and Playwright + actual model-backed Skill invocation.
- No merge of umbrella PRs to main/dev until release gates are satisfied.
