import { environment } from "./manager.test-support.js"

const [root, cutpoint] = process.argv.slice(2)
if (!root || !["before-kv", "after-kv", "runtime", "after-commit"].includes(cutpoint ?? ""))
  throw new Error("Expected test root and crash cutpoint")
const s = await environment({
  root, persistent: true,
  crashAt: cutpoint as "before-kv" | "after-kv" | "runtime" | "after-commit",
})
s.current.version = "1.1.0"
const started = await s.api.installStart({ assetId: s.current.assetId, version: "1.1.0", idempotencyKey: "crash-update" })
await s.settle(started.operationId)
throw new Error("Crash cutpoint was not reached")
