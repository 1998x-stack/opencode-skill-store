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
  maxPackageBytes: 1024,
  maxUnpackedBytes: 2048,
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
    expect(accept).toBe("application/json")
  })

  test("reports HTTP errors without leaking credential values", async () => {
    globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch
    await expect(new StoreClient(config).detail("private")).rejects.toThrow("HTTP 401")
    expect("test-secret").not.toContain("HTTP 401")
  })

  test("rejects empty asset IDs before making a request", async () => {
    let calls = 0
    globalThis.fetch = (async () => { calls++; return Response.json({}) }) as typeof fetch
    await expect(new StoreClient(config).detail(" ")).rejects.toThrow("assetId is required")
    expect(calls).toBe(0)
  })
})
