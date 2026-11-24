import { createHash } from "node:crypto"
import { homedir } from "node:os"
import path from "node:path"
import type { Plugin, PluginOptions } from "@opencode/plugin"

export type StoreConfig = {
  baseUrl?: URL
  apiKey?: string
  apiKeyHeader: string
  apiKeyPrefix: string
  assetsPath: string
  assetDetailPath: string
  packageContentPath: string
  installRoot: string
  /** Prefix for durable state owned by one OpenCode Location. */
  storagePrefix: string
  maxPackageBytes: number
  maxUnpackedBytes: number
  maxSkillFileBytes: number
  maxEntries: number
  maxCompressionRatio: number
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function positive(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value)
  const integer = Math.floor(parsed)
  return Number.isSafeInteger(integer) && integer > 0 ? integer : fallback
}

function expandHome(value: string): string {
  if (value === "~") return homedir()
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2))
  return value
}

function parseBaseUrl(value: string): URL {
  const url = new URL(value)
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1"
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error("SKILL_STORE_BASE_URL must use HTTPS (HTTP is allowed only for localhost)")
  if (url.username || url.password || url.search || url.hash)
    throw new Error("SKILL_STORE_BASE_URL must not contain credentials, query parameters or a fragment")
  return url
}

export function loadConfig(options: PluginOptions, location: Plugin.Context["location"]): StoreConfig {
  const baseUrl = text(options.storeBaseUrl) ?? process.env.SKILL_STORE_BASE_URL
  // Credentials must never be stored in project-level opencode.jsonc plugin options.
  if (text(options.apiKey)) {
    throw new Error("SKILL_STORE_API_KEY must be provided through the OpenCode Server process environment, not plugin options")
  }
  const apiKey = text(process.env.SKILL_STORE_API_KEY)
  // Prefixes may intentionally include a trailing separator (for example, "Bearer ").
  const apiKeyPrefix = typeof options.apiKeyPrefix === "string"
    ? options.apiKeyPrefix
    : process.env.SKILL_STORE_API_KEY_PREFIX ?? "Bearer "
  const root = text(options.installRoot) ?? process.env.OPENCODE_SKILL_STORE_DIR ?? path.join(homedir(), ".opencode", "skill-store")
  const locationKey = createHash("sha256")
    .update(location.directory + "\u0000" + (location.workspaceID ?? ""))
    .digest("hex")
    .slice(0, 16)

  return {
    baseUrl: baseUrl ? parseBaseUrl(baseUrl) : undefined,
    apiKey,
    apiKeyHeader: text(options.apiKeyHeader) ?? process.env.SKILL_STORE_API_KEY_HEADER ?? "Authorization",
    apiKeyPrefix,
    assetsPath: text(options.assetsPath) ?? process.env.SKILL_STORE_ASSETS_PATH ?? "/v1/asset-store/assets",
    assetDetailPath:
      text(options.assetDetailPath) ?? process.env.SKILL_STORE_ASSET_DETAIL_PATH ?? "/v1/asset-store/assets/{id}",
    packageContentPath:
      text(options.packageContentPath) ??
      process.env.SKILL_STORE_PACKAGE_CONTENT_PATH ??
      "/v1/asset-store/packages/{id}/content",
    installRoot: path.resolve(expandHome(root), locationKey),
    // OpenCode ctx.storage is namespaced by plugin ID, not by Location.
    // Add an explicit Location prefix so separate project/workspace instances cannot share state.
    storagePrefix: `location:v1:${locationKey}:`,
    maxPackageBytes: positive(options.maxPackageBytes ?? process.env.SKILL_STORE_MAX_PACKAGE_BYTES, 100 * 1024 * 1024),
    maxUnpackedBytes: positive(
      options.maxUnpackedBytes ?? process.env.SKILL_STORE_MAX_UNPACKED_BYTES,
      300 * 1024 * 1024,
    ),
    maxSkillFileBytes: positive(
      options.maxSkillFileBytes ?? process.env.SKILL_STORE_MAX_SKILL_FILE_BYTES,
      2 * 1024 * 1024,
    ),
    maxEntries: positive(options.maxEntries ?? process.env.SKILL_STORE_MAX_ENTRIES, 2000),
    maxCompressionRatio: positive(
      options.maxCompressionRatio ?? process.env.SKILL_STORE_MAX_COMPRESSION_RATIO,
      100,
    ),
  }
}
