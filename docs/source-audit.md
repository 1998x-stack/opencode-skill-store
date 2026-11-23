# OpenCode Fork Source Audit

Audit date: 2026-11-23  
Fork: https://github.com/1998x-stack/opencode  
Branch inspected: dev  
Commit inspected: 26f4041911bbfbb101fbb5ae64409ca59e61020a  
OpenCode package version: 2.3.2

## Verified facts from the fork

| File | Verified behavior | Integration decision |
|---|---|---|
| packages/app/src/settings/providers/extensions.tsx | Settings Extensions already has a Skills subtab; it lists data.location.skill.list() entries and syncs the current location's Skill registry. | Extend this page with Store Discover / Installed instead of adding a duplicate route. |
| packages/app/src/settings/shell.tsx | Settings navigation is composed from built-in tabs and plugin pages; Extensions is already a server-scoped settings panel. | Keep the feature inside the existing Settings navigation and selected Server context. |
| packages/app/src/runtime/server/client.tsx | useServerSDK() exposes the active server SDK; its API transport can be replaced when a managed server reconnects. | Create the RPC subclient from the current serverSdk.api at call time. |
| packages/app/src/runtime/server/api.ts | createApiForServer() wraps OpenCode.make() from @opencode/client/promise. | Use serverSdk.api.rpc(SkillStoreRPC). |
| packages/plugin/src/promise/rpc.ts | Server Plugin RPC handlers receive input plus { signal, error }; RPC registration returns events and dispose. | Implement one typed RPC surface with durable operation queries and live progress events. |
| packages/plugin/src/promise/skill.ts | Plugin API exposes ctx.skill.transform() and ctx.skill.reload(). | Register installed Skills through the native Skill Runtime. |
| packages/core/src/plugin/host.ts | `storage(kv, pluginID)` prefixes keys with the plugin ID only; it does not add `ctx.location`. | Prefix every durable installation/operation key with the explicit Location hash. |
| packages/schema/src/skill.ts | Skill.Info includes id, name, optional description/autoinvoke, absolute path and Markdown content. | Keep the extracted directory and point Runtime path at the installed SKILL.md. |
| packages/app/src/runtime/i18n/en.ts | English translations are centralized in the app dictionary. | Add localized labels rather than hardcoding visible UI copy. |

## Important Location semantics

OpenCode Server Plugin documentation says ctx.location describes the Location where the plugin instance is loaded. It includes directory, optional workspaceID, and project metadata; it is not the location of every session/event.

Therefore:
- Plugin instances and Skill Runtime transforms are Location-aware, but `ctx.storage` is only plugin-ID namespaced by the host implementation.
- The install root includes a stable hash of `ctx.location.directory` and optional `workspaceID`.
- Durable keys must independently include the same Location hash (for example, `location:v1:<hash>:installations`); `ctx.storage` does not provide this isolation automatically.
- Web event listeners currently filter by `event.location.directory`; workspace-aware filtering remains a follow-up where multiple workspace IDs can share a directory.
- A two-Location integration test must share the same underlying plugin KV store to prove that records do not cross boundaries.

This refines the earlier server-global installation assumption.

## Not verified

The current repository does not include the user's Go Skill Store source. Candidate Store paths in docs/api-contract.md are not asserted to exist. Verify them against the actual Go router/OpenAPI before deployment.

## Relevant upstream references

- Server Plugin: https://opencode.ai/docs/build/plugins/server/
- Plugin RPC: https://opencode.ai/docs/build/plugins/rpc/
- Skills: https://opencode.ai/docs/skills/
- OpenCode fork: https://github.com/1998x-stack/opencode
