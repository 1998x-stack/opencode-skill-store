import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import path from "node:path"
import type { Plugin, PluginOptions } from "@opencode/plugin"
import { loadConfig } from "./config.js"

const location = {
  directory: "/workspace/project",
  workspaceID: "workspace-1",
} as Plugin.Context["location"]

function options(value: Record<string, unknown>) {
  return value as unknown as PluginOptions
}

describe("loadConfig", () => {
  test("expands ~/ before applying the Location-specific directory", () => {
    const config = loadConfig(options({
      storeBaseUrl: "http://localhost:8071",
      installRoot: "~/opencode-skill-store",
    }), location)
    const locationKey = createHash("sha256")
      .update(location.directory + "\u0000" + (location.workspaceID ?? ""))
      .digest("hex")
      .slice(0, 16)
    expect(config.installRoot).toBe(path.join(homedir(), "opencode-skill-store", locationKey))
  })

  test("uses HTTPS for non-loopback Store origins", () => {
    expect(loadConfig(options({ storeBaseUrl: "https://skills.example.test" }), location).baseUrl?.protocol).toBe("https:")
    expect(() => loadConfig(options({ storeBaseUrl: "http://skills.example.test" }), location)).toThrow("must use HTTPS")
    expect(loadConfig(options({ storeBaseUrl: "http://[::1]:8071" }), location).baseUrl?.hostname).toBe("[::1]")
  })

  test("rejects credential-bearing and query-bearing base URLs", () => {
    expect(() => loadConfig(options({ storeBaseUrl: "https://user:secret@skills.example.test" }), location)).toThrow("must not contain credentials")
    expect(() => loadConfig(options({ storeBaseUrl: "https://skills.example.test?token=secret" }), location)).toThrow("must not contain credentials")
  })

  test("rejects API keys supplied through plugin options", () => {
    expect(() => loadConfig(options({
      storeBaseUrl: "https://skills.example.test",
      apiKey: "must-not-be-used",
    }), location)).toThrow("must be provided through the OpenCode Server process environment")
  })

  test("reads the Store API key only from the Server process environment", () => {
    const previous = process.env.SKILL_STORE_API_KEY
    process.env.SKILL_STORE_API_KEY = "server-process-secret"
    try {
      const config = loadConfig(options({ storeBaseUrl: "https://skills.example.test" }), location)
      expect(config.apiKey).toBe("server-process-secret")
    } finally {
      if (previous === undefined) delete process.env.SKILL_STORE_API_KEY
      else process.env.SKILL_STORE_API_KEY = previous
    }
  })

  test("preserves intentional trailing whitespace in the API key prefix", () => {
    const config = loadConfig(options({
      storeBaseUrl: "https://skills.example.test",
      apiKeyPrefix: "Bearer ",
    }), location)
    expect(config.apiKeyPrefix).toBe("Bearer ")
  })

  test("falls back when a positive integer limit would otherwise floor to zero", () => {
    const config = loadConfig(options({
      storeBaseUrl: "https://skills.example.test",
      maxPackageBytes: 0.5,
      maxEntries: 0,
    }), location)
    expect(config.maxPackageBytes).toBe(100 * 1024 * 1024)
    expect(config.maxEntries).toBe(2000)
  })
})
