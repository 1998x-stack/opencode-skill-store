import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { environment } from "./manager.test-support.js"

const cutpoints = ["before-kv", "after-kv", "runtime", "after-commit"] as const

describe.skipIf(process.platform === "win32")("installer process-crash recovery", () => {
  for (const initial of [true, false]) {
    for (const cutpoint of cutpoints) {
      test(`${initial ? "first install" : "update"}: SIGKILL at ${cutpoint}`, async () => {
        const root = await mkdtemp(path.join(tmpdir(), "skill-recovery-process-"))
        try {
          if (!initial) {
            const original = await environment({ root, persistent: true })
            const start = await original.api.installStart({
              assetId: original.current.assetId, idempotencyKey: "original",
            })
            expect((await original.settle(start.operationId)).state).toBe("installed")
            await original.manager.close()
          }
          const child = Bun.spawn([
            process.execPath, fileURLToPath(new URL("./recovery-child.ts", import.meta.url)), root, cutpoint,
          ], { stdout: "pipe", stderr: "pipe" })
          const timeout = setTimeout(() => child.kill(), 8000)
          try {
            const [exit, stdout, stderr] = await Promise.all([
              child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
            ])
            if (child.signalCode !== "SIGKILL") throw new Error(`Expected SIGKILL; exit=${exit}\n${stdout}\n${stderr}`)
            expect(await readFile(path.join(root, "crash-marker"), "utf8")).toBe(cutpoint)
          } finally { clearTimeout(timeout) }
          // Reopen the durable Location in a new manager, without access to the child memory.
          for (let restart = 0; restart < 2; restart++) {
            const recovered = await environment({ root, persistent: true })
            try {
              const committed = cutpoint === "after-commit"
              const version = committed ? "1.1.0" : initial ? null : "1.0.0"
              const items = (await recovered.api.installationList()).items
              const operation = (await recovered.api.operationList()).items.find((item) => item.idempotencyKey === "crash-update")
              expect(operation?.state).toBe(committed ? "installed" : "interrupted")
              expect(items).toHaveLength(version ? 1 : 0)
              expect(recovered.runtime).toHaveLength(version ? 1 : 0)
              if (version) {
                expect(items[0].version).toBe(version)
                expect(recovered.runtime[0].content).toContain("# Proof " + version)
                const skillRoot = path.join(recovered.config.installRoot, "skills", items[0].runtimeSkillId)
                const active = JSON.parse(await readFile(path.join(skillRoot, "active.json"), "utf8"))
                expect(active.version).toBe(version)
                expect(await readFile(path.join(path.dirname(recovered.runtime[0].path), "references/proof.txt"), "utf8"))
                  .toBe("runtime-proof-" + version)
              }
              await expect(stat(path.join(recovered.config.installRoot, "install-journal.json"))).rejects.toThrow()
            } finally { await recovered.manager.close() }
          }
        } finally { await rm(root, { recursive: true, force: true }) }
      }, 20000)
    }
  }
})
