# Phase 2 — Real Store Contract & End-to-End Acceptance

Status: Ready for local execution; live Go Store and local OpenCode runtime are not available in this repository session.  
Date: 2026-11-24  
Related PRs:
- Server Plugin: https://github.com/1998x-stack/opencode-skill-store/pull/1
- OpenCode Web: https://github.com/1998x-stack/opencode/pull/1

## 1. Objective

Move from CI-validated components to one proven vertical slice:

`OpenCode Web → selected OpenCode Server → Skill Store HTTP API → verified ZIP → Location-scoped filesystem → native Skill Runtime → real Agent Session`.

Do not expand the marketplace feature set before this slice is proven.

## 2. Current verified baseline

- OpenCode Web adds Discover / Installed to the existing Settings → Extensions → Skills view.
- The companion Server Plugin implements Typed RPC, Store HTTP adapter, install operations, SHA/size validation, safe ZIP extraction, immutable version directories, rollback and Skill Runtime registration.
- Latest Plugin CI: TypeScript typecheck passed; 59 tests passed across 5 files.
- Latest Web integration CI: TypeScript check passed; 2,876 App unit tests passed.
- A P0 state-isolation defect was found and fixed: OpenCode Host `ctx.storage` is plugin-ID-scoped, not Location-scoped. The plugin now prefixes durable keys with `location:v1:<hash>:`, using the same Location hash as the filesystem.
- A P0 credential-boundary defect was fixed: `apiKey` is rejected in Plugin Options and can only be read from the Server process environment.
- Skill frontmatter now honors OpenCode's `disable-model-invocation` alias, with namespaced `metadata.opencode/autoinvoke` taking precedence.
- The regression test uses two plugin managers sharing one storage backend, with the same directory and different workspace IDs.

These checks do not prove live Go Store compatibility, browser behavior, process restart recovery or LLM invocation.

## 3. Phase 2 workstreams

### P2-0 — Freeze the real Go Store contract (P0)

**Input required:** the actual Go Store source repository or local source directory, plus a non-production endpoint and test credential available only to the local agent.

Inspect:
- Router registrations and OpenAPI definitions.
- Authentication middleware and exact header scheme.
- Catalog search query, pagination and filtering semantics.
- Asset detail, version and package DTOs.
- Platform / architecture selection semantics.
- Package content response: raw ZIP, redirect, content type and content length.
- ZIP root layout, including whether `SKILL.md` is at archive root.
- Rate limits, error body format and retry behavior.

Deliver:
- `docs/store-api-compatibility.md` with source paths and evidence.
- Contract fixtures copied from actual sanitized responses.
- Adapter mapping changes only where the real API requires them.
- A test proving a real package response matches declared SHA-256 and size.

**Gate:** no live installation until every required field and route is evidenced from the Go implementation or an authenticated test response.

### P2-1 — OpenCode Server Plugin deployment (P0)

- Verify the local OpenCode commit and `@opencode/plugin` version match the integration package.
- Load the plugin in the real Server process using the documented local path.
- Verify startup, plugin status, RPC registration and cleanup.
- Confirm the Store API key is visible only to the Server process.
- Confirm the configured install root is writable, persistent and private.
- Confirm the current Location and workspace identity used by the plugin.

**Gate:** the Web UI can call `catalogSearch`, `catalogDetail`, `installationList` and `operationList` against the selected Server without browser-to-Store traffic.

### P2-2 — Browser E2E (P0)

Add a focused Playwright scenario to the existing OpenCode App E2E harness; do not create a parallel browser test framework.

Scenario:
1. Open Settings → Extensions → Skills → Discover.
2. Search for a known, low-risk Skill.
3. Inspect details, version and package metadata.
4. Install once and observe operation state transitions.
5. Refresh the browser during installation; recover state from the Server.
6. Confirm Installed shows the exact version, digest and enabled state.
7. Update to a second version; confirm the old version remains available.
8. Disable and enable; verify the Runtime list changes.
9. Uninstall; verify the Runtime ID disappears and only the managed directory is removed.
10. Switch to another Location and verify no installation state is shared.
11. Open the same directory with a different workspace ID and verify state remains isolated.

Capture Playwright trace, screenshots and operation IDs with secrets and private project contents redacted.

**Gate:** browser E2E passes against a real running OpenCode Server with the plugin loaded. Fake Store may be used for deterministic UI fault tests, but at least one install must use the actual Go Store.

### P2-3 — Runtime and Agent proof (P0)

Use a Skill whose source and behavior are understood.

- Assert `ctx.skill.list()` contains the expected stable `ss-...` ID.
- Start a new Session on the same Location.
- Invoke `@ss-...`.
- Verify the Agent loads the installed Skill content without YAML frontmatter.
- Ask the Skill to read a known `references/proof.txt`.
- Verify the Agent reads the exact installed version's supporting file.
- Disable the Skill and verify it is no longer available to the model.
- Re-enable and verify it becomes available again.

Record Session ID, message IDs, Runtime ID, installed version and file path. Do not record prompt secrets or unrelated project contents.

**Gate:** a real model-backed Session successfully invokes the installed Skill and reads its supporting file. A successful HTTP response or filesystem write is insufficient.

### P2-4 — Recovery, concurrency and isolation hardening (P0/P1)

P0:
- Server restart during a queued or running install.
- Interrupted download and truncated ZIP.
- SHA mismatch and size mismatch.
- Runtime reload failure during update.
- Failure while persisting installation state.
- Two Locations sharing the same plugin storage namespace.
- Same directory with distinct workspace IDs.
- Verify legacy unscoped keys are not auto-assigned to a Location.

P1:
- Cancellation racing with commit.
- Disk-full behavior on the target filesystem.
- Multiple different-asset installs and queue visibility.
- Reconcile tampered installed files against a canonical extracted-tree digest.
- Verify event filtering includes workspace identity where applicable.

### P2-5 — Security and deployment boundary (P0)

For this phase, deploy only to a trusted single-tenant or tightly managed development Server.

Do not claim cross-user or cross-department authorization. The current plugin does not have a verified authenticated end-user principal in its RPC handler context.

Before multi-department production:
- Add trusted identity propagation from the Server boundary.
- Enforce Store authorization for list, detail, version and download requests.
- Add audit records and revocation semantics.
- Define shared Server and shared Location tenancy.
- Add publisher signatures and trusted key rotation.

## 4. Execution order

| Order | Work | Depends on | Exit evidence |
|---|---|---|---|
| 1 | Inspect actual Go Store source and freeze HTTP contract | Go source access | API compatibility report + contract fixtures |
| 2 | Deploy plugin in local OpenCode Server | Local OpenCode + plugin branch | RPC smoke tests + redacted logs |
| 3 | Install one real Store Skill | Steps 1–2 | Operation record + verified package digest |
| 4 | Run browser E2E | Step 3 | Playwright report / trace |
| 5 | Prove real Agent invocation and supporting-file read | Step 4 + configured LLM | Session/message evidence |
| 6 | Run restart, rollback and multi-Location tests | Steps 2–5 | Fault matrix + feedback artifact |
| 7 | Review release gate and PRs | All above | Explicit acceptance sign-off |

## 5. Definition of done

Do not mark Phase 2 complete unless all are true:

- [ ] Actual Go Store routes, auth and DTOs are verified.
- [ ] Real package ZIP SHA-256 and byte count match Store metadata.
- [ ] Browser install succeeds against the real Store.
- [ ] Runtime list contains the expected Skill ID.
- [ ] Real Agent Session loads the Skill.
- [ ] Agent reads a supporting file from the installed package.
- [ ] Update rollback preserves the previous working version.
- [ ] Browser refresh and Server restart recover durable state correctly.
- [ ] Two Locations and two workspace IDs do not share installation state.
- [ ] No Store credential or signed download URL appears in browser traffic or logs.
- [ ] The local feedback artifact records exact branches, commits, commands, exit codes and remaining blockers.

## 6. Non-goals for this phase

Do not add Agent Bundles, MCP installers, publisher studio, social ratings, auto-update, organization RBAC UI or marketplace redesign. These are downstream features and do not reduce the current integration risk.

## 7. Local execution prompt

Use `docs/pi-agent-prompt.md` as the executable handoff. It already includes repository inspection, secret handling, real Store contract discovery, OpenCode compatibility checks, test requirements and feedback format. Update it with new findings rather than creating a second competing deployment prompt.
