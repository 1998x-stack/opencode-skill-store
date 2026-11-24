import { describe, expect, test } from "bun:test"
import { readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { InstallManager } from "./manager.js"
import { environment } from "./manager.test-support.js"

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
      expect(s.runtime[0].description).toBe(s.current.description)
      expect(s.runtime[0].content).not.toContain("name: Proof Skill")
      const dir = path.dirname(s.runtime[0].path)
      expect(await readFile(path.join(dir, "references/proof.txt"), "utf8")).toBe("runtime-proof-1.0.0")
      expect(JSON.parse(await readFile(path.join(s.config.installRoot, "skills", s.runtime[0].id, "active.json"), "utf8")).version).toBe("1.0.0")
    } finally { await s.close() }
  })

  test("isolates durable state between Locations sharing one plugin storage namespace", async () => {
    const sharedStorage = new Map<string, unknown>()
    const directory = path.join(tmpdir(), "shared-opencode-project")
    const firstLocation = await environment({
      storageData: sharedStorage,
      locationDirectory: directory,
      workspaceID: "workspace-a",
    })
    const secondLocation = await environment({
      storageData: sharedStorage,
      locationDirectory: directory,
      workspaceID: "workspace-b",
    })
    try {
      const first = await firstLocation.api.installStart({
        assetId: firstLocation.current.assetId,
        idempotencyKey: "workspace-a-install",
      })
      expect((await firstLocation.settle(first.operationId)).state).toBe("installed")
      expect((await firstLocation.api.installationList()).items).toHaveLength(1)
      expect((await secondLocation.api.installationList()).items).toHaveLength(0)
      expect((await secondLocation.api.operationList()).items).toHaveLength(0)

      const second = await secondLocation.api.installStart({
        assetId: secondLocation.current.assetId,
        idempotencyKey: "workspace-b-install",
      })
      expect((await secondLocation.settle(second.operationId)).state).toBe("installed")
      expect((await firstLocation.api.installationList()).items).toHaveLength(1)
      expect((await secondLocation.api.installationList()).items).toHaveLength(1)

      expect(sharedStorage.has(firstLocation.config.storagePrefix + "installations")).toBe(true)
      expect(sharedStorage.has(secondLocation.config.storagePrefix + "installations")).toBe(true)
      expect(sharedStorage.has("installations")).toBe(false)
      expect(sharedStorage.has("operations")).toBe(false)
    } finally {
      await Promise.all([firstLocation.close(), secondLocation.close()])
    }
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
      expect(failed.error).toContain("simulated Runtime reload failure after partial activation")
      expect((await s.api.installationList()).items[0].version).toBe("1.0.0")
      expect(JSON.parse(await readFile(path.join(skillRoot, "active.json"), "utf8")).version).toBe("1.0.0")
      expect(s.runtime[0].content).toContain("# Proof 1.0.0")
      await expect(stat(path.join(skillRoot, "versions", "1.1.0"))).rejects.toThrow()
    } finally { await s.close() }
  })

  test("restores the Store description after a server restart when SKILL.md omits it", async () => {
    const s = await environment()
    let restarted: InstallManager | undefined
    try {
      const started = await s.api.installStart({ assetId: s.current.assetId, idempotencyKey: "description-restart" })
      expect((await s.settle(started.operationId)).state).toBe("installed")
      expect(s.runtime[0].description).toBe(s.current.description)
      await s.manager.close()
      restarted = new InstallManager(s.ctx, s.store, s.config)
      await restarted.initialize()
      expect(s.runtime[0].description).toBe(s.current.description)
      expect((await restarted.handlers().installationList()).items[0].description).toBe(s.current.description)
    } finally {
      await restarted?.close()
      await s.close()
    }
  })

  test("repairs a stale active pointer from the durable installation record on restart", async () => {
    const s = await environment()
    let restarted: InstallManager | undefined
    try {
      const started = await s.api.installStart({ assetId: s.current.assetId, idempotencyKey: "active-pointer-repair" })
      expect((await s.settle(started.operationId)).state).toBe("installed")
      await s.manager.close()
      const runtimeSkillId = (await s.api.installationList()).items[0].runtimeSkillId
      const activeFile = path.join(s.config.installRoot, "skills", runtimeSkillId, "active.json")
      await writeFile(activeFile, JSON.stringify({ version: "9.9.9", sha256: "0".repeat(64) }))
      restarted = new InstallManager(s.ctx, s.store, s.config)
      await restarted.initialize()
      expect(s.runtime).toHaveLength(1)
      expect(s.runtime[0].content).toContain("# Proof 1.0.0")
      expect(JSON.parse(await readFile(activeFile, "utf8")).version).toBe("1.0.0")
    } finally {
      await restarted?.close()
      await s.close()
    }
  })

  test("does not register a version when its package manifest disagrees with durable state", async () => {
    const s = await environment()
    let restarted: InstallManager | undefined
    try {
      const started = await s.api.installStart({ assetId: s.current.assetId, idempotencyKey: "manifest-integrity" })
      expect((await s.settle(started.operationId)).state).toBe("installed")
      await s.manager.close()
      const runtimeSkillId = (await s.api.installationList()).items[0].runtimeSkillId
      const manifest = path.join(s.config.installRoot, "skills", runtimeSkillId, "versions", "1.0.0", ".store-manifest.json")
      await writeFile(manifest, JSON.stringify({ assetId: s.current.assetId, version: "1.0.0", sha256: "0".repeat(64) }))
      restarted = new InstallManager(s.ctx, s.store, s.config)
      await restarted.initialize()
      expect(s.runtime).toHaveLength(0)
      expect((await restarted.handlers().installationList()).items[0].status).toBe("broken")
    } finally {
      await restarted?.close()
      await s.close()
    }
  })

  test("different requested version cannot join an active operation", async () => {
    const s = await environment()
    try {
      const started = await s.api.installStart({ assetId: s.current.assetId, version: "1.0.0", idempotencyKey: "active-v1" })
      await expect(s.api.installStart({ assetId: s.current.assetId, version: "1.1.0", idempotencyKey: "active-v2" }))
        .rejects.toThrow("different version")
      expect((await s.settle(started.operationId)).state).toBe("installed")
    } finally { await s.close() }
  })

  test("pin metadata is restored in memory when persistence fails", async () => {
    const s = await environment()
    try {
      const started = await s.api.installStart({ assetId: s.current.assetId, idempotencyKey: "pin-before" })
      expect((await s.settle(started.operationId)).state).toBe("installed")
      const item = (await s.api.installationList()).items[0]
      s.current.failInstallationWrites = true
      await expect(s.api.installationPin({ installationId: item.installationId, version: "1.0.0" }))
        .rejects.toThrow("simulated installation storage failure")
      expect((await s.api.installationList()).items[0].pinnedVersion).toBeNull()
    } finally { await s.close() }
  })

  test("rollback storage failure still leaves the operation terminal", async () => {
    const s = await environment()
    try {
      const first = await s.api.installStart({ assetId: s.current.assetId, idempotencyKey: "storage-before" })
      expect((await s.settle(first.operationId)).state).toBe("installed")
      s.current.version = "1.1.0"
      s.current.failInstallationWrites = true
      const next = await s.api.installStart({ assetId: s.current.assetId, version: "1.1.0", idempotencyKey: "storage-failure" })
      const failed = await s.settle(next.operationId)
      expect(failed.state).toBe("failed")
      expect(failed.error).toContain("simulated installation storage failure")
      expect(failed.error).toContain("installation state restore failed")
    } finally { await s.close() }
  })

  test("accepts cancellation before commit without activating the package", async () => {
    const s = await environment()
    const cancellationResults: boolean[] = []
    try {
      s.manager.setEmitter(async (name, data) => {
        if (name !== "operationProgress" || data.stage !== "extracting") return
        const result = await s.api.operationCancel({ operationId: data.operationId })
        cancellationResults.push(result.cancelled)
      })
      const started = await s.api.installStart({
        assetId: s.current.assetId, idempotencyKey: "cancel-before-commit",
      })
      const operation = await s.settle(started.operationId)
      expect(cancellationResults).toEqual([true])
      expect(operation.state).toBe("cancelled")
      expect((await s.api.installationList()).items).toHaveLength(0)
      expect(s.runtime).toHaveLength(0)
    } finally { await s.close() }
  })

  test("rejects cancellation during commit and registration", async () => {
    const s = await environment()
    const cancellationResults: boolean[] = []
    try {
      s.manager.setEmitter(async (name, data) => {
        if (name !== "operationProgress" || !["committing", "registering"].includes(String(data.stage))) return
        const result = await s.api.operationCancel({ operationId: data.operationId })
        cancellationResults.push(result.cancelled)
      })
      const started = await s.api.installStart({
        assetId: s.current.assetId, idempotencyKey: "cancel-after-commit",
      })
      const operation = await s.settle(started.operationId)
      expect(cancellationResults).toEqual([false, false])
      expect(operation.state).toBe("installed")
      expect((await s.api.installationList()).items).toHaveLength(1)
      expect(s.runtime).toHaveLength(1)
      expect(await s.api.operationCancel({ operationId: started.operationId })).toEqual({ cancelled: false })
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
