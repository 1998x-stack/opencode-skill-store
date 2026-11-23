import { createHash, randomUUID } from "node:crypto"
import { createWriteStream } from "node:fs"
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { Skill } from "@opencode/plugin"
import type { Plugin } from "@opencode/plugin"
import type { AssetDetail, Installation, Operation, PackageInfo } from "../contracts.js"
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
  private jobs = new Map<string, Promise<void>>()
  private mutationQueue: Promise<void> = Promise.resolve()
  private installationWrite: Promise<void> = Promise.resolve()
  private operationWrite: Promise<void> = Promise.resolve()
  private emit?: Emit
  private skillRegistration?: { dispose: () => Promise<void> }

  constructor(
    private readonly ctx: Plugin.Context,
    private readonly store: StoreClient,
    private readonly config: StoreConfig,
  ) {}

  setEmitter(emit: Emit) {
    this.emit = emit
  }

  private async withMutation<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue
    let release!: () => void
    this.mutationQueue = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await task()
    } finally {
      release()
    }
  }

  async initialize() {
    await mkdir(path.join(this.config.installRoot, "skills"), { recursive: true, mode: 0o700 })
    await mkdir(path.join(this.config.installRoot, "staging"), { recursive: true, mode: 0o700 })
    this.installations = asArray<unknown>(await this.ctx.storage.get("installations"))
      .map(asRecord)
      .filter((item) =>
        typeof item.installationId === "string" &&
        typeof item.assetId === "string" &&
        typeof item.runtimeSkillId === "string" &&
        typeof item.title === "string" &&
        typeof item.version === "string" &&
        typeof item.sha256 === "string" &&
        typeof item.enabled === "boolean" &&
        typeof item.installedAt === "string",
      )
      .map((item) => ({
        ...item,
        description: typeof item.description === "string" ? item.description : String(item.title),
        pinnedVersion: typeof item.pinnedVersion === "string" ? item.pinnedVersion : null,
        status: item.status === "broken" || item.status === "cleanup_pending" ? item.status : "installed",
      })) as Installation[]
    this.operations = asArray<unknown>(await this.ctx.storage.get("operations"))
      .map(asRecord)
      .filter((item) =>
        typeof item.operationId === "string" &&
        typeof item.assetId === "string" &&
        typeof item.title === "string" &&
        typeof item.version === "string" &&
        typeof item.state === "string",
      )
      .map((item) => ({ ...item, idempotencyKey: typeof item.idempotencyKey === "string" ? item.idempotencyKey : null })) as Operation[]

    for (const operation of this.operations) {
      if (ACTIVE_STATES.has(operation.state)) {
        operation.state = "interrupted"
        operation.stage = "recovery"
        operation.message = "OpenCode Server restarted before this operation completed"
        operation.updatedAt = now()
      }
    }
    await this.persistOperations()
    // Abandoned work cannot resume safely after process restart. Remove only our own staging entries.
    await rm(path.join(this.config.installRoot, "staging"), { recursive: true, force: true })
    await mkdir(path.join(this.config.installRoot, "staging"), { recursive: true, mode: 0o700 })
    this.snapshot = await this.loadRuntimeSnapshot()
    this.skillRegistration = await this.ctx.skill.transform((editor) => {
      for (const item of this.snapshot) editor.add(item)
    })
  }

  async close() {
    for (const controller of this.controllers.values()) controller.abort()
    await Promise.allSettled([...this.jobs.values()])
    this.controllers.clear()
    await this.skillRegistration?.dispose()
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
      operationList: async () => ({ items: this.operations.slice(-30).reverse() }),
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
      installationSetEnabled: async (input: unknown) => this.withMutation(async () => {
        const request = asRecord(input)
        const item = this.requireInstallation(String(request.installationId ?? ""))
        this.requireIdle(item.assetId)
        const previous = item.enabled
        item.enabled = request.enabled === true
        try {
          await this.persistInstallations()
          await this.refreshRuntime()
        } catch (error) {
          item.enabled = previous
          await this.persistInstallations()
          await this.refreshRuntime().catch(() => undefined)
          throw error
        }
        await this.publishInstallation(item, item.enabled ? "enabled" : "disabled")
        return { item }
      }),
      installationPin: async (input: unknown) => this.withMutation(async () => {
        const request = asRecord(input)
        const item = this.requireInstallation(String(request.installationId ?? ""))
        this.requireIdle(item.assetId)
        item.pinnedVersion = typeof request.version === "string" ? request.version : null
        await this.persistInstallations()
        return { item }
      }),
      installationUninstall: async (input: unknown) => this.withMutation(async () => {
        const id = String(asRecord(input).installationId ?? "")
        const item = this.requireInstallation(id)
        this.requireIdle(item.assetId)
        const previous = this.installations
        this.installations = previous.filter((entry) => entry.installationId !== id)
        try {
          await this.persistInstallations()
          await this.refreshRuntime()
          await this.removeManagedDirectory(item.runtimeSkillId, item.assetId)
        } catch (error) {
          this.installations = previous
          await this.persistInstallations()
          await this.refreshRuntime().catch(() => undefined)
          throw error
        }
        await this.publishInstallation(item, "uninstalled")
        return { removed: true }
      }),
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
    const assetId = typeof input.assetId === "string" ? input.assetId.trim() : ""
    const requestedVersion = typeof input.version === "string" ? input.version.trim() : undefined
    const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : undefined
    if (!assetId) throw new Error("assetId is required")
    if (assetId.length > 512) throw new Error("assetId is too long")
    if (requestedVersion && !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/.test(requestedVersion))
      throw new Error("Requested version has an unsafe identifier")
    if (idempotencyKey && (!idempotencyKey.length || idempotencyKey.length > 256))
      throw new Error("Idempotency key must contain 1 to 256 characters")

    if (idempotencyKey) {
      const previous = this.operations.find((item) => item.idempotencyKey === idempotencyKey)
      if (previous) {
        if (previous.assetId !== assetId || (requestedVersion && previous.version !== requestedVersion && previous.version !== "latest"))
          throw new Error("Idempotency key was already used for a different request")
        return { operationId: previous.operationId, state: previous.state }
      }
    }
    const active = this.activeByAsset.get(assetId)
    if (active) {
      const current = this.operations.find((item) => item.operationId === active)
      if (!current) this.activeByAsset.delete(assetId)
      else {
        if (requestedVersion && current.version !== requestedVersion)
          throw new Error("A different version of this Skill is already being installed")
        return { operationId: active, state: current.state }
      }
    }

    const operationId = "op_" + randomUUID()
    const operation: Operation = {
      operationId,
      idempotencyKey: idempotencyKey ?? null,
      assetId,
      title: assetId,
      version: requestedVersion ?? "latest",
      kind: this.installations.some((item) => item.assetId === assetId) ? "update" : "install",
      state: "queued",
      stage: "queued",
      progress: 0,
      message: null,
      error: null,
      createdAt: now(),
      updatedAt: now(),
    }
    this.operations.push(operation)
    this.activeByAsset.set(assetId, operationId)
    try {
      await this.persistOperations()
    } catch (error) {
      this.operations = this.operations.filter((item) => item.operationId !== operationId)
      this.activeByAsset.delete(assetId)
      throw error
    }
    const controller = new AbortController()
    this.controllers.set(operationId, controller)
    const job = this.runInstall(operation, requestedVersion, controller.signal).finally(() => {
      this.controllers.delete(operationId)
      this.activeByAsset.delete(assetId)
      this.jobs.delete(operationId)
    })
    this.jobs.set(operationId, job)
    return { operationId, state: operation.state }
  }

  private runInstall(operation: Operation, requestedVersion: string | undefined, signal: AbortSignal) {
    return this.withMutation(() => this.runInstallTransaction(operation, requestedVersion, signal))
  }

  private async runInstallTransaction(operation: Operation, requestedVersion: string | undefined, signal: AbortSignal) {
    const stageRoot = operationPath(this.config.installRoot, operation.operationId)
    const zipFile = path.join(stageRoot, "package.zip")
    const contentDir = path.join(stageRoot, "content")
    let previous: Installation | undefined
    let previousActive: unknown
    let activeChanged = false
    let createdVersion = false
    let committedVersionRoot: string | undefined

    try {
      signal.throwIfAborted()
      await mkdir(stageRoot, { recursive: true, mode: 0o700 })
      await this.progress(operation, "resolving", 5, "Resolving asset and package metadata")
      const detail = await this.store.detail(operation.assetId, signal)
      signal.throwIfAborted()
      if (detail.asset.assetId !== operation.assetId) throw new Error("Skill Store detail returned a different asset ID")
      if (detail.asset.kind.toLowerCase() !== "skill") throw new Error("Only Skill assets can be installed in the OpenCode Skill Runtime")
      if (!detail.asset.title.trim()) throw new Error("Skill Store asset title is empty")
      operation.title = detail.asset.title
      const selected = this.selectVersion(detail, requestedVersion)
      operation.version = selected.version
      const pkg = this.selectPackage(selected.packages, selected.version)
      if (!pkg.sha256 || !/^[a-f0-9]{64}$/i.test(pkg.sha256)) throw new Error("Store package is missing a valid SHA-256 digest")
      if (pkg.sizeBytes <= 0) throw new Error("Store package is missing a valid byte size")
      if (pkg.sizeBytes > this.config.maxPackageBytes) throw new Error("Package exceeds the configured download size limit")

      const id = runtimeID(operation.assetId)
      previous = this.installations.find((item) => item.assetId === operation.assetId)
      const existingRuntime = (await this.ctx.skill.list()).data.find((item) => item.id === id)
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
      signal.throwIfAborted()
      const markdown = await readFile(extracted.skillFile, "utf8")
      const parsed = parseSkillMarkdown(markdown, { name: detail.asset.title, description: detail.asset.description })
      if (!parsed.description.trim()) throw new Error("SKILL.md must provide a description or inherit one from Store metadata")

      await this.progress(operation, "committing", 75, "Committing immutable version directory")
      const skillRoot = path.join(this.config.installRoot, "skills", id)
      const versionRoot = path.join(skillRoot, "versions", selected.version)
      committedVersionRoot = versionRoot
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
        createdVersion = true
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
        description: parsed.description || detail.asset.description || detail.asset.title,
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
      const registered = (await this.ctx.skill.list()).data.some((skill) => skill.id === id)
      if (item.enabled && !registered) throw new Error("RUNTIME_REGISTER_FAILED: Skill Runtime did not expose " + id)

      await this.progress(operation, "installed", 100, "Skill installed and verified in Runtime", "installed")
      await this.publishInstallation(item, "installed")
    } catch (error) {
      const rollbackErrors: string[] = []
      if (activeChanged) {
        const activeFile = path.join(this.config.installRoot, "skills", runtimeID(operation.assetId), "active.json")
        try {
          if (previousActive === undefined) await rm(activeFile, { force: true })
          else await this.atomicJson(activeFile, previousActive)
        } catch (rollbackError) {
          rollbackErrors.push("active pointer restore failed: " + errorMessage(rollbackError))
        }
        this.installations = previous
          ? [...this.installations.filter((item) => item.assetId !== previous!.assetId), previous]
          : this.installations.filter((item) => item.assetId !== operation.assetId)
        try {
          await this.persistInstallations()
        } catch (rollbackError) {
          rollbackErrors.push("installation state restore failed: " + errorMessage(rollbackError))
        }
        try {
          await this.refreshRuntime()
        } catch (rollbackError) {
          rollbackErrors.push("Runtime restore failed: " + errorMessage(rollbackError))
          if (previous) {
            previous.status = "broken"
            try { await this.persistInstallations() } catch (persistError) {
              rollbackErrors.push("broken status persistence failed: " + errorMessage(persistError))
            }
          }
        }
        if (createdVersion && committedVersionRoot) {
          try { await rm(committedVersionRoot, { recursive: true, force: true }) }
          catch (rollbackError) { rollbackErrors.push("new version cleanup failed: " + errorMessage(rollbackError)) }
        }
      } else if (createdVersion && committedVersionRoot) {
        try { await rm(committedVersionRoot, { recursive: true, force: true }) }
        catch (rollbackError) { rollbackErrors.push("new version cleanup failed: " + errorMessage(rollbackError)) }
      }

      const cancelled = signal.aborted
      const originalError = errorMessage(error)
      const terminalState = cancelled ? "cancelled" : "failed"
      const terminalMessage = cancelled ? "Operation cancelled" : "Installation failed"
      const terminalError = [originalError, ...rollbackErrors].filter(Boolean).join(" | ")
      try {
        await this.progress(operation, "terminal", operation.progress, terminalMessage, terminalState, terminalError)
      } catch (persistError) {
        // Keep the in-memory state terminal even if durable storage is temporarily unavailable.
        operation.stage = "terminal"
        operation.state = terminalState
        operation.message = terminalMessage
        operation.error = [terminalError, "operation state persistence failed: " + errorMessage(persistError)].filter(Boolean).join(" | ")
        operation.updatedAt = now()
        await this.emit?.("operationProgress", operation as unknown as Record<string, unknown>).catch(() => undefined)
      }
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

  private selectPackage(packages: PackageInfo[], version: string) {
    const exact = packages.find((item) => item.version === version &&
      (item.platform === process.platform || item.platform === "any") &&
      (item.arch === process.arch || item.arch === "any"))
    if (!exact) throw new Error("No Skill Store package for this version matches the OpenCode Server platform")
    if (!exact.packageId.trim()) throw new Error("Skill Store package ID is empty")
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
    // A disconnected UI must not turn a successful filesystem transaction into a failed install.
    await this.emit?.("operationProgress", operation as unknown as Record<string, unknown>).catch(() => undefined)
  }

  private async refreshRuntime() {
    this.snapshot = await this.loadRuntimeSnapshot()
    await this.ctx.skill.reload()
  }

  private async loadRuntimeSnapshot() {
    const result: Array<ReturnType<typeof this.runtimeInfo>> = []
    const installRoot = await realpath(this.config.installRoot)
    for (const item of this.installations) {
      if (!item.enabled || (item.status !== "installed" && item.status !== "broken")) continue
      if (item.runtimeSkillId !== runtimeID(item.assetId) || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/.test(item.version)) {
        item.status = "broken"
        continue
      }
      const versionRoot = path.join(installRoot, "skills", item.runtimeSkillId, "versions", item.version)
      const skillFile = path.join(versionRoot, "SKILL.md")
      try {
        const resolvedSkillFile = await realpath(skillFile)
        const relative = path.relative(installRoot, resolvedSkillFile)
        if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
          throw new Error("Installed Skill path escapes the managed root")
        const info = await lstat(skillFile)
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("Installed SKILL.md is not a regular file")
        const markdown = await readFile(resolvedSkillFile, "utf8")
        const parsed = parseSkillMarkdown(markdown, {
          name: item.title,
          description: item.description || item.title,
        })
        item.description = parsed.description || item.description || item.title
        item.status = "installed"
        result.push(this.runtimeInfo(item.runtimeSkillId, resolvedSkillFile, parsed))
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
    await this.emit?.("installationChanged", { installationId: item.installationId, action }).catch(() => undefined)
  }

  private requireIdle(assetId: string) {
    if (this.activeByAsset.has(assetId)) throw new Error("A Skill installation or update is already in progress")
  }

  private requireInstallation(id: string) {
    const item = this.installations.find((entry) => entry.installationId === id)
    if (!item) throw new Error("Installation not found: " + id)
    return item
  }

  private async removeManagedDirectory(runtimeSkillId: string, assetId: string) {
    if (runtimeSkillId !== runtimeID(assetId)) throw new Error("Refusing to remove a directory not owned by this Store installation")
    const root = path.resolve(this.config.installRoot, "skills")
    const target = path.resolve(root, runtimeSkillId)
    const relative = path.relative(root, target)
    if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
      throw new Error("Refusing to remove a path outside the managed Skill directory")
    await rm(target, { recursive: true, force: true })
  }

  private async atomicJson(filename: string, value: unknown) {
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
    const temporary = filename + "." + randomUUID() + ".tmp"
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
    await rename(temporary, filename)
  }

  private async persistInstallations() {
    const snapshot = structuredClone(this.installations)
    const write = this.installationWrite.then(() => this.ctx.storage.set("installations", snapshot))
    this.installationWrite = write.catch(() => undefined)
    await write
  }

  private async persistOperations() {
    this.operations = this.operations.slice(-100)
    const snapshot = structuredClone(this.operations)
    const write = this.operationWrite.then(() => this.ctx.storage.set("operations", snapshot))
    this.operationWrite = write.catch(() => undefined)
    await write
  }
}
