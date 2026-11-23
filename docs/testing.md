# Test Plan & Acceptance Matrix

## 1. Current status

The source files and test cases are committed, but this task environment cannot clone GitHub repositories over the container network. Therefore no local Bun typecheck, unit test, Playwright run, or real Agent invocation is claimed as passed. Run the commands below on the target machine and attach their outputs to feedback/.

## 2. Server Plugin unit tests

From packages/opencode-skill-store-plugin/:

~~~bash
bun install
bun test
bun run typecheck
~~~

Covered:
- safe ZIP path resolution and rejection of traversal, absolute paths, Windows drive/UNC, reserved names, alternate data streams.
- SKILL.md frontmatter parsing, metadata fallback and opencode/autoinvoke.

Add before production:
- real ZIP fixture extraction test with symlink and duplicate entries.
- package digest mismatch test.
- oversized / compression bomb test.
- immutable version conflict test.
- failed Runtime reload rollback test.
- interrupted operation recovery test.
- concurrent same-asset install test.

## 3. OpenCode Fork checks

From the OpenCode Fork root (Bun version from repository packageManager is bun@1.4.4):

~~~bash
bun install
bun run check
cd packages/app
bun run test:unit
bun run test:e2e --grep "skill store"
~~~

The E2E keeper suite should live in the existing Settings regression suite; follow packages/app/e2e/AGENTS.md. Do not add a new Playwright setup helper if the shared mock-server harness can be extended.

## 4. Store adapter integration tests

Use a local fake Store HTTP server with deterministic fixtures:
- catalog search returns 2 Skills and pagination.
- detail returns versions 1.0.0 and 1.1.0.
- package endpoint returns a valid ZIP fixture.
- wrong SHA, wrong size, malformed JSON, 401, 403, 404, 429, 500, timeout and truncated body.

No production API Key is required for tests.

## 5. Browser E2E

Scenario:
1. Start OpenCode Server with the Skill Store Plugin and fake Store.
2. Open Settings → Extensions → Skills → Discover.
3. Search for test-skill.
4. Open Details and confirm version 1.0.0.
5. Install once; verify one operation ID and progress stages.
6. Switch to Installed; verify the version and enabled state.
7. Update to 1.1.0; verify active version changes and old version remains on disk.
8. Disable and enable; verify Runtime list changes.
9. Uninstall; verify Runtime ID disappears and only the plugin-managed directory is removed.
10. Switch to another Location; verify the first Location's installation does not appear.

## 6. Runtime proof

The definitive acceptance test is not a 200 response or a successful ZIP write.

- Call ctx.skill.list() and assert ss-<slug>-<hash> is present.
- Start a real Session on the same Location.
- Send @ss-<slug>-<hash>.
- Verify the conversation contains the installed Skill body, without YAML frontmatter.
- Make the Skill instruct the Agent to read references/proof.txt.
- Verify the Agent can read that file from the installed version directory.

Capture operation ID and state snapshots, Runtime Skill IDs, Session message IDs, test command, exit code, duration and commit SHA. Do not capture secrets or full user project contents.

## 7. Fault injection

| Fault | Expected result |
|---|---|
| SHA mismatch | Fail before extraction / Runtime registration |
| ZIP Slip entry | Reject archive; no file outside staging |
| Symlink / special file | Reject archive |
| Missing SKILL.md | Reject archive |
| Disk full during staging | Remove staging; preserve old active |
| Runtime reload fails | Restore previous active.json and previous install record |
| Browser disconnect | Server operation continues; reconnect reads operationList |
| Server restart | Pending operation becomes interrupted; staging cleaned |
| Duplicate install click | Idempotent request returns same operation |
| Different Location | No cross-Location installation visibility |

## 8. Feedback format

Each test run writes a sanitized feedback/iteration-YYYYMMDD-HHmm.md. Never include API keys, Authorization headers, full signed URLs, or user project file contents.


## Additional hardening regression coverage

- Store HTTP routes cannot change origin; redirects are rejected and download requests time out.
- Catalog queries and identifiers have explicit length bounds.
- Missing asset kind or package platform/architecture is not silently treated as a Skill or universal package.
- `SKILL.md` has a separate 2 MiB cap before YAML parsing.
- Runtime restore validates persisted runtime IDs, version segments and resolved paths remain inside the managed install root.
- Store-provided descriptions survive OpenCode Server restarts when SKILL.md has no description.
- Concurrent mutations are serialized; rollback failure still transitions the operation to a terminal state.
