import type { AssetDetail, AssetSummary, PackageInfo } from "../contracts.js"
import type { StoreConfig } from "../config.js"

type JsonObject = Record<string, unknown>

function record(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {}
}

function valueString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

function valueNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0
}

function first(object: JsonObject, ...keys: string[]): unknown {
  for (const key of keys) if (object[key] !== undefined && object[key] !== null) return object[key]
  return undefined
}

function normalizeAsset(input: unknown): AssetSummary {
  const row = record(input)
  const tags = first(row, "tags", "labels")
  const version = first(row, "latest_version", "latestVersion", "version")
  return {
    assetId: valueString(first(row, "asset_id", "assetId", "id")),
    title: valueString(first(row, "title", "name", "display_name")),
    description: valueString(first(row, "description", "summary")),
    kind: valueString(first(row, "kind", "type")).trim().toLowerCase(),
    tags: Array.isArray(tags) ? tags.filter((item): item is string => typeof item === "string") : [],
    latestVersion: typeof version === "string" ? version : null,
  }
}

function normalizePackage(input: unknown): PackageInfo {
  const row = record(input)
  return {
    packageId: valueString(first(row, "package_id", "packageId", "id")),
    version: valueString(first(row, "version")),
    platform: valueString(first(row, "platform", "os")).trim().toLowerCase(),
    arch: valueString(first(row, "arch", "architecture")).trim().toLowerCase(),
    sizeBytes: valueNumber(first(row, "size_bytes", "sizeBytes", "size")),
    sha256: valueString(first(row, "sha256", "checksum")).toLowerCase(),
  }
}

export class StoreClient {
  constructor(private readonly config: StoreConfig) {}

  get configured() {
    return this.config.baseUrl !== undefined
  }

  async search(input: { query?: string; cursor?: string; limit?: number }) {
    if (!this.config.baseUrl) return { configured: false, items: [], nextCursor: null }
    if ((input.query?.length ?? 0) > 256) throw new Error("Catalog query must be 256 characters or fewer")
    if ((input.cursor?.length ?? 0) > 2048) throw new Error("Catalog cursor is too long")
    const url = this.url(this.config.assetsPath)
    url.searchParams.set("kind", "skill")
    const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(100, Math.floor(input.limit!))) : 24
    url.searchParams.set("limit", String(limit))
    if (input.query?.trim()) url.searchParams.set("q", input.query.trim())
    if (input.cursor) url.searchParams.set("cursor", input.cursor)

    const body = record(await this.json(url, signal))
    const data = record(body.data ?? body)
    const rows = Array.isArray(data.items) ? data.items : Array.isArray(data.assets) ? data.assets : []
    const cursor = first(record(data.cursor), "next", "next_cursor") ?? first(data, "next_cursor", "nextCursor")
    return {
      configured: true,
      items: rows.map(normalizeAsset).filter((item) => item.assetId && item.title && item.kind === "skill"),
      nextCursor: typeof cursor === "string" && cursor ? cursor : null,
    }
  }

  async detail(assetId: string, signal?: AbortSignal): Promise<AssetDetail> {
    if (!assetId.trim()) throw new Error("assetId is required")
    if (assetId.length > 512) throw new Error("assetId is too long")
    const url = this.url(this.config.assetDetailPath.replace("{id}", encodeURIComponent(assetId)))
    const body = record(await this.json(url))
    const data = record(body.data ?? body)
    const rawAsset = first(data, "asset", "item") ?? data
    const rawVersions = first(data, "versions", "releases")
    const versions = Array.isArray(rawVersions)
      ? rawVersions.map((entry) => {
          const row = record(entry)
          const packages = first(row, "packages", "artifacts")
          return {
            version: valueString(first(row, "version", "tag")),
            packages: Array.isArray(packages) ? packages.map(normalizePackage) : [],
          }
        })
      : []
    return { asset: normalizeAsset(rawAsset), versions }
  }

  async download(packageId: string, signal: AbortSignal): Promise<Response> {
    if (!packageId.trim()) throw new Error("packageId is required")
    if (packageId.length > 512) throw new Error("packageId is too long")
    const url = this.url(this.config.packageContentPath.replace("{id}", encodeURIComponent(packageId)))
    const response = await fetch(url, {
      method: "GET",
      headers: this.headers("application/zip, application/octet-stream"),
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      redirect: "error",
    })
    if (!response.ok) throw new Error("Skill Store package download failed: HTTP " + response.status)
    if (!response.body) throw new Error("Skill Store returned an empty package body")
    return response
  }

  private url(route: string) {
    if (!this.config.baseUrl) throw new Error("SKILL_STORE_BASE_URL is not configured on the OpenCode Server")
    if (!route.startsWith("/") || route.startsWith("//") || route.includes("\\") || /[\u0000-\u001f]/.test(route))
      throw new Error("Skill Store routes must be absolute paths on the configured origin")
    const url = new URL(route, this.config.baseUrl)
    if (url.origin !== this.config.baseUrl.origin) throw new Error("Skill Store route changed the configured origin")
    return url
  }

  private headers(accept = "application/json") {
    const headers = new Headers({ accept })
    if (this.config.apiKey) headers.set(this.config.apiKeyHeader, this.config.apiKeyPrefix + this.config.apiKey)
    return headers
  }

  private async json(url: URL, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(15_000)
    const response = await fetch(url, {
      headers: this.headers(),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: "error",
    })
    if (!response.ok) throw new Error("Skill Store API failed: HTTP " + response.status + " (" + url.pathname + ")")
    return response.json()
  }
}
