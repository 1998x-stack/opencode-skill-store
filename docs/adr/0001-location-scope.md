# ADR-0001: Location-scoped Skill Store installations

Status: Accepted for P0  
Date: 2026-11-23

## Context

The inspected OpenCode Fork exposes a Location-scoped Skill Runtime. A Server Plugin receives ctx.location describing the Location where its plugin instance is loaded. The current Settings Extensions Skills view reads the active Location's Skill registry.

A Server-global installation manifest would create ambiguous behavior when the same Server serves multiple project Locations.

## Decision

P0 stores installations under a stable hash of ctx.location.directory. Plugin durable state and Runtime registration are treated as belonging to that Location.

## Consequences

- The same Store Skill may be installed independently into multiple Locations.
- Web event listeners filter by event.location.directory.
- A different Location does not inherit the current Location's installed list.
- Disk usage may duplicate identical Skill versions across Locations.

## Future option

A future server-global mode must define explicit scope selection, shared state database, cross-instance lock, cross-Location Runtime reload notification and authorization semantics for shared installations.

Do not implement global sharing by simply removing the Location hash.
