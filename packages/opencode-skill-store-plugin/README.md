# OpenCode Skill Store Server Plugin

A location-scoped OpenCode Server Plugin that connects the Go Skill Store to OpenCode's native Skill Runtime.

## Compatibility

- OpenCode Plugin API: 2.3.2
- Runtime: OpenCode Server (Bun / Node-compatible APIs)
- Package entry: src/index.ts
- RPC contract: src/contracts.ts

## Local configuration

Load this directory from opencode.jsonc:

~~~json
{
  "plugins": [
    {
      "package": "/absolute/path/to/packages/opencode-skill-store-plugin",
      "options": {
        "storeBaseUrl": "https://skill-store.internal"
      }
    }
  ]
}
~~~

Set SKILL_STORE_BASE_URL and SKILL_STORE_API_KEY in the Server process environment. See docs/implementation-guide.md.

## Tests

~~~bash
bun install
bun test
bun run typecheck
~~~

The Store route defaults are candidate paths. Verify them against your actual Go Store router/OpenAPI.
