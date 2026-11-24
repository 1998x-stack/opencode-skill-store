# ADR-0001: Location-scoped Skill Store installations

Status: Accepted for P0  
Date: 2026-11-23

## Context

The inspected OpenCode Fork exposes a Location-scoped Skill Runtime. A Server Plugin receives ctx.location describing the Location where its plugin instance is loaded. The current Settings Extensions Skills view reads the active Location's Skill registry.

A Server-global installation manifest would create ambiguous behavior when the same Server serves multiple project Locations.

## Decision

P0 stores files under a stable hash of `ctx.location.directory` plus optional `workspaceID`.

OpenCode's `ctx.storage` is namespaced by plugin ID only, not automatically by Location. Therefore every durable key must also use an explicit versioned Location prefix, `location:v1:<location-hash>:`. Runtime registration remains scoped to the plugin's active Location.

## Consequences

- The same Store Skill may be installed independently into multiple Locations.
- Filesystem paths and durable `ctx.storage` keys use the same Location hash.
- Unscoped legacy keys (`installations`, `operations`) are not auto-migrated: their owning Location cannot be determined safely. If any pre-release local data exists, preserve it for manual recovery rather than copying it into every Location.
- The same plugin ID can serve multiple Locations without sharing installation or operation records.
- Web event listeners filter by `event.location.directory`; workspace-aware event filtering is a follow-up for same-directory workspaces.
- Disk usage may duplicate identical Skill versions across Locations.

## Future option

A future server-global mode must define explicit scope selection, shared state database, cross-instance lock, cross-Location Runtime reload notification and authorization semantics for shared installations.

Do not implement global sharing by simply removing the Location hash.
