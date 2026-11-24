import { Database } from "bun:sqlite"
import { lstat } from "node:fs/promises"
import path from "node:path"

/**
 * Hold an SQLite write transaction for the entire manager lifetime.
 * OS-backed SQLite locks are released on process exit, including SIGKILL.
 * The lock database contains no application state and must never be deleted
 * while a manager may be running. Local filesystems only.
 */
export class LocationLock {
  private constructor(private readonly db: Database) {}

  static async acquire(root: string): Promise<LocationLock> {
    const filename = path.join(root, "location-writer.sqlite")
    try {
      const info = await lstat(filename)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid Location lock file")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    const db = new Database(filename, { create: true, readwrite: true })
    try {
      db.exec("PRAGMA busy_timeout = 0")
      db.exec("BEGIN IMMEDIATE")
      return new LocationLock(db)
    } catch (error) {
      db.close()
      throw new Error("Cannot acquire Skill Store Location writer lock", { cause: error })
    }
  }

  release(): void {
    try {
      this.db.exec("ROLLBACK")
    } finally {
      this.db.close()
    }
  }
}
