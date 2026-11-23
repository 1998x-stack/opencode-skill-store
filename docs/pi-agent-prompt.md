# Pi Agent Deployment & Iteration Prompt

Copy this prompt into Pi Agent after opening both local repositories.

## Mission

Complete a real local deployment of the OpenCode Web × Go Skill Store integration using the user's existing LLM provider/API configuration. The final acceptance criterion is that an Agent in an OpenCode Session invokes a Skill installed from the Go Skill Store and reads its supporting files.

Repositories:
- OpenCode Fork: https://github.com/1998x-stack/opencode
- Integration: https://github.com/1998x-stack/opencode-skill-store

Branches:
- OpenCode: skill-store-ui
- Integration: skill-store-mvp

Read AGENTS.md, docs/source-audit.md, docs/architecture.md, docs/api-contract.md, docs/implementation-guide.md and docs/testing.md first.

## Non-negotiable rules

1. Inspect local Git status, branch, commit, package versions and uncommitted changes before running commands.
2. Never reset, clean, overwrite or discard user changes.
3. Keep changes on feature branches; never force-push or modify main.
4. Never print, commit or include API keys, tokens, Authorization headers, signed URLs or secret-bearing environment values.
5. Preserve existing OpenCode provider/model configuration. Do not overwrite it.
6. Never bypass SHA verification, ZIP path checks, permission checks or Runtime validation.
7. Never execute scripts contained in a downloaded Skill during installation.
8. Do not claim a test passed unless the command actually ran and its exit code was recorded.
9. If a required source, credential, route or permission is unavailable, record the blocker and continue with independent tests.

## Step 1 — Inspect the real Go Skill Store

Search the local workspace for the actual Go Skill Store source. This integration repository does not contain the Go backend.

Inspect router registrations, OpenAPI, auth middleware, catalog DTOs, detail/version DTOs, package metadata, package download behavior, object storage redirects and ZIP root layout.

Verify:
- Catalog search route and query names.
- Asset detail route.
- Package content/download route.
- Authentication header name and scheme.
- Pagination response.
- package_id, version, platform, arch, size_bytes and sha256.
- Whether package response is raw ZIP bytes or redirect.
- Whether ZIP root directly contains SKILL.md.

Do not infer actual API behavior from candidate paths in docs/api-contract.md. Update StoreClient mappings, route configuration, fixtures and docs to match the actual backend. Do not modify the Go backend unless its source is available and the change is necessary.

## Step 2 — Verify OpenCode API compatibility

Inspect actual Fork commit, Bun version, @opencode/plugin, @opencode/schema and @opencode/client versions.

Verify current Settings → Extensions → Skills UI, Server SDK reconnection behavior, ctx.location semantics, Skill.Info schema, ctx.skill.transform/reload/list, RPC registration and event payloads. Inspect `packages/core/src/plugin/host.ts`: `ctx.storage` is namespaced by plugin ID only, not by Location. Confirm the plugin prefixes every durable key with `location:v1:<hash>:` where the hash covers directory and optional workspaceID.

The Web contract at packages/app/src/settings/providers/skill-store-rpc.ts must exactly match the plugin contract at packages/opencode-skill-store-plugin/src/contracts.ts.

Adapt to actual local types rather than forcing stale examples.

## Step 3 — Detect LLM API configuration without exposing secrets

Check only presence of these variable names, never print values.

OpenAI-compatible:
- OPENAI_API_KEY
- OPENAI_BASE_URL
- OPENAI_MODEL

DeepSeek-compatible:
- DEEPSEEK_API_KEY
- DEEPSEEK_BASE_URL
- DEEPSEEK_MODEL

Inspect existing OpenCode provider/model configuration and preserve it. Use the configured provider for the real Agent proof.

Unit tests and fake Store tests must not require an LLM key. If no model is configured, finish deterministic tests and mark the real Agent proof blocked.

## Step 4 — Build and test Server Plugin

From packages/opencode-skill-store-plugin:
- Install dependencies.
- Run typecheck and all unit tests.
- Fix compile errors without weakening security.
- Add tests for every discovered bug.

Required cases:
- ZIP traversal, absolute path, Windows drive/UNC, reserved names.
- symlink, hardlink, special files, duplicate entries.
- entry count, package size, unpacked size and compression ratio.
- missing/empty SKILL.md and frontmatter fallback.
- wrong SHA and wrong byte count.
- same version with different digest.
- duplicate idempotency key and concurrent same-asset install.
- Runtime reload failure rollback.
- enable/disable/uninstall rollback.
- restart recovery and Location isolation, including two Locations sharing one plugin KV backend (same directory, different workspaceID) with no shared installations or operations.

## Step 5 — Configure the actual Store

Use server-only environment variables:
- SKILL_STORE_BASE_URL
- SKILL_STORE_API_KEY
- SKILL_STORE_API_KEY_HEADER
- SKILL_STORE_API_KEY_PREFIX
- SKILL_STORE_ASSETS_PATH
- SKILL_STORE_ASSET_DETAIL_PATH
- SKILL_STORE_PACKAGE_CONTENT_PATH
- OPENCODE_SKILL_STORE_DIR

Never ask the user to paste credentials into chat. Never place the key in Vite/browser variables or tracked files.

Run read-only checks first: catalog search, one detail request, package metadata and one small package download to a temporary directory. Verify actual SHA-256 and size before installing.

## Step 6 — Build the OpenCode Fork

From the OpenCode root:
- Install dependencies using the repository's expected Bun version.
- Run the repository check command.
- Run app unit tests.
- Run relevant Settings / Skills E2E tests.
- Start Server with the plugin loaded.
- Start Web and open Settings → Extensions → Skills.
- Verify Discover and Installed are visible.

If the plugin fails to load, inspect plugin resolution and Server logs with secrets redacted. Never solve it by adding browser-side Store requests.

## Step 7 — Real Store end-to-end installation

Use a low-risk Skill whose source is understood.

Verify:
1. Discover displays the real Store asset.
2. Detail displays the real version and package metadata.
3. installStart returns a durable operation ID.
4. Operation advances through resolving, downloading, verifying, extracting, committing and registering.
5. SHA and size match Store metadata.
6. Extracted root contains SKILL.md.
7. Supporting files preserve relative paths.
8. active.json points to the active version.
9. ctx.skill.list() contains the expected ss- Runtime ID.
10. Native Installed panel displays the same version and enabled state.

Then open a Session on the same Location:
- Invoke @ss-<asset-slug>-<hash>.
- Confirm Agent loads the installed Markdown body.
- Ask the Skill to read a known supporting file.
- Confirm the Agent reads that file from the same version directory.

Do not mark P0 complete if only API calls or ZIP writes succeeded.

## Step 8 — Failure, update and isolation tests

Run:
- Wrong SHA.
- Malicious ZIP path.
- Missing SKILL.md.
- Runtime reload failure.
- Update to a second version.
- Rollback to old active version after forced failure.
- Disable / enable.
- Uninstall.
- Browser refresh during install.
- Server restart during pending operation.
- Duplicate install click.
- Switch Location and confirm isolation.
- Reopen the same directory under a different workspaceID and confirm state isolation in both `ctx.storage` and the filesystem.

Use fake data and temporary directories for destructive/fault tests.

## Step 9 — Feedback artifact

Create feedback/iteration-YYYYMMDD-HHmm.md and feedback/manifest.json.

Record:
- Local time, OS and architecture.
- OpenCode, integration and Go Store branch/commit.
- Bun, OpenCode and plugin versions.
- Environment variable NAMES present only; never values.
- Actual Store route mapping and auth header name.
- Commands, exit codes, durations.
- Unit, integration and E2E results.
- Operation ID and Runtime Skill ID.
- Agent invocation and supporting-file proof.
- Bugs, root causes, changed files and commit SHAs.
- Remaining blockers and next iteration.

Suggested manifest:

~~~json
{
  "run_id": "iteration-YYYYMMDD-HHmm",
  "status": "passed | partial | blocked",
  "repositories": {
    "opencode": { "branch": "skill-store-ui", "commit": "..." },
    "integration": { "branch": "skill-store-mvp", "commit": "..." }
  },
  "checks": [
    { "name": "plugin-typecheck", "status": "passed", "exit_code": 0 },
    { "name": "runtime-agent-proof", "status": "blocked", "reason": "..." }
  ],
  "secrets_redacted": true
}
~~~

Never include an environment dump or secret values.

## Iteration protocol

At the end:
1. Separate implemented code from tests actually executed.
2. Fix P0 failures before adding P1 features.
3. Commit focused changes on feature branches.
4. Do not merge or force-push.
5. Leave a clean working tree or list remaining changes.
6. Tell the user which feedback file to bring back to ChatGPT.

Begin by inspecting the local repositories and actual Go Store source. Do not assume the example API routes are correct.
