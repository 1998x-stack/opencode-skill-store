import { createHash, randomUUID } from "node:crypto"
import { createWriteStream } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { Skill } from "@opencode/plugin"
import type { Plugin } from "@opencode/plugin"
import type { AssetDetail, AssetSummary, Installation, Operation, PackageInfo } from "../contracts.js"
import type { StoreConfig } from "../config.js"
import { extractSkillArchive } from "./archive.js"
import { parseSkillMarkdown } from "../runtime/frontmatter.js"
import { StoreClient } from "../store/client.js"

type Emit = (name: "operationProgress" | "installationChanged", data: Record<string, unknown>) => Promise<void>

type InstallRequest = { assetId: string; version?: string; idempotencyKey?: string }
type RuntimeSkill = Skill.Info

const ACTIVE_STATES = new Set(["queued", "running"])

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36) || "skill"
}

function runtimeID(assetId: string) {
  return "ss-" + slug(assetId) + "-" + digest(assetId).slice(0, 8)
}

function now() {
  return new Date().toISOString()
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function operationPath(root: string, id: string) {
  return path.join(root, "staging", id)
}

export class InstallManager {
  private installations: Installation[] = []
  private operations: Operation[] = []
  private snapshot: RuntimeSkill[] = []
  private controllers = new Map<string, AbortController>()
  private activeByAsset = new Map<string, string>()
  private emit?: Emit

  constructor(
    private readonly ctx: Plugin.Context,
    private readonly store: StoreClient,
    private readonly config: StoreConfig,
  ) {}

  setEmitter(emit: Emit) {
    this.emit = emit
  }

  async initialize() {
    await mkdir(path.join(this.config.installRoot, "skills"), { recursive: true, mode: 0o700 })
    await mkdir(path.join(this.config.installRoot, "staging"), { recursive: true, mode: 0o700 })
    this.installations = asArray<Installation>(await this.ctx.storage.get("installations"))
    this.operations = asArray<Operation>(await this.ctx.storage.get("operations"))

    for (const operation of this.operations) {
      if (ACTIVE_STATES.has(operation.state)) {
        operation.state = "interrupted"
        operation.stage = "recovery"
        operation.message = "OpenCode Server restarted before this operation completed"
        operation.updatedAt = now()
      }
    }
    await this.persistOperations()
    this.snapshot = await this.loadRuntimeSnapshot()
    await this.ctx.skill.transform((editor) => {
      for (const item of this.snapshot) editor.add(item)
    })
  }

  async close() {
    for (const controller of this.controllers.values()) controller.abort()
    this.controllers.clear()
  }

  handlers() {
    return {
      catalogSearch: async (input: unknown) => {
        const request = asRecord(input)
        return this.store.search({
          query: typeof request.query === "string" ? request.query : undefined,
          cursor: typeof request.cursor === "string" ? request.cursor : undefined,
          limit: typeof request.limit === "number" ? request.limit : 24,
        })
      },
      catalogDetail: async (input: unknown) => {
        const request = asRecord(input)
        return this.store.detail(String(request.assetId ?? ""))
      },
      installationList: async () => ({ items: this.installations }),
      operationList: async () => ({ items: this.operations.slice(-30).toReversed() }),
      installStart: async (input: unknown) => this.start(input as InstallRequest),
      operationGet: async (input: unknown) => {
        const id = String(asRecord(input).operationId ?? "")
        return { operation: this.operations.find((item) => item.operationId === id) ?? null }
      },
      operationCancel: async (input: unknown) => {
        const id = String(asRecord(input).operationId ?? "")
        const controller = this.controllers.get(id)
        if (!controller) return { cancelled: false }
        controller.abort()
        return { cancelled: true }
      },
      installationSetEnabled: async (input: unknown) => {
        const request = asRecord(input)
        const item = this.requireInstallation(String(request.installationId ?? ""))
        item.enabled = request.enabled === true
        await this.persistInstallations()
        await this.refreshRuntime()
        await this.publishInstallation(item, item.enabled ? "enabled" : "disabled")
        return { item }
      },
      installationPin: async (input: unknown) => {
        const request = asRecord(input)
        const item = this.requireInstallation(String(request.installationId ?? ""))
        item.pinnedVersion = typeof request.version === "string" ? request.version : null
        await this.persistInstallations()
        return { item }
      },
      installationUninstall: async (input: unknown) => {
        const id = String(asRecord(input).installationId ?? "")
        const item = this.requireInstallation(id)
        this.installations = this.installations.filter((entry) => entry.installationId !== id)
        await this.persistInstallations()
        await this.refreshRuntime()
        await this.removeManagedDirectory(item.runtimeSkillId)
        await this.publishInstallation(item, "uninstalled")
        return { removed: true }
      },
      updateCheck: async () => {
        const updates: Array<{ installationId: string; assetId: string; currentVersion: string; latestVersion: string }> = []
        for (const item of this.installations) {
          if (item.pinnedVersion) continue
          const detail = await this.store.detail(item.assetId)
          const latest = detail.asset.latestVersion ?? detail.versions[0]?.version
          if (latest && latest !== item.version) {
            updates.push({
              installationId: item.installationId,
              assetId: item.assetId,
              currentVersion: item.version,
              latestVersion: latest,
            })
          }
        }
        return { updates }
      },
    }
  }

  private async start(input: InstallRequest) {
    if (!input.assetId) throw new Error("assetId is required")
    const idempotencyKey = input.idempotencyKey
    if (idempotencyKey) {
      const previous = this.operations.find((item) => item.idempotencyKey === idempotencyKey)
      if (previous) return { operationId: previous.operationId, state: previous.state }
    }
    const active = this.activeByAsset.get(input.assetId)
    if (active) return { operationId: active, state: "running" }

    const operationId = "op_" + randomUUID()
    const operation: Operation = {
      operationId,
      idempotencyKey: idempotencyKey ?? null,
      assetId: input.assetId,
      title: input.assetId,
      version: input.version ?? "latest",
      kind: this.installations.some((item) => item.assetId === input.assetId) ? "update" : "install",
      state: "queued",
      stage: "queued",
      progress: 0,
      message: idempotencyKey ? "idempotency:" + idempotencyKey : null,
      error: null,
      createdAt: now(),
      updatedAt: now(),
    }
    this.operations.push(operation)
    this.activeByAsset.set(input.assetId, operationId)
    await this.persistOperations()
    const controller = new AbortController()
    this.controllers.set(operationId, controller)
    void this.runInstall(operation, input.version, controller.signal).finally(() => {
      this.controllers.delete(operationId)
      this.activeByAsset.delete(input.assetId)
    })
    return { operationId, state: operation.state }
  }

  private async runInstall(operation: Operation, requestedVersion: string | undefined, signal: AbortSignal) {
    const stageRoot = operationPath(this.config.installRoot, operation.operationId)
    const zipFile = path.join(stageRoot, "package.zip")
    const contentDir = path.join(stageRoot, "content")
    let previous: Installation | undefined
    let previousActive: unknown
    let activeChanged = false

    try {
      await mkdir(stageRoot, { recursive: true, mode: 0o700 })
      await this.progress(operation, "resolving", 5, "Resolving asset and package metadata")
      const detail = await this.store.detail(operation.assetId)
      operation.title = detail.asset.title
      const selected = this.selectVersion(detail, requestedVersion)
      operation.version = selected.version
      const pkg = this.selectPackage(selected.packages)
      if (!pkg.sha256 || !/^[a-f0-9]{64}$/i.test(pkg.sha256)) throw new Error("Store package is missing a valid SHA-256 digest")
      if (pkg.sizeBytes > this.config.maxPackageBytes) throw new Error("Package exceeds the configured download size limit")

      const id = runtimeID(operation.assetId)
      previous = this.installations.find((item) => item.assetId === operation.assetId)
      const existingRuntime = (await this.ctx.skill.list()).find((item) => item.id === id)
      if (existingRuntime && !previous) throw new Error("Runtime Skill ID conflict: " + id)

      await this.progress(operation, "downloading", 20, "Downloading package")
      const response = await this.store.download(pkg.packageId, signal)
      const downloaded = await this.downloadToFile(response, zipFile, signal)
      if (downloaded.bytes > this.config.maxPackageBytes) throw new Error("Downloaded package exceeds the configured size limit")
      if (pkg.sizeBytes > 0 && downloaded.bytes !== pkg.sizeBytes) throw new Error("Downloaded package size does not match Store metadata")
      await this.progress(operation, "verifying", 40, "Verifying SHA-256 and package size")
      if (downloaded.sha256.toLowerCase() !== pkg.sha256.toLowerCase()) throw new Error("DIGEST_MISMATCH: package SHA-256 did not match Store metadata")

      await this.progress(operation, "extracting", 55, "Validating and extracting ZIP")
      const extracted = await extractSkillArchive(zipFile, contentDir, {
        maxEntries: this.config.maxEntries,
        maxUnpackedBytes: this.config.maxUnpackedBytes,
        maxCompressionRatio: this.config.maxCompressionRatio,
      })
      const markdown = await readFile(extracted.skillFile, "utf8")
      const parsed = parseSkillMarkdown(markdown, { name: detail.asset.title, description: detail.asset.description })
      if (!parsed.description.trim()) throw new Error("SKILL.md must provide a description or inherit one from Store metadata")

      await this.progress(operation, "committing", 75, "Committing immutable version directory")
      const skillRoot = path.join(this.config.installRoot, "skills", id)
      const versionRoot = path.join(skillRoot, "versions", selected.version)
      await mkdir(path.dirname(versionRoot), { recursive: true, mode: 0o700 })
      const manifestPath = path.join(versionRoot, ".store-manifest.json")

      try {
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { sha256?: string }
        if (manifest.sha256 !== downloaded.sha256) throw new Error("VERSION_IMMUTABLE: same version has different package bytes")
        await rm(contentDir, { recursive: true, force: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        try {
          await readFile(path.join(versionRoot, "SKILL.md"))
          throw new Error("VERSION_IMMUTABLE: existing version has no trusted package manifest")
        } catch (existing) {
          if ((existing as NodeJS.ErrnoException).code !== "ENOENT") throw existing
        }
        await writeFile(
          path.join(contentDir, ".store-manifest.json"),
          JSON.stringify({ assetId: operation.assetId, version: selected.version, packageId: pkg.packageId, sha256: downloaded.sha256 }),
          { mode: 0o600 },
        )
        await rename(contentDir, versionRoot)
      }

      const activeFile = path.join(skillRoot, "active.json")
      try {
        previousActive = JSON.parse(await readFile(activeFile, "utf8"))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      await this.atomicJson(activeFile, { version: selected.version, sha256: downloaded.sha256, updatedAt: now() })
      activeChanged = true

      const item: Installation = {
        installationId: previous?.installationId ?? "ins_" + digest(operation.assetId).slice(0, 16),
        assetId: operation.assetId,
        runtimeSkillId: id,
        title: detail.asset.title,
        version: selected.version,
        sha256: downloaded.sha256,
        enabled: previous?.enabled ?? true,
        pinnedVersion: previous?.pinnedVersion ?? null,
        installedAt: previous?.installedAt ?? now(),
        status: "installed",
      }
      this.installations = [...this.installations.filter((entry) => entry.assetId !== item.assetId), item]
      await this.persistInstallations()

      await this.progress(operation, "registering", 90, "Registering Skill in OpenCode Runtime")
      await this.refreshRuntime()
      const registered = (await this.ctx.skill.list()).some((skill) => skill.id === id)
      if (item.enabled && !registered) throw new Error("RUNTIME_REGISTER_FAILED: Skill Runtime did not expose " + id)

      await this.progress(operation, "installed", 100, "Skill installed and verified in Runtime", "installed")
      await this.publishInstallation(item, "installed")
    } catch (error) {
      if (activeChanged) {
        const activeFile = path.join(this.config.installRoot, "skills", runtimeID(operation.assetId), "active.json")
        if (previousActive === undefined) await rm(activeFile, { force: true })
        else await this.atomicJson(activeFile, previousActive)
        this.installations = previous
          ? [...this.installations.filter((item) => item.assetId !== previous!.assetId), previous]
          : this.installations.filter((item) => item.assetId !== operation.assetId)
        await this.persistInstallations()
        await this.refreshRuntime().catch(() => undefined)
      }
      const cancelled = signal.aborted
      await this.progress(
        operation,
        cancelled ? "cancelled" : "failed",
        operation.progress,
        cancelled ? "Operation cancelled" : "Installation failed",
        cancelled ? "cancelled" : "failed",
        error instanceof Error ? error.message : String(error),
      )
    } finally {
      await rm(stageRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private selectVersion(detail: AssetDetail, requested?: string) {
    const version = requested ?? detail.asset.latestVersion ?? detail.versions[0]?.version
    if (!version || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/.test(version)) throw new Error("Skill Store returned an unsafe version identifier")
    const selected = detail.versions.find((item) => item.version === version)
    if (!selected) throw new Error("Requested version is not available in Skill Store")
    return selected
  }

  private selectPackage(packages: PackageInfo[]) {
    const exact = packages.find((item) => (item.platform === process.platform || item.platform === "any") &&
      (item.arch === process.arch || item.arch === "any"))
    if (!exact) throw new Error("No Skill Store package matches this OpenCode Server platform")
    return exact
  }

  private async downloadToFile(response: Response, filename: string, signal: AbortSignal) {
    const hash = createHash("sha256")
    let bytes = 0
    const meter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        bytes += chunk.byteLength
        if (bytes > this.config.maxPackageBytes) return callback(new Error("Package download exceeds the configured limit"))
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    const source = Readable.fromWeb(response.body as never)
    await pipeline(source, meter, createWriteStream(filename, { flags: "wx", mode: 0o600 }), { signal })
    return { bytes, sha256: hash.digest("hex") }
  }

  private async progress(
    operation: Operation,
    stage: string,
    progress: number,
    message: string,
    state: Operation["state"] = "running",
    error: string | null = null,
  ) {
    operation.stage = stage
    operation.progress = progress
    operation.message = message
    operation.state = state
    operation.error = error
    operation.updatedAt = now()
    await this.persistOperations()
    await this.emit?.("operationProgress", operation as unknown as Record<string, unknown>)
  }

  private async refreshRuntime() {
    this.snapshot = await this.loadRuntimeSnapshot()
    await this.ctx.skill.reload()
  }

  private async loadRuntimeSnapshot() {
    const result: Array<ReturnType<typeof this.runtimeInfo>> = []
    for (const item of this.installations) {
      if (!item.enabled || item.status !== "installed") continue
      const versionRoot = path.join(this.config.installRoot, "skills", item.runtimeSkillId, "versions", item.version)
      const skillFile = path.join(versionRoot, "SKILL.md")
      try {
        const markdown = await readFile(skillFile, "utf8")
        const parsed = parseSkillMarkdown(markdown, { name: item.title, description: item.title })
        result.push(this.runtimeInfo(item.runtimeSkillId, skillFile, parsed))
      } catch {
        item.status = "broken"
      }
    }
    await this.persistInstallations()
    return result
  }

  private runtimeInfo(id: string, skillFile: string, parsed: ReturnType<typeof parseSkillMarkdown>): RuntimeSkill {
    return {
      id: Skill.ID.make(id),
      name: Skill.Name.make(parsed.name),
      description: parsed.description,
      autoinvoke: parsed.autoinvoke,
      path: Skill.Info.fields.path.make(skillFile),
      content: parsed.body,
    }
  }

  private async publishInstallation(item: Installation, action: string) {
    await this.emit?.("installationChanged", { installationId: item.installationId, action })
  }

  private requireInstallation(id: string) {
    const item = this.installations.find((entry) => entry.installationId === id)
    if (!item) throw new Error("Installation not found: " + id)
    return item
  }

  private async removeManagedDirectory(runtimeSkillId: string) {
    const root = path.resolve(this.config.installRoot, "skills")
    const target = path.resolve(root, runtimeSkillId)
    const relative = path.relative(root, target)
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Refusing to remove a path outside the managed Skill directory")
    await rm(target, { recursive: true, force: true })
  }

  private async atomicJson(filename: string, value: unknown) {
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
    const temporary = filename + "." + randomUUID() + ".tmp"
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
    await rename(temporary, filename)
  }

  private async persistInstallations() {
    await this.ctx.storage.set("installations", this.installations)
  }

  private async persistOperations() {
    this.operations = this.operations.slice(-100)
    await this.ctx.storage.set("operations", this.operations)
  }
}
