import { createWriteStream } from "node:fs"
import { mkdir, stat } from "node:fs/promises"
import path from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import yauzl from "yauzl"
import type { Entry, ZipFile } from "yauzl"

export type ArchiveLimits = {
  maxEntries: number
  maxUnpackedBytes: number
  maxSkillFileBytes: number
  maxCompressionRatio: number
}

const windowsReserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

export function safeArchivePath(root: string, entryName: string): string {
  if (!entryName || entryName.includes("\u0000") || entryName.includes("\\") || entryName.includes(":"))
    throw new Error("Unsafe ZIP entry path")
  if (path.posix.isAbsolute(entryName) || /^[a-zA-Z]:/.test(entryName) || entryName.startsWith("//"))
    throw new Error("Absolute ZIP entry paths are not allowed")

  const clean = entryName.endsWith("/") ? entryName.slice(0, -1) : entryName
  const parts = clean.split("/")
  if (parts.some((part) => !part || part === "." || part === ".." || part.endsWith(".") || part.endsWith(" ")))
    throw new Error("ZIP entry contains an unsafe path segment")
  if (parts.some((part) => windowsReserved.test(part))) throw new Error("ZIP entry contains a reserved device name")

  const target = path.resolve(root, ...parts)
  const relative = path.relative(root, target)
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
    throw new Error("ZIP entry escapes the staging directory")
  return target
}

function openZip(filename: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      filename,
      { lazyEntries: true, autoClose: false, decodeStrings: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => {
        if (error || !zip) return reject(error ?? new Error("Could not open ZIP archive"))
        resolve(zip)
      },
    )
  })
}

function openEntry(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) return reject(error ?? new Error("Could not read ZIP entry"))
      resolve(stream)
    })
  })
}

export async function extractSkillArchive(filename: string, destination: string, limits: ArchiveLimits) {
  await mkdir(destination, { recursive: true, mode: 0o700 })
  const zip = await openZip(filename)
  const names = new Set<string>()
  let entries = 0
  let totalBytes = 0

  const processEntry = async (entry: Entry) => {
    entries += 1
    if (entries > limits.maxEntries) throw new Error("ZIP contains too many entries")
    if ((entry.generalPurposeBitFlag & 0x0001) !== 0) throw new Error("Encrypted ZIP entries are not supported")

    const mode = (entry.externalFileAttributes >>> 16) & 0xffff
    const fileType = mode & 0o170000
    const directory = entry.fileName.endsWith("/")
    if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000)
      throw new Error("ZIP contains a symbolic link or special file")
    if (directory && fileType === 0o100000) throw new Error("ZIP directory has a regular-file mode")
    if (!directory && fileType === 0o040000) throw new Error("ZIP file has a directory mode")

    const key = entry.fileName.toLowerCase()
    if (names.has(key)) throw new Error("ZIP contains duplicate paths")
    names.add(key)

    const target = safeArchivePath(destination, entry.fileName)
    if (directory) {
      await mkdir(target, { recursive: true, mode: 0o700 })
      return
    }

    if (entry.uncompressedSize > limits.maxUnpackedBytes) throw new Error("ZIP entry exceeds the unpacked size limit")
    if (entry.uncompressedSize > 0 && (entry.compressedSize === 0 || entry.uncompressedSize / entry.compressedSize > limits.maxCompressionRatio))
      throw new Error("ZIP entry exceeds the compression-ratio limit")
    totalBytes += entry.uncompressedSize
    if (totalBytes > limits.maxUnpackedBytes) throw new Error("ZIP exceeds the total unpacked size limit")

    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    let written = 0
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        written += chunk.byteLength
        if (written > entry.uncompressedSize || totalBytes - entry.uncompressedSize + written > limits.maxUnpackedBytes)
          return callback(new Error("ZIP entry expanded beyond its declared size"))
        callback(null, chunk)
      },
    })
    await pipeline(await openEntry(zip, entry), meter, createWriteStream(target, { flags: "wx", mode: 0o600 }))
    if (written !== entry.uncompressedSize) throw new Error("ZIP entry size did not match its directory record")
  }

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        zip.close()
        reject(error)
      }
      zip.on("error", fail)
      zip.on("entry", (entry) => {
        void processEntry(entry).then(() => zip.readEntry(), fail)
      })
      zip.on("end", () => {
        if (settled) return
        settled = true
        zip.close()
        resolve()
      })
      zip.readEntry()
    })
    const skillFile = path.join(destination, "SKILL.md")
    const info = await stat(skillFile)
    if (!info.isFile() || info.size === 0) throw new Error("ZIP root must contain a non-empty SKILL.md")
    if (info.size > limits.maxSkillFileBytes) throw new Error("SKILL.md exceeds the configured size limit")
    return { skillFile, entries, unpackedBytes: totalBytes }
  } catch (error) {
    zip.close()
    throw error
  }
}
