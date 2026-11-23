# Code Category / Module Map

## 1. Integration repository

~~~text
opencode-skill-store/
├── AGENTS.md
├── README.md
├── .env.example
├── examples/
│   ├── opencode.jsonc
│   └── skills/hello-skill/
│       ├── SKILL.md
│       └── references/proof.txt
├── packages/
│   └── opencode-skill-store-plugin/
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts
│           ├── config.ts
│           ├── contracts.ts
│           ├── store/client.ts
│           ├── installer/manager.ts
│           ├── installer/archive.ts
│           └── runtime/frontmatter.ts
├── docs/
│   ├── architecture.md
│   ├── architecture.html
│   ├── implementation-guide.md
│   ├── api-contract.md
│   ├── testing.md
│   ├── source-audit.md
│   ├── code-map.md
│   └── pi-agent-prompt.md
├── scripts/render-pdf.mjs
└── .github/workflows/docs-pdf.yml
~~~

## 2. Module responsibilities

| Module | Responsibility | Must not do |
|---|---|---|
| config | Parse env/options, derive Location install root, enforce size limits | Read credentials from browser input |
| contracts | Define RPC schemas and DTOs | Contain HTTP or filesystem logic |
| store/client | Store auth, URL/path construction, DTO normalization, streaming download | Expose secret headers or signed URLs to UI |
| installer/manager | Operation lifecycle, idempotency, persistence, transaction, rollback | Execute Skill scripts |
| installer/archive | Validate archive entry paths/types/limits and extract | Trust ZIP names or modes |
| runtime/frontmatter | Parse SKILL.md metadata/body | Infer runtime ID from display name |
| index | Plugin lifecycle, RPC registration, cleanup | Contain business logic |

## 3. OpenCode Fork modifications

~~~text
packages/app/src/settings/providers/
├── extensions.tsx             # embed Store experience in existing Skills subtab
├── skill-store.tsx             # Discover / Installed UI
└── skill-store-rpc.ts          # client-side copy of typed contract

packages/app/src/runtime/i18n/en.ts
└── skillStore.*                # localized UI strings
~~~

## 4. Future modules (not P0)

- publisher/: publishing workflow, provenance, review and signing.
- policy/: organization, department, team and project RBAC.
- signature/: Ed25519 manifest verification and key rotation.
- cache/: ETag, catalog TTL and package cache.
- adapters/agent/: Agent Bundle installer (requires a separate Runtime contract).
- adapters/mcp/: MCP configuration adapter (must not be conflated with Skill Runtime).
- observability/: metrics exporter and audit event sink.
