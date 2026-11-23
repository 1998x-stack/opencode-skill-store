import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { StoreConfig } from "../config.js"
import type { StoreClient } from "../store/client.js"
import { InstallManager } from "./manager.js"

const utf8 = (value: string) => Buffer.from(value, "utf8")
// Minimal ZIP writer for deterministic, uncompressed fixtures. It deliberately allows
// malformed entry names so extraction tests exercise the actual trust boundary.
function crc32(data: Buffer) {
  let value = 0xffffffff
  for (const byte of data) {
    value ^= byte
    for (let i = 0; i < 8; i++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
  }
  return (value ^ 0xffffffff) >>> 0
}

type FixtureEntry = {
  name: string
  content?: string
  mode?: number
  flags?: number
}

function zip(entries: FixtureEntry[]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = utf8(entry.name)
    const data = utf8(entry.content ?? "")
    const crc = crc32(data)
    const flags = entry.flags ?? 0
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(flags, 6)
    localHeader.writeUInt16LE(0, 8)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(data.length, 18)
    localHeader.writeUInt32LE(data.length, 22)
    localHeader.writeUInt16LE(name.length, 26)
    const mode = entry.mode ?? (entry.name.endsWith("/") ? 0o040755 : 0o100644)
    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE((3 << 8) | 20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(flags, 8)
    centralHeader.writeUInt16LE(0, 10)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(data.length, 20)
    centralHeader.writeUInt32LE(data.length, 24)
    centralHeader.writeUInt16LE(name.length, 28)
    centralHeader.writeUInt32LE((mode << 16) >>> 0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    const segment = Buffer.concat([localHeader, name, data])
    local.push(segment)
    central.push(Buffer.concat([centralHeader, name]))
    offset += segment.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}


const terminal = new Set(["installed", "failed", "cancelled", "interrupted"])

async function environment() {
  const root = await mkdtemp(path.join(tmpdir(), "store-manager-test-"))
  const data = new Map<string, unknown>()
  const runtime: { id: string; name: string; description?: string; content: string; path: string }[] = []
  let transform: (editor: { add: (skill: typeof runtime[number]) => void }) => void = () => {}

  const editor = {
    add(skill: typeof runtime[number]) { runtime.push(skill) },
  }
  const ctx = {
    location: { directory: path.join(root, "project") },
    storage: {
      get: async (key: string) => structuredClone(data.get(key)),
      set: async (key: string, value: unknown) => { data.set(key, structuredClone(value)) },
    },
    skill: {
      transform: async (callback: typeof transform) => {
        transform = callback
        callback(editor)
        return { dispose: async () => { runtime.length = 0 } }
      },
      reload: async () => {
        if (current.failReload) throw new Error("simulated Runtime reload failure")
        runtime.length = 0
        transform(editor)
      },
      list: async () => ({ location: { directory: path.join(root, "project") }, data: runtime }),
    },
  } as unknown as Plugin.Context

  const current = {
    assetId: "proof-skill",
    title: "Proof Skill",
    description: "Proof of real Skill Runtime registration",
    version: "1.0.0",
    invalidDigest: false,
    failReload: false,
  }

  const bytes = (version: string) => zip([
    { name: "SKILL.md", content: ["---", "name: Proof Skill", "description: Checks supporting files", "---", "# Proof " + version, "Read references/proof.txt"].join("\n") },
    { name: "references/proof.txt", content: "runtime-proof-" + version },
  ])

  const store = {
    detail: async (assetId: string) => {
      if (assetId !== current.assetId) throw new Error("Unknown asset")
      const payload = bytes(current.version)
      return {
        asset: { assetId, title: current.title, description: current.description, kind: "skill", tags: [], latestVersion: current.version },
        versions: [{
          version: current.version,
          packages: [{
            packageId: "package-" + current.version,
            version: current.version,
            platform: "any",
            arch: "any",
            sizeBytes: payload.byteLength,
            sha256: current.invalidDigest ? "0".repeat(64) : createHash("sha256").update(payload).digest("hex"),
          }],
        }],
      }
    },
    download: async (packageId: string) => {
      const version = packageId.replace("package-", "")
      return new Response(new Uint8Array(bytes(version)), { status: 200 })
    },
  } as unknown as StoreClient

  const config: StoreConfig = {
    baseUrl: new URL("https://example.invalid/"),
    apiKeyHeader: "Authorization",
    apiKeyPrefix: "Bearer ",
    assetsPath: "/assets",
    assetDetailPath: "/assets/{id}",
    packageContentPath: "/packages/{id}/content",
    installRoot: path.join(root, "installed"),
    maxPackageBytes: 1024 * 1024,
    maxUnpackedBytes: 1024 * 1024,
    maxEntries: 50,
    maxCompressionRatio: 100,
  }
  const manager = new InstallManager(ctx, store, config)
  await manager.initialize()
  const api = manager.handlers()
  const settle = async (operationId: string) => {
    for (let i = 0; i < 100; i++) {
      const result = await api.operationGet({ operationId })
      if (result.operation && terminal.has(result.operation.state)) return result.operation
      await Bun.sleep(10)
    }
    throw new Error("Install operation did not reach a terminal state")
  }
  return {
    manager, api, settle, runtime, current, config, root,
    close: async () => { await manager.close(); await rm(root, { recursive: true, force: true }) },
  }
}

describe("InstallManager end-to-end without live Store", () => {
  test("streams ZIP, verifies digest, commits version and registers supporting files", async () => {
    const s = await environment()
    try {
      const started = await s.api.installStart({ assetId: s.current.assetId, idempotencyKey: "install-first" })
      const operation = await s.settle(started.operationId)
      expect(operation.state).toBe("installed")
      const saved = (await s.api.installationList()).items
      expect(saved).toHaveLength(1)
      expect(s.runtime).toHaveLength(1)
      expect(s.runtime[0].id).toBe(saved[0].runtimeSkillId)
      expect(s.runtime[0].content).toContain("# Proof 1.0.0")
      expect(s.runtime[0].content).not.toContain("name: Proof Skill")
      const dir = path.dirname(s.runtime[0].path)
      expect(await readFile(path.join(dir, "references/proof.txt"), "utf8")).toBe("runtime-proof-1.0.0")
      expect(JSON.parse(await readFile(path.join(s.config.installRoot, "skills", s.runtime[0].id, "active.json"), "utf8")).version).toBe("1.0.0")
    } finally { await s.close() }
  })

  test("wrong SHA rejects update and preserves the previous runtime", async () => {
    const s = await environment()
    try {
      const first = await s.api.installStart({ assetId: s.current.assetId, idempotencyKey: "first" })
      expect((await s.settle(first.operationId)).state).toBe("installed")
      const oldID = s.runtime[0].id
      const oldFile = s.runtime[0].path
      s.current.version = "1.1.0"
      s.current.invalidDigest = true
      const next = await s.api.installStart({ assetId: s.current.assetId, version: "1.1.0", idempotencyKey: "wrong-digest" })
      const failed = await s.settle(next.operationId)
      expect(failed.state).toBe("failed")
      expect(failed.error).toContain("DIGEST_MISMATCH")
      expect((await s.api.installationList()).items[0].version).toBe("1.0.0")
      expect(s.runtime[0].id).toBe(oldID)
      expect(s.runtime[0].path).toBe(oldFile)
      expect(JSON.parse(await readFile(path.join(s.config.installRoot, "skills", oldID, "active.json"), "utf8")).version).toBe("1.0.0")
    } finally { await s.close() }
  })

  test("idempotent repeat returns one operation and rejects a conflicting key", async () => {
    const s = await environment()
    try {
      const a = await s.api.installStart({ assetId: "proof-skill", idempotencyKey: "same-key" })
      const b = await s.api.installStart({ assetId: "proof-skill", idempotencyKey: "same-key" })
      expect(b.operationId).toBe(a.operationId)
      await expect(s.api.installStart({ assetId: "different-skill", idempotencyKey: "same-key" })).rejects.toThrow("Idempotency")
      expect((await s.settle(a.operationId)).state).toBe("installed")
      expect((await s.api.operationList()).items.filter((x) => x.assetId === "proof-skill")).toHaveLength(1)
    } finally { await s.close() }
  })


  test("Runtime reload failure restores the previous active version and removes the failed version", async () => {
    const s = await environment()
    try {
      const first = await s.api.installStart({ assetId: s.current.assetId, idempotencyKey: "before-reload-failure" })
      expect((await s.settle(first.operationId)).state).toBe("installed")
      const item = (await s.api.installationList()).items[0]
      const skillRoot = path.join(s.config.installRoot, "skills", item.runtimeSkillId)
      s.current.version = "1.1.0"
      s.current.failReload = true
      const next = await s.api.installStart({ assetId: s.current.assetId, version: "1.1.0", idempotencyKey: "reload-failure" })
      const failed = await s.settle(next.operationId)
      expect(failed.state).toBe("failed")
      expect(failed.error).toContain("simulated Runtime reload failure")
      expect((await s.api.installationList()).items[0].version).toBe("1.0.0")
      expect(JSON.parse(await readFile(path.join(skillRoot, "active.json"), "utf8")).version).toBe("1.0.0")
      expect(s.runtime[0].content).toContain("# Proof 1.0.0")
      await expect(stat(path.join(skillRoot, "versions", "1.1.0"))).rejects.toThrow()
    } finally { await s.close() }
  })

  test("enable, disable and uninstall update the native Runtime and filesystem", async () => {
    const s = await environment()
    try {
      const started = await s.api.installStart({ assetId: "proof-skill", idempotencyKey: "lifecycle" })
      expect((await s.settle(started.operationId)).state).toBe("installed")
      const item = (await s.api.installationList()).items[0]
      await s.api.installationSetEnabled({ installationId: item.installationId, enabled: false })
      expect(s.runtime).toHaveLength(0)
      await s.api.installationSetEnabled({ installationId: item.installationId, enabled: true })
      expect(s.runtime).toHaveLength(1)
      const managedRoot = path.join(s.config.installRoot, "skills", item.runtimeSkillId)
      expect((await stat(managedRoot)).isDirectory()).toBe(true)
      const removed = await s.api.installationUninstall({ installationId: item.installationId })
      expect(removed.removed).toBe(true)
      expect(s.runtime).toHaveLength(0)
      expect((await s.api.installationList()).items).toHaveLength(0)
      await expect(stat(managedRoot)).rejects.toThrow()
    } finally { await s.close() }
  })
})
