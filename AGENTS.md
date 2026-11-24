# Agent Instructions

## Source of truth
- Read docs/source-audit.md, docs/architecture.md, and docs/api-contract.md before changing integration behavior.
- The OpenCode fork's checked-out source and TypeScript types override design examples.
- The Go Skill Store's actual router/OpenAPI overrides candidate endpoint paths in this repository.
- Do not claim a test passed unless its command was executed and its exit code recorded.

## Security
- Never print, commit, or include API keys, tokens, signed URLs, or credential-bearing environment values in logs or feedback.
- Never let the browser choose a Store URL, package URL, filesystem path, or install directory.
- Treat every ZIP as untrusted. Keep path containment checks, symlink/special-file rejection, size limits, digest checks, and staging/atomic commit.
- Never execute scripts while installing a Skill.
- Do not overwrite non-Store Skills or remove files outside the plugin's own location-scoped install root.

## Engineering
- Preserve the OpenCode fork's local conventions and lockfile.
- Keep RPC schemas in sync between the fork's Web client and this repository's Server Plugin.
- Keep Store DTO mapping inside the Store adapter.
- Make install/update idempotent, recover interrupted operations, and preserve the prior active version on failure.
- Add tests for every bug fix and update the docs when behavior or API contracts change.
