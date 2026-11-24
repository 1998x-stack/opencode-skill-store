import { afterEach, describe, expect, test } from "bun:test"
import { StoreClient } from "./client.js"
import type { StoreConfig } from "../config.js"

const config: StoreConfig = {
  baseUrl: new URL("https://store.example.test/"),
  apiKey: "test-secret",
  apiKeyHeader: "Authorization",
  apiKeyPrefix: "Bearer ",
  assetsPath: "/v1/assets",
  assetDetailPath: "/v1/assets/{id}",
  packageContentPath: "/v1/packages/{id}/content",
  installRoot: "/tmp/skill-store-test",
  storagePrefix: "location:v1:test:",
  maxPackageBytes: 1024,
  maxUnpackedBytes: 2048,
  maxSkillFileBytes: 1024,
  maxEntries: 20,
  maxCompressionRatio: 100,
}

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

function urlOf(input: RequestInfo | URL) {
  return new URL(input instanceof Request ? input.url : String(input))
}

describe("StoreClient", () => {
  test("normalizes catalog responses and clamps untrusted page limits", async () => {
    let requested: URL | undefined
    let authorization = ""
    globalThis.fetch = (async (input, init) => {
      requested = urlOf(input)
      authorization = new Headers(init?.headers).get("authorization") ?? ""
      return Response.json({
        data: {
          items: [
            { asset_id: "research", title: "Research", description: "Evidence workflow", kind: "SKILL", tags: ["research"], latest_version: "1.2.0" },
            { asset_id: "agent", title: "Agent", kind: "agent" },
            { asset_id: "", title: "Missing ID", kind: "skill" },
            { asset_id: "missing-kind", title: "Missing kind" },
          ],
          cursor: { next: "cursor-next" },
        },
      })
    }) as typeof fetch

    const result = await new StoreClient(config).search({ query: "evidence", limit: 9999 })
    expect(requested?.pathname).toBe("/v1/assets")
    expect(requested?.searchParams.get("kind")).toBe("skill")
    expect(requested?.searchParams.get("q")).toBe("evidence")
    expect(requested?.searchParams.get("limit")).toBe("100")
    expect(authorization).toBe("Bearer test-secret")
    expect(result).toEqual({
      configured: true,
      items: [{
        assetId: "research",
        title: "Research",
        description: "Evidence workflow",
        kind: "skill",
        tags: ["research"],
        latestVersion: "1.2.0",
      }],
      nextCursor: "cursor-next",
    })
  })

  test("normalizes version and package metadata while URL-encoding asset IDs", async () => {
    let requested: URL | undefined
    globalThis.fetch = (async (input) => {
      requested = urlOf(input)
      return Response.json({
        data: {
          asset: { asset_id: "research/advanced", title: "Advanced Research", kind: "skill" },
          versions: [{
            version: "2.0.0",
            packages: [{
              package_id: "pkg-2",
              version: "2.0.0",
              platform: "any",
              arch: "any",
              size_bytes: 123,
              sha256: "A".repeat(64),
            }],
          }],
        },
      })
    }) as typeof fetch

    const result = await new StoreClient(config).detail("research/advanced")
    expect(requested?.pathname).toBe("/v1/assets/research%2Fadvanced")
    expect(result.asset.assetId).toBe("research/advanced")
    expect(result.versions[0].packages[0]).toEqual({
      packageId: "pkg-2",
      version: "2.0.0",
      platform: "any",
      arch: "any",
      sizeBytes: 123,
      sha256: "a".repeat(64),
    })
  })

  test("does not invent a Skill type or universal package target when Store metadata is missing", async () => {
    globalThis.fetch = (async () => Response.json({
      data: {
        asset: { asset_id: "research", title: "Research" },
        versions: [{
          version: "1.0.0",
          packages: [{ package_id: "pkg", version: "1.0.0", size_bytes: 10, sha256: "a".repeat(64) }],
        }],
      },
    })) as unknown as typeof fetch
    const result = await new StoreClient(config).detail("research")
    expect(result.asset.kind).toBe("")
    expect(result.versions[0].packages[0].platform).toBe("")
    expect(result.versions[0].packages[0].arch).toBe("")
  })

  test("sends Store credentials only on the server download request and forbids implicit redirects", async () => {
    let authorization = ""
    let redirect = ""
    let accept = ""
    globalThis.fetch = (async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization") ?? ""
      redirect = init?.redirect ?? ""
      accept = new Headers(init?.headers).get("accept") ?? ""
      return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))
    }) as typeof fetch

    const response = await new StoreClient(config).download("pkg-1", new AbortController().signal)
    expect(response.ok).toBe(true)
    expect(authorization).toBe("Bearer test-secret")
    expect(redirect).toBe("error")
    expect(accept).toBe("application/zip, application/octet-stream")
  })

  test("rejects oversized metadata responses before JSON parsing", async () => {
    globalThis.fetch = (async () => new Response("{}", {
      headers: { "content-length": String(5 * 1024 * 1024 + 1) },
    })) as unknown as typeof fetch
    await expect(new StoreClient(config).detail("research")).rejects.toThrow("5 MiB metadata limit")
  })

  test("returns a stable error for malformed Store JSON", async () => {
    globalThis.fetch = (async () => new Response("{not-json")) as unknown as typeof fetch
    await expect(new StoreClient(config).detail("research")).rejects.toThrow("invalid JSON")
  })

  test("reports HTTP errors without leaking credential values", async () => {
    globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch
    const error = await new StoreClient(config).detail("private").catch((value) => value)
    expect(String(error)).toContain("HTTP 401")
    expect(String(error)).not.toContain("test-secret")
  })

  test("rejects empty asset IDs before making a request", async () => {
    let calls = 0
    globalThis.fetch = (async () => { calls++; return Response.json({}) }) as unknown as typeof fetch
    await expect(new StoreClient(config).detail(" ")).rejects.toThrow("assetId is required")
    expect(calls).toBe(0)
  })

  test("rejects Store routes that can escape the configured origin", async () => {
    let calls = 0
    globalThis.fetch = (async () => { calls++; return Response.json({ data: { items: [] } }) }) as unknown as typeof fetch
    const external = new StoreClient({ ...config, assetsPath: "https://attacker.example/collect" })
    const networkPath = new StoreClient({ ...config, assetsPath: "//attacker.example/collect" })
    const backslash = new StoreClient({ ...config, assetsPath: "/\\\\attacker.example/collect" })
    await expect(external.search({})).rejects.toThrow("absolute paths")
    await expect(networkPath.search({})).rejects.toThrow("absolute paths")
    await expect(backslash.search({})).rejects.toThrow("absolute paths")
    expect(calls).toBe(0)
  })

  test("bounds query length before constructing an HTTP request", async () => {
    let calls = 0
    globalThis.fetch = (async () => { calls++; return Response.json({ data: { items: [] } }) }) as unknown as typeof fetch
    await expect(new StoreClient(config).search({ query: "x".repeat(257) })).rejects.toThrow("256 characters")
    expect(calls).toBe(0)
  })

  test("detail request cancellation propagates to the HTTP request", async () => {
    let requestSignal: AbortSignal | undefined
    globalThis.fetch = (async (_input, init) => {
      requestSignal = init?.signal as AbortSignal
      return Response.json({ data: { asset: { asset_id: "research", title: "Research", kind: "skill" }, versions: [] } })
    }) as typeof fetch
    const controller = new AbortController()
    await new StoreClient(config).detail("research", controller.signal)
    expect(requestSignal?.aborted).toBe(false)
    controller.abort()
    expect(requestSignal?.aborted).toBe(true)
  })
})
