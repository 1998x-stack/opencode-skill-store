import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { StoreConfig } from "../config.js"
import type { StoreClient } from "../store/client.js"
import { InstallManager } from "./manager.js"
import { atomicJson } from "./journal.js"
import type { Installation, Operation } from "../contracts.js"

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

type EnvironmentOptions = {
  storageData?: Map<string, unknown>
  locationDirectory?: string
  workspaceID?: string
  root?: string
  persistent?: boolean
  crashAt?: "before-kv" | "after-kv" | "runtime" | "after-commit"
}

export async function environment(options: EnvironmentOptions = {}) {
  const root = options.root ?? await mkdtemp(path.join(tmpdir(), "store-manager-test-"))
  const kvFile = path.join(root, "test-kv.json")
  const data = options.storageData ?? new Map<string, unknown>()
  if (options.persistent) {
    try {
      const entries = JSON.parse(await readFile(kvFile, "utf8")) as Array<[string, unknown]>
      for (const [key, value] of entries) data.set(key, value)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  const crash = async (point: EnvironmentOptions["crashAt"]) => {
    if (!point || options.crashAt !== point) return
    await writeFile(path.join(root, "crash-marker"), point)
    process.kill(process.pid, "SIGKILL")
    // Never permit the manager to continue if signal delivery is delayed.
    await new Promise<never>(() => {})
  }
  const location = {
    directory: options.locationDirectory ?? path.join(root, "project"),
    workspaceID: options.workspaceID,
  }
  const locationKey = createHash("sha256")
    .update(location.directory + "\u0000" + (location.workspaceID ?? ""))
    .digest("hex")
    .slice(0, 16)
  const runtime: { id: string; name: string; description?: string; content: string; path: string }[] = []
  let transform: (editor: { add: (skill: typeof runtime[number]) => void }) => void = () => {}

  const hooks: { beforeStorageWrite?: (key: string, value: unknown) => Promise<void>; afterReload?: () => Promise<void> } = {}
  const editor = {
    add(skill: typeof runtime[number]) { runtime.push(skill) },
  }
  const ctx = {
    location,
    storage: {
      get: async (key: string) => structuredClone(data.get(key)),
      set: async (key: string, value: unknown) => {
        await hooks.beforeStorageWrite?.(key, value)
        if (key.endsWith(":installations") && current.failInstallationWrites) throw new Error("simulated installation storage failure")
        const update = key.endsWith(":installations") &&
          Array.isArray(value) && (value as Installation[]).some((item) => item.version === "1.1.0")
        const committed = key.endsWith(":operations") && Array.isArray(value) &&
          (value as Operation[]).some((item) => item.version === "1.1.0" && item.state === "installed")
        if (update) await crash("before-kv")
        if (committed) await crash("after-commit")
        data.set(key, structuredClone(value))
        if (options.persistent) await atomicJson(kvFile, [...data.entries()])
        if (update) await crash("after-kv")
      },
    },
    skill: {
      transform: async (callback: typeof transform) => {
        transform = callback
        callback(editor)
        return { dispose: async () => { runtime.length = 0 } }
      },
      reload: async () => {
        runtime.length = 0
        transform(editor)
        await hooks.afterReload?.()
        if (runtime.some((item) => item.content.includes("# Proof 1.1.0"))) await crash("runtime")
        if (current.failReload) {
          current.failReload = false
          throw new Error("simulated Runtime reload failure after partial activation")
        }
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
    failInstallationWrites: false,
  }

  const bytes = (version: string) => zip([
    { name: "SKILL.md", content: ["---", "name: Proof Skill", "---", "# Proof " + version, "Read references/proof.txt"].join("\n") },
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
    installRoot: path.join(root, "installed", locationKey),
    storagePrefix: `location:v1:${locationKey}:`,
    maxPackageBytes: 1024 * 1024,
    maxUnpackedBytes: 1024 * 1024,
    maxSkillFileBytes: 1024 * 1024,
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
    manager, api, settle, runtime, current, config, root, ctx, store, data, hooks,
    close: async () => { await manager.close(); await rm(root, { recursive: true, force: true }) },
  }
}

