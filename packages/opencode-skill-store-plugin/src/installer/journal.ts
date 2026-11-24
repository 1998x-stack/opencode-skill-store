import { randomUUID } from "node:crypto"
import { lstat, open, readFile, rename, rm } from "node:fs/promises"
import path from "node:path"
import type { Installation } from "../contracts.js"

const MAX_JOURNAL_BYTES = 1024 * 1024

export type InstallJournal = {
  schemaVersion: 1
  operationId: string
  phase: "prepared" | "committed"
  previous: Installation | null
  candidate: Installation
}

function validInstallation(value: unknown): value is Installation {
  if (!value || typeof value !== "object") return false
  const row = value as Record<string, unknown>
  return ["installationId", "assetId", "runtimeSkillId", "title", "description", "version", "sha256", "installedAt"]
    .every((key) => typeof row[key] === "string") &&
    typeof row.enabled === "boolean" &&
    (row.pinnedVersion === null || typeof row.pinnedVersion === "string") &&
    ["installed", "broken", "cleanup_pending"].includes(String(row.status)) &&
    /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/.test(String(row.version)) &&
    /^[a-f0-9]{64}$/i.test(String(row.sha256))
}

/** One writer per Location. The rename is the process-crash commit boundary.
 * File contents are synced before rename; power-loss durability is not claimed.
 */
export async function atomicJson(filename: string, value: unknown): Promise<void> {
  const temporary = filename + "." + randomUUID() + ".tmp"
  try {
    const file = await open(temporary, "wx", 0o600)
    try {
      await file.writeFile(JSON.stringify(value, null, 2))
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, filename)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

/** A single pending journal suffices because InstallManager serializes mutations. */
export class JournalStore {
  private readonly filename: string

  constructor(root: string) {
    this.filename = path.join(root, "install-journal.json")
  }

  async read(): Promise<InstallJournal | null> {
    try {
      const info = await lstat(this.filename)
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_JOURNAL_BYTES)
        throw new Error("Invalid Skill Store transaction journal file")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
    const row = JSON.parse(await readFile(this.filename, "utf8")) as Partial<InstallJournal> | null
    if (!row || row.schemaVersion !== 1 || typeof row.operationId !== "string" ||
        !/^op_[a-f0-9-]{36}$/.test(row.operationId) ||
        (row.phase !== "prepared" && row.phase !== "committed") ||
        !validInstallation(row.candidate) || row.candidate.status !== "installed" ||
        (row.previous !== null && !validInstallation(row.previous)) ||
        (row.previous && (row.previous.assetId !== row.candidate.assetId ||
          row.previous.runtimeSkillId !== row.candidate.runtimeSkillId ||
          row.previous.installationId !== row.candidate.installationId)))
      throw new Error("Invalid Skill Store transaction journal contents")
    return row as InstallJournal
  }

  async write(value: InstallJournal): Promise<void> {
    if (Buffer.byteLength(JSON.stringify(value, null, 2)) > MAX_JOURNAL_BYTES)
      throw new Error("Skill Store transaction journal exceeds its size limit")
    await atomicJson(this.filename, value)
  }

  async clear(): Promise<void> {
    await rm(this.filename, { force: true })
  }
}
