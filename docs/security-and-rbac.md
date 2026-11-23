# Security and RBAC: P0 Scope and Production Gate

## What P0 implements

- Browser -> OpenCode Server Typed RPC, never direct browser -> Go Store.
- Server-only API Key and ZIP download.
- SHA-256 package integrity verification and archive-entry filtering.
- Install files and durable `ctx.storage` records isolated by a versioned OpenCode Location hash (`directory` + optional `workspaceID`). The host's storage namespace is plugin-ID-only, so this isolation is implemented explicitly in the key prefix.
- Only plugin-created Runtime IDs, prefixed with `ss-`, are managed.
- ZIP installation does not execute contained scripts.
- `SKILL.md` is capped separately at 2 MiB before YAML parsing; the full archive remains subject to independent entry, byte and compression-ratio limits.
- Runtime restore validates Store-owned IDs, version path segments and real paths against the managed install root.

## What P0 does not implement

**Per-user and cross-department authorization is not implemented.**

The audited OpenCode Promise RPC handler context exposes `signal` and declared `error`, but no verified end-user principal. A browser-provided `userId`, `departmentId` or bearer token would be untrusted and must not be accepted as an authorization claim.

A single broad Store service token can access any asset authorized for that service. A server that allows unrelated users to call `catalogSearch`, `catalogDetail` or `installStart` through the same token must not claim per-department isolation simply because local install directories differ.

Until end-user identity and policy enforcement are implemented, deploy only on a trusted single-tenant or tightly managed development Server. Do not expose this build as a multi-department self-service production platform.

## Production authorization design

1. Authenticate the request at the OpenCode Server boundary using an organization-controlled identity provider; preserve the signed, verified subject, tenant and department in server-owned request context.
2. Extend the plugin/RPC boundary through an upstream-supported authenticated principal API or a reviewed core extension. The client must never choose its own organization/department identity.
3. Delegate authorization to Go Store on every catalog list, detail, version, package metadata and download request. Never rely only on hiding UI rows.
4. Support asset visibility scopes: `private`, `project`, `department`, `organization`; evaluate membership and role, including disabled/revoked users.
5. Separate the OpenCode Server's machine credential from delegated human claims. Use short-lived, auditable delegation, audience restrictions and TLS.
6. Record audit events for subject, tenant, Location, asset, version, digest, operation, decision and timestamps. Do not log content or secrets.
7. Enforce operation permissions for install/update/uninstall/enable/pin, not only catalog visibility.
8. Add package signing (publisher attestation and trusted key rotation); SHA-256 alone is not proof of publisher identity.
9. Add quotas, rate limits, asset allowlists/deny rules and review/approval workflows for high-risk Skills.
10. Run a security review of the agent's runtime permissions: a Skill is instruction content and supporting files, not a trusted executable.

## Data isolation

Runtime Location isolation, Store tenant authorization and filesystem process isolation are distinct controls:
- `ctx.storage` is not automatically Location-scoped; the integration must prefix every durable key with the Location hash. The P0 regression test must instantiate two Locations over one shared plugin KV backend.
- Location isolation avoids mixing installed records between project directories.
- Store tenant authorization controls which assets may be discovered/downloaded.
- OS/container isolation limits what an Agent can read or execute after installation.

A completed production design must prove all three, not merely one.

## Multi-tenant acceptance tests

- User A in Department X cannot list, fetch detail, download or install Department Y's private assets.
- User B with organization scope can access only explicitly organization-shared assets.
- Revoked membership invalidates access, including cached links and in-flight authorized requests as policy permits.
- Mutating requests with wrong tenant/Location fail without filesystem changes.
- Untrusted client-supplied identity headers are ignored.
- Audit records identify the authorized subject without leaking credentials.
- Same asset IDs across tenants do not collide in Runtime identifiers or persistent state.

See docs/architecture.md, docs/api-contract.md and docs/testing.md for the implementation baseline.
