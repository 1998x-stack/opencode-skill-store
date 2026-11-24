import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { JournalStore, type InstallJournal } from "./journal.js"

function fixture(): InstallJournal {
  return {
    schemaVersion: 1, operationId: "op_12345678-1234-1234-1234-123456789abc", phase: "prepared",
    previous: null,
    candidate: {
      installationId: "ins_test", assetId: "asset-test", runtimeSkillId: "ss-test",
      title: "Test", description: "Test skill", version: "1.0.0", sha256: "a".repeat(64),
      enabled: true, pinnedVersion: null, installedAt: "2026-11-24T00:00:00Z", status: "installed",
    },
  }
}

describe("JournalStore", () => {
  test("round-trips prepared and committed markers, then clears", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "journal-test-"))
    try {
      const store = new JournalStore(root)
      expect(await store.read()).toBeNull()
      const journal = fixture()
      await store.write(journal)
      expect(await store.read()).toEqual(journal)
      const committed = { ...journal, phase: "committed" as const }
      await store.write(committed)
      expect(await store.read()).toEqual(committed)
      await store.clear()
      expect(await store.read()).toBeNull()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test("rejects malformed or unsupported persisted journal without deleting it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "journal-test-"))
    try {
      const store = new JournalStore(root)
      await writeFile(path.join(root, "install-journal.json"), "{not-json")
      await expect(store.read()).rejects.toThrow()
      await writeFile(path.join(root, "install-journal.json"), JSON.stringify({ ...fixture(), schemaVersion: 2 }))
      await expect(store.read()).rejects.toThrow("Invalid Skill Store transaction journal")
      await store.clear()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test("refuses oversized journal before replacing the existing marker", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "journal-test-"))
    try {
      const store = new JournalStore(root)
      const journal = fixture()
      await store.write(journal)
      await expect(store.write({ ...journal, candidate: { ...journal.candidate, description: "x".repeat(1024 * 1024) } }))
        .rejects.toThrow("size limit")
      expect(await store.read()).toEqual(journal)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
