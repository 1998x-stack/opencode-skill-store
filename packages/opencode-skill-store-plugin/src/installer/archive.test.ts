import { describe, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { extractSkillArchive, safeArchivePath } from "./archive.js"

const limits = { maxEntries: 20, maxUnpackedBytes: 64 * 1024, maxCompressionRatio: 100 }
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

async function fixture(entries: FixtureEntry[], callback: (archive: string, destination: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-store-test-"))
  const archive = path.join(root, randomUUID() + ".zip")
  const destination = path.join(root, "extracted")
  try {
    await writeFile(archive, zip(entries))
    await callback(archive, destination)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe("safeArchivePath", () => {
  const root = path.resolve(tmpdir(), "store-stage")
  test("accepts files within extraction root", () => {
    expect(safeArchivePath(root, "SKILL.md")).toBe(path.join(root, "SKILL.md"))
    expect(safeArchivePath(root, "references/proof.txt")).toBe(path.join(root, "references", "proof.txt"))
  })
  test.each([
    "../outside.txt", "a/../../outside.txt", "/etc/passwd", "C:/Windows/system.ini",
    "\\\\server\\share\\payload", "folder\\..\\payload", "file.txt:stream",
    "NUL.txt", "folder/../file.txt", "./file.txt", "folder./file.txt", "folder /file.txt",
  ])("rejects hostile name %s", (name) => {
    expect(() => safeArchivePath(root, name)).toThrow()
  })
})

describe("extractSkillArchive", () => {
  const skill: FixtureEntry = { name: "SKILL.md", content: "---\nname: Test\n---\n# Test" }
  test("extracts SKILL.md and supporting files without modifying contents", async () => {
    await fixture([skill, { name: "references/proof.txt", content: "proof-123" }], async (archive, destination) => {
      const result = await extractSkillArchive(archive, destination, limits)
      expect(result.entries).toBe(2)
      expect(await readFile(result.skillFile, "utf8")).toContain("name: Test")
      expect(await readFile(path.join(destination, "references/proof.txt"), "utf8")).toBe("proof-123")
    })
  })
  test("rejects missing root SKILL.md", async () => {
    await fixture([{ name: "nested/SKILL.md", content: "# Wrong root" }], async (archive, dest) => {
      await expect(extractSkillArchive(archive, dest, limits)).rejects.toThrow()
    })
  })
  test("rejects parent traversal before writing outside staging", async () => {
    await fixture([skill, { name: "../outside.txt", content: "bad" }], async (archive, dest) => {
      await expect(extractSkillArchive(archive, dest, limits)).rejects.toThrow("unsafe")
    })
  })
  test("rejects Unix symlink entries", async () => {
    await fixture([skill, { name: "link", content: "SKILL.md", mode: 0o120777 }], async (archive, dest) => {
      await expect(extractSkillArchive(archive, dest, limits)).rejects.toThrow("symbolic link")
    })
  })
  test("rejects encrypted entries", async () => {
    await fixture([skill, { name: "secrets.txt", content: "hidden", flags: 1 }], async (archive, dest) => {
      await expect(extractSkillArchive(archive, dest, limits)).rejects.toThrow()
    })
  })
  test("rejects duplicate names in a case-insensitive filesystem", async () => {
    await fixture([skill, { name: "references/X.txt", content: "a" }, { name: "references/x.txt", content: "b" }], async (archive, dest) => {
      await expect(extractSkillArchive(archive, dest, limits)).rejects.toThrow("duplicate")
    })
  })
  test("rejects too many files", async () => {
    await fixture([skill, { name: "a.txt", content: "a" }], async (archive, dest) => {
      await expect(extractSkillArchive(archive, dest, { ...limits, maxEntries: 1 })).rejects.toThrow("too many")
    })
  })
  test("rejects total uncompressed size beyond budget", async () => {
    await fixture([skill, { name: "a.txt", content: "a".repeat(200) }], async (archive, dest) => {
      await expect(extractSkillArchive(archive, dest, { ...limits, maxUnpackedBytes: 180 })).rejects.toThrow("size limit")
    })
  })
})
