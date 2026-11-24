import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, rename, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { environment } from "./manager.test-support.js"
import { InstallManager } from "./manager.js"

const childFile = fileURLToPath(new URL("./lifecycle-child.ts", import.meta.url))

async function childRun(root: string, kind: string, point = "") {
  const child = Bun.spawn([process.execPath, childFile, root, kind, point], { stdout: "pipe", stderr: "pipe" })
  const timeout = setTimeout(() => child.kill(), 8000)
  try {
    const [exit, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    return { exit, stdout, stderr, signal: child.signalCode }
  } finally { clearTimeout(timeout) }
}

describe.skipIf(process.platform === "win32")("lifecycle process recovery and writer exclusion", () => {
  for (const kind of ["enable", "disable", "uninstall"] as const) {
    const points = kind === "uninstall" ? ["prepared-runtime", "committed", "after-delete"] : ["prepared-runtime", "committed"]
    for (const point of points) {
      test(`${kind}: SIGKILL at ${point}`, async () => {
        const root = await mkdtemp(path.join(tmpdir(), "skill-lifecycle-"))
        try {
          const original = await environment({ root, persistent: true })
          const start = await original.api.installStart({ assetId: original.current.assetId, idempotencyKey: "initial" })
          expect((await original.settle(start.operationId)).state).toBe("installed")
          const item = (await original.api.installationList()).items[0]
          const skillRoot = path.join(original.config.installRoot, "skills", item.runtimeSkillId)
          if (kind === "enable")
            await original.api.installationSetEnabled({ installationId: item.installationId, enabled: false })
          await original.manager.close()
          const result = await childRun(root, kind, point)
          if (result.signal !== "SIGKILL") throw new Error(`Expected SIGKILL: ${JSON.stringify(result)}`)
          expect(await readFile(path.join(root, "lifecycle-crash-marker"), "utf8")).toBe(point)
          for (let restart = 0; restart < 2; restart++) {
            const recovered = await environment({ root, persistent: true })
            try {
              const committed = point !== "prepared-runtime"
              const removed = kind === "uninstall" && committed
              const enabled = committed ? kind === "enable" : kind !== "enable"
              const items = (await recovered.api.installationList()).items
              expect(items).toHaveLength(removed ? 0 : 1)
              expect(recovered.runtime).toHaveLength(!removed && enabled ? 1 : 0)
              if (removed) await expect(stat(skillRoot)).rejects.toThrow()
              else {
                expect(items[0].enabled).toBe(enabled)
                expect(items[0].status).toBe("installed")
                expect(await readFile(path.join(skillRoot, "versions", item.version, "references", "proof.txt"), "utf8"))
                  .toBe("runtime-proof-" + item.version)
              }
              await expect(stat(path.join(recovered.config.installRoot, "lifecycle-journal.json"))).rejects.toThrow()
            } finally { await recovered.manager.close() }
          }
        } finally { await rm(root, { recursive: true, force: true }) }
      }, 20000)
    }
  }

  test("rejects competing managers in this process and a separate process", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "skill-writer-"))
    const first = await environment({ root, persistent: true })
    try {
      const competing = new InstallManager(first.ctx, first.store, first.config)
      await expect(competing.initialize()).rejects.toThrow("Location writer lock")
      const result = await childRun(root, "lock")
      expect(result.exit).toBe(0)
      expect(result.stdout).toContain("writer-rejected")
      await first.manager.close()
      const successor = await environment({ root, persistent: true })
      await successor.manager.close()
    } finally { await first.close() }
  }, 20000)

  test("failed destructive cleanup retains disabled tombstone and retries on restart", async () => {
    const s = await environment()
    let restarted: InstallManager | undefined
    try {
      const start = await s.api.installStart({ assetId: s.current.assetId, idempotencyKey: "cleanup" })
      expect((await s.settle(start.operationId)).state).toBe("installed")
      const item = (await s.api.installationList()).items[0]
      const root = path.join(s.config.installRoot, "skills", item.runtimeSkillId)
      const moved = root + ".saved"
      await rename(root, moved)
      const outside = path.join(s.root, "outside.txt")
      await writeFile(outside, "must survive")
      await symlink(s.root, root, "dir")
      await expect(s.api.installationUninstall({ installationId: item.installationId })).rejects.toThrow("restart required")
      expect(s.runtime).toHaveLength(0)
      expect((await s.api.installationList()).items[0]).toMatchObject({ enabled: false, status: "cleanup_pending" })
      expect(await readFile(outside, "utf8")).toBe("must survive")
      await expect(s.api.installationSetEnabled({ installationId: item.installationId, enabled: true })).rejects.toThrow("restart")
      await rm(root)
      await rename(moved, root)
      await s.manager.close()
      restarted = new InstallManager(s.ctx, s.store, s.config)
      await restarted.initialize()
      expect((await restarted.handlers().installationList()).items).toHaveLength(0)
      expect(s.runtime).toHaveLength(0)
      await expect(stat(root)).rejects.toThrow()
      expect(await readFile(outside, "utf8")).toBe("must survive")
    } finally {
      await restarted?.close()
      await s.close()
    }
  })
})
