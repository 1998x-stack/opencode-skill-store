# Phase 2A — Release gates and transaction hardening

Date: 2026-11-24. This is an incremental gate on top of the existing Phase 2 plan, not a replacement for real Store acceptance.

## Evidence baseline

- Integration draft PR #1: dc56af957d78abcb130ea7be3d3dfaa38ce5012a; CI run 45221788056 completed successfully (install, typecheck, unit tests).
- Fork draft PR #1: 189b7d0671d9a98eb630cac5340b14aab0219fe1; CI run 45221709148 completed successfully (workspace install, app typecheck, app unit tests).
- Keep OpenCode and plugin on matching 2.3.2 for this gate. Do not introduce an upstream SDK upgrade into this change.
- The integration repository is not the real Go Store. Candidate HTTP paths remain unverified.

## A1: Cancellation correctness

Source: packages/opencode-skill-store-plugin/src/installer/manager.ts. The previous handler aborted any controller, even after committing began. Commit has no abort checkpoint; a true cancellation acknowledgement could be followed by success. The new gate admits cancellation only in active pre-commit stages, checks the signal immediately before entering commit, and lets committing work finish on graceful shutdown. The boolean means acceptance, not that cleanup is finished. The UI must re-read durable state and respect false, including stale UI clicks. Tests inject cancellation during extracting, committing, and registering. CI on the new SHA is required; not run locally in this review.

## A2: Durable transaction recovery (next code increment; not implemented here)

The original PDF §9.3 calls active.json the commit point; the current manager writes active.json then installations KV before Runtime verification; loadRuntimeSnapshot repairs the pointer from KV. This creates an unresolved crash window after KV write and before runtime verification. initialize currently marks active operations interrupted without using a before-image.

Proposed protocol: one private durable journal per operation, with schemaVersion, operationId, assetId, prior installation (or null), prior active pointer (or null), candidate package identity and stage. Record before-image before any activation. Sync writes and parent directories where supported; ensure private same-filesystem staging. Runtime verify exact ID, version path and content, then durably mark committed before returning success. Reconcile on start: PREPARED/ACTIVATING -> restore before-image and verify old runtime, COMMITTED -> converge new version and finalize operation. Fail closed to BROKEN if recovery cannot establish a consistent identity. Never delete a version still referenced by a journal, active pointer, or running session. Define one authoritative commit record; active.json and installation index are derived projections. Uninstall requires a durable tombstone and cleanup_pending rather than reactivating a partially removed directory.

Process-level test matrix: SIGKILL after journal, version rename, active rename, installation KV write, runtime reload, and durable commit; restart with same data volume and assert old or committed new version, consistent operation terminal state, no unverified Runtime exposure. Also test graceful shutdown, retry, repeated recovery, disk-full and stale staging. Manager reconstruction tests are not substitutes for process-level tests.

## A3: Real Store contract and scope (parallel discovery, blocked without target)

Follow docs/phase-2-real-store-e2e-plan.md. Obtain actual Go router/OpenAPI and a disposable test endpoint, verify auth scheme and error/pagination semantics, raw ZIP vs redirect, explicit platform/arch, package identity/digest/size and root SKILL.md. Capture sanitized fixtures from real responses. Fail closed on unrecognized contract rather than showing an empty catalog. Do not guess headers or relax redirect policy. Verify digest over actual downloaded bytes.

The plugin keys include directory + workspaceID, but the current Web component constructs location with directory only. Confirm real SDK/Host location selection for a same-directory workspace pair; do not infer workspace authorization from a hash. Establish single-tenant scope until authenticated principal-to-location authorization is tested. Test stale requests after location/server switches and reconnects. RPC schema is duplicated in two repos: add a semantic contract parity check against pinned companion commits before changing wire contracts.

## A4: Acceptance and merge gates

- Use a harmless proof skill with two immutable versions and unique supporting-file markers.
- Real browser: Discover -> install -> refresh/reconnect -> Installed -> update -> disable/enable -> uninstall; verify no Store keys, signed URLs or archive bytes reach browser.
- Real model session: @ss-id triggers native Skill and supporting-file read; record sanitized tool trace, Runtime ID, version and file marker, not only assistant text.
- Run the A2 fault matrix and cross-location/authorization negative tests.
- Record each gate PASS/FAIL/BLOCKED/NOT RUN with pinned SHAs, commands, exit status, sanitized evidence paths.
- Keep both existing integration PRs Draft until live gates pass. Review this incremental PR against skill-store-mvp; merge it into that branch only after its own CI and review, not directly to main.
