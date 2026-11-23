# API Contract

## 1. 边界说明

此文件定义本集成插件所需的 Go Skill Store 最小 HTTP 契约，以及 OpenCode Web ↔ Server Plugin 的 RPC 契约。

当前 GitHub 集成仓库不包含 Go Store 后端源码。默认 HTTP 路径是 Adapter 的候选值，必须对照真实 Go Router/OpenAPI 验证。

## 2. Go Skill Store HTTP API（候选）

### 2.1 Catalog Search

GET /v1/asset-store/assets

Query:
- kind=skill
- q=<search text>
- limit=24
- cursor=<opaque cursor>

Expected normalized response:

~~~json
{
  "data": {
    "items": [
      {
        "asset_id": "deep-research",
        "title": "Deep Research",
        "description": "Evidence-driven research workflow",
        "kind": "skill",
        "tags": ["research", "evidence"],
        "latest_version": "1.3.0"
      }
    ],
    "cursor": { "next": null }
  }
}
~~~

Adapter also accepts root-level items / assets, and aliases id, name, type, summary, latestVersion, next_cursor.

### 2.2 Asset Detail

GET /v1/asset-store/assets/{asset_id}

Expected normalized response:

~~~json
{
  "data": {
    "asset": {
      "asset_id": "deep-research",
      "title": "Deep Research",
      "description": "Evidence-driven research workflow",
      "kind": "skill",
      "tags": ["research"],
      "latest_version": "1.3.0"
    },
    "versions": [
      {
        "version": "1.3.0",
        "packages": [
          {
            "package_id": "pkg_123",
            "version": "1.3.0",
            "platform": "any",
            "arch": "any",
            "size_bytes": 18293,
            "sha256": "64-hex-character-sha256"
          }
        ]
      }
    ]
  }
}
~~~

Supported aliases include id, packageId, artifacts, sizeBytes, checksum, architecture.

### 2.3 Package Download

GET /v1/asset-store/packages/{package_id}/content

Response: raw ZIP bytes. Plugin streams the body to a staging file and calculates SHA-256 while writing.

Required metadata:
- package_id
- version
- size_bytes
- sha256
- package platform/arch must be explicit (`any` is not inferred when omitted)
- platform / arch (or any)

Do not return a browser-facing signed URL. If the actual Store uses signed URLs internally, the server adapter must validate the allowed origin and keep the URL server-side.

## 3. Transport and response limits

- Store base URL must use HTTPS; plain HTTP is permitted only for loopback development endpoints (localhost, 127.0.0.1, ::1).
- Configured API routes must be absolute paths on the configured Store origin; cross-origin routes and redirects are rejected.
- JSON metadata responses are capped at 5 MiB.
- Downloaded ZIP bytes are capped by maxPackageBytes; extracted content is capped by maxUnpackedBytes; root SKILL.md is separately capped by maxSkillFileBytes (2 MiB by default) before YAML parsing.
- Install root, Location subdirectories and staging directories are private (0700); symlink directories are rejected.

## 4. Authentication

Defaults:
- Header: Authorization
- Prefix: Bearer 
- Secret: SKILL_STORE_API_KEY

Override:
- SKILL_STORE_API_KEY_HEADER
- SKILL_STORE_API_KEY_PREFIX

If the real Go Store expects X-Service-Key or another header, configure it rather than hardcoding a second credential path.

## 4. Route overrides

- SKILL_STORE_ASSETS_PATH
- SKILL_STORE_ASSET_DETAIL_PATH — use {id} placeholder.
- SKILL_STORE_PACKAGE_CONTENT_PATH — use {id} placeholder.

Plugin options support corresponding camelCase fields: assetsPath, assetDetailPath, packageContentPath.

## 5. OpenCode RPC Contract

RPC ID: skill-store

| Method | Input | Output | Purpose |
|---|---|---|---|
| catalogSearch | query?, cursor?, limit? | configured, items, nextCursor | Discover |
| catalogDetail | assetId | asset, versions | Detail |
| installationList | {} | items | Location installed state |
| operationList / operationGet | {} / operationId | items / operation | Restore operation view |
| installStart | assetId, version?, idempotencyKey | operationId, state | Async install/update |
| operationCancel | operationId | cancelled | Explicit cancel |
| installationSetEnabled | installationId, enabled | item | Runtime enable/disable |
| installationPin | installationId, version/null | item | Pin/unpin |
| installationUninstall | installationId | removed | Remove Runtime entry and files |
| updateCheck | {} | updates | Compare latest versions |

Events:
- operationProgress: complete operation snapshot.
- installationChanged: installationId + action.

RPC JSON Schema is duplicated in:
- packages/opencode-skill-store-plugin/src/contracts.ts
- OpenCode Fork packages/app/src/settings/providers/skill-store-rpc.ts

Any contract change must update both files in one change set. JSON Schema RPC values are unknown in TypeScript; narrow at the handler boundary.

## 6. Operation model

State: queued, running, installed, failed, cancelled, interrupted.

Stage: resolving, downloading, verifying, extracting, committing, registering, terminal.

The operation record is durable and authoritative. RPC events are only a live progress channel.
