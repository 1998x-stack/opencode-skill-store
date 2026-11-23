# Local Deployment & Acceptance Guide

## 1. Prerequisites

- macOS or Linux development machine.
- Bun 1.4.4 for the inspected OpenCode Fork.
- Git.
- Access to the Go Skill Store HTTP endpoint.
- An OpenCode provider/model already configured, or LLM API environment values supplied by your administrator.

This guide does not require committing API credentials.

## 2. Clone the two repositories and branches

~~~bash
git clone https://github.com/1998x-stack/opencode.git
cd opencode
git fetch origin
git checkout skill-store-ui
bun --version
~~~

In another directory:

~~~bash
git clone https://github.com/1998x-stack/opencode-skill-store.git
cd opencode-skill-store
git fetch origin
git checkout skill-store-mvp
~~~

## 3. Install dependencies

~~~bash
# OpenCode Fork
cd /path/to/opencode
bun install

# Integration plugin
cd /path/to/opencode-skill-store/packages/opencode-skill-store-plugin
bun install
bun test
bun run typecheck
~~~

The plugin package targets OpenCode Plugin API 2.3.2. Keep its @opencode/plugin version compatible with the actual local Fork package version.

## 4. Verify the real Go Store API before connecting

The plugin defaults to candidate routes:
- /v1/asset-store/assets
- /v1/asset-store/assets/{id}
- /v1/asset-store/packages/{id}/content

Before running against a real Store:
1. Open the Go Store repository / deployment source.
2. Inspect HTTP router registrations and OpenAPI (if present).
3. Confirm search query names and pagination shape.
4. Confirm asset detail fields and package metadata fields.
5. Confirm package download returns raw ZIP bytes.
6. Configure path overrides if actual routes differ.

Do not proceed with an unverified assumption if the actual Store API returns a different contract.

## 5. Configure the OpenCode Server

Copy examples/opencode.jsonc into the applicable OpenCode config, then replace the plugin directory with an absolute path.

~~~json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-skill-store/packages/opencode-skill-store-plugin",
      "options": {
        "storeBaseUrl": "https://skill-store.internal",
        "installRoot": "/absolute/path/to/persistent/opencode-skill-store",
        "maxPackageBytes": 104857600,
        "maxUnpackedBytes": 314572800,
        "maxSkillFileBytes": 2097152,
        "maxEntries": 2000,
        "maxCompressionRatio": 100
      }
    }
  ]
}
~~~

Set secrets only in the OpenCode Server process environment:

~~~bash
export SKILL_STORE_BASE_URL="https://skill-store.internal"
export SKILL_STORE_API_KEY="..."
export SKILL_STORE_API_KEY_HEADER="Authorization"
export SKILL_STORE_API_KEY_PREFIX="Bearer "
~~~

If the actual Go Store uses a different API header or paths:

~~~bash
export SKILL_STORE_API_KEY_HEADER="X-Service-Key"
export SKILL_STORE_API_KEY_PREFIX=""
export SKILL_STORE_ASSETS_PATH="/actual/catalog/route"
export SKILL_STORE_ASSET_DETAIL_PATH="/actual/assets/{id}"
export SKILL_STORE_PACKAGE_CONTENT_PATH="/actual/packages/{id}/download"
~~~

Do not put these values in the browser's Vite environment or a committed .env file.

## 6. LLM provider configuration

This integration does not require a new model provider. Preserve the existing OpenCode provider configuration.

If your environment provides OpenAI-compatible settings, the local process may receive:
- OPENAI_API_KEY
- OPENAI_BASE_URL
- OPENAI_MODEL

For DeepSeek-compatible settings:
- DEEPSEEK_API_KEY
- DEEPSEEK_BASE_URL
- DEEPSEEK_MODEL

Use the provider configuration format supported by the checked-out OpenCode version. Do not echo secrets in terminal logs or feedback. The Pi Agent prompt asks the agent to detect existing configuration and avoid overwriting it.

## 7. Start Server and Web

Terminal A — OpenCode Server:

~~~bash
cd /path/to/opencode
bun run dev --port 4096
~~~

Terminal B — OpenCode Web:

~~~bash
cd /path/to/opencode
bun run dev:web
~~~

Open the Web app, connect to the local Server at http://127.0.0.1:4096 if prompted, and open Settings → Extensions → Skills.

## 8. Verify Discover and Install

1. Open the Discover subtab.
2. Search for a known Skill from the real Store.
3. Open Details and inspect version metadata.
4. Install the Skill.
5. Switch to Installed and wait for terminal operation state installed.
6. Confirm the Skill appears in the native Skills list above the Store panel.

Server-side disk checks:

~~~bash
find "$OPENCODE_SKILL_STORE_DIR" -maxdepth 6 -type f | sort
~~~

Expected:
- skills/ss-.../active.json
- skills/ss-.../versions/<version>/SKILL.md
- skills/ss-.../versions/<version>/.store-manifest.json
- supporting files under the same version directory.

The plugin derives a Location hash subdirectory under the configured root.

## 9. Prove the Agent can use it

In a Session on the same Location, type:

~~~text
@ss-<asset-slug>-<hash>
~~~

The exact ID is shown in the Installed panel. The Agent should load the Markdown body without YAML frontmatter. For a stronger proof, install the example Skill that directs the Agent to read references/proof.txt.

## 10. Update, disable, remove

- Check updates in Installed.
- Update to the latest version.
- Confirm active.json points to the new version and the old version remains.
- Disable and verify the Skill is no longer registered.
- Enable and verify it returns.
- Remove and verify only the plugin-managed directory is deleted.

## 11. Run checks

~~~bash
# OpenCode Fork
cd /path/to/opencode
bun run check
cd packages/app
bun run test:unit
bun run test:e2e --grep "skill store"

# Server Plugin
cd /path/to/opencode-skill-store/packages/opencode-skill-store-plugin
bun test
bun run typecheck
~~~

Record exact command, exit code, duration and commit SHA in feedback/. Do not report success without executing.

## 12. Troubleshooting

| Symptom | Inspect |
|---|---|
| Discover says not configured | Server process has SKILL_STORE_BASE_URL; restart Server after env changes |
| HTTP 404 | Actual Go Store router path differs; set path override |
| HTTP 401/403 | API key, header name and prefix; never print the secret |
| No compatible package | Store platform/arch metadata must match Server platform/arch or any |
| Digest mismatch | Store package metadata SHA and actual ZIP bytes; do not bypass |
| Invalid archive | Root SKILL.md, path entries, duplicate entries, symlink/special files, size limits |
| Skill not in Runtime | Check operation terminal error, SKILL.md parse, path permissions, ctx.skill.reload() and ctx.skill.list() |
| Agent cannot load Skill | Check exact case-sensitive Runtime ID and Agent skill permission rules |
| Supporting file missing | ZIP must preserve the directory tree beside SKILL.md |
| Another project sees different installed list | Expected Location isolation; confirm the active Location in Web |

## 13. Rollback

If the UI integration is not ready, remove the local plugin entry from opencode.jsonc and restart Server. The Store-managed directory remains untouched. To restore the prior OpenCode Web behavior, check out the original branch/commit; do not delete user Skill directories.
