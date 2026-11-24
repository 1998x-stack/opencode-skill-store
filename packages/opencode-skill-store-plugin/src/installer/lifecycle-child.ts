import { writeFile } from "node:fs/promises"
import path from "node:path"
import { LifecycleJournalStore } from "./journal.js"
import { environment } from "./manager.test-support.js"

const [root, kind, point] = process.argv.slice(2)
if (!root) throw new Error("Missing fixture root")
if (kind === "lock") {
  try {
    const s = await environment({ root, persistent: true })
    await s.manager.close()
    throw new Error("Second writer unexpectedly acquired the lock")
  } catch (error) {
    if (!String(error).includes("Location writer lock")) throw error
    console.log("writer-rejected")
  }
} else {
  const s = await environment({ root, persistent: true })
  const item = (await s.api.installationList()).items[0]
  if (!item) throw new Error("Missing installed fixture")
  async function crash() {
    await writeFile(path.join(root, "lifecycle-crash-marker"), point)
    process.kill(process.pid, "SIGKILL")
    await new Promise<never>(() => {})
  }
  const originalWrite = LifecycleJournalStore.prototype.write
  LifecycleJournalStore.prototype.write = async function (journal) {
    await originalWrite.call(this, journal)
    if (point === "committed" && journal.phase === "committed") await crash()
  }
  if (point === "prepared-runtime") {
    const reload = s.ctx.skill.reload.bind(s.ctx.skill)
    s.ctx.skill.reload = async () => {
      const result = await reload()
      await crash()
      return result
    }
  }
  if (point === "after-delete") {
    const persist = s.ctx.storage.set.bind(s.ctx.storage)
    s.ctx.storage.set = async (key, value) => {
      if (key.endsWith(":installations") && Array.isArray(value) && value.length === 0) await crash()
      return persist(key, value)
    }
  }
  if (kind === "uninstall") await s.api.installationUninstall({ installationId: item.installationId })
  else await s.api.installationSetEnabled({ installationId: item.installationId, enabled: kind === "enable" })
  throw new Error("Lifecycle crash point not reached")
}
