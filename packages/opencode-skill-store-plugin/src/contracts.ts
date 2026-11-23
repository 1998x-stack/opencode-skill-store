import { Rpc } from "@opencode/plugin"

const string = { type: "string" } as const
const boolean = { type: "boolean" } as const
const integer = { type: "integer", minimum: 0 } as const
const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] } as const

const object = <const P extends Record<string, unknown>>(properties: P, required: readonly string[] = []) =>
  ({
    type: "object",
    properties,
    required: [...required],
    additionalProperties: false,
  }) as const

const asset = object(
  {
    assetId: string,
    title: string,
    description: string,
    kind: string,
    tags: { type: "array", items: string },
    latestVersion: nullableString,
  },
  ["assetId", "title", "description", "kind", "tags", "latestVersion"],
)

const packageInfo = object(
  {
    packageId: string,
    version: string,
    platform: string,
    arch: string,
    sizeBytes: integer,
    sha256: string,
  },
  ["packageId", "version", "platform", "arch", "sizeBytes", "sha256"],
)

const version = object(
  {
    version: string,
    packages: { type: "array", items: packageInfo },
  },
  ["version", "packages"],
)

const installation = object(
  {
    installationId: string,
    assetId: string,
    runtimeSkillId: string,
    title: string,
    version: string,
    sha256: string,
    enabled: boolean,
    pinnedVersion: nullableString,
    installedAt: string,
    status: string,
  },
  [
    "installationId",
    "assetId",
    "runtimeSkillId",
    "title",
    "version",
    "sha256",
    "enabled",
    "pinnedVersion",
    "installedAt",
    "status",
  ],
)

const operation = object(
  {
    operationId: string,
    assetId: string,
    title: string,
    version: string,
    kind: string,
    state: string,
    stage: string,
    progress: integer,
    message: nullableString,
    error: nullableString,
    createdAt: string,
    updatedAt: string,
  },
  [
    "operationId",
    "assetId",
    "title",
    "version",
    "kind",
    "state",
    "stage",
    "progress",
    "message",
    "error",
    "createdAt",
    "updatedAt",
  ],
)

export const SkillStoreRPC = Rpc.define({
  id: "skill-store",
  methods: {
    catalogSearch: {
      input: object({ query: string, cursor: string, limit: integer }),
      output: object(
        {
          configured: boolean,
          items: { type: "array", items: asset },
          nextCursor: nullableString,
        },
        ["configured", "items", "nextCursor"],
      ),
    },
    catalogDetail: {
      input: object({ assetId: string }, ["assetId"]),
      output: object(
        {
          asset,
          versions: { type: "array", items: version },
        },
        ["asset", "versions"],
      ),
    },
    installationList: {
      input: object({}),
      output: object({ items: { type: "array", items: installation } }, ["items"]),
    },
    operationList: {
      input: object({}),
      output: object({ items: { type: "array", items: operation } }, ["items"]),
    },
    installStart: {
      input: object(
        { assetId: string, version: string, idempotencyKey: string },
        ["assetId", "idempotencyKey"],
      ),
      output: object({ operationId: string, state: string }, ["operationId", "state"]),
    },
    operationGet: {
      input: object({ operationId: string }, ["operationId"]),
      output: object({ operation: { anyOf: [operation, { type: "null" }] } }, ["operation"]),
    },
    operationCancel: {
      input: object({ operationId: string }, ["operationId"]),
      output: object({ cancelled: boolean }, ["cancelled"]),
    },
    installationSetEnabled: {
      input: object({ installationId: string, enabled: boolean }, ["installationId", "enabled"]),
      output: object({ item: installation }, ["item"]),
    },
    installationPin: {
      input: object({ installationId: string, version: nullableString }, ["installationId", "version"]),
      output: object({ item: installation }, ["item"]),
    },
    installationUninstall: {
      input: object({ installationId: string }, ["installationId"]),
      output: object({ removed: boolean }, ["removed"]),
    },
    updateCheck: {
      input: object({}),
      output: object(
        {
          updates: {
            type: "array",
            items: object(
              {
                installationId: string,
                assetId: string,
                currentVersion: string,
                latestVersion: string,
              },
              ["installationId", "assetId", "currentVersion", "latestVersion"],
            ),
          },
        },
        ["updates"],
      ),
    },
  },
  events: {
    operationProgress: { schema: operation },
    installationChanged: { schema: object({ installationId: string, action: string }, ["installationId", "action"]) },
  },
})

export type AssetSummary = {
  assetId: string
  title: string
  description: string
  kind: string
  tags: string[]
  latestVersion: string | null
}

export type PackageInfo = {
  packageId: string
  version: string
  platform: string
  arch: string
  sizeBytes: number
  sha256: string
}

export type AssetVersion = { version: string; packages: PackageInfo[] }
export type AssetDetail = { asset: AssetSummary; versions: AssetVersion[] }

export type Installation = {
  installationId: string
  assetId: string
  runtimeSkillId: string
  title: string
  version: string
  sha256: string
  enabled: boolean
  pinnedVersion: string | null
  installedAt: string
  status: "installed" | "broken" | "cleanup_pending"
}

export type Operation = {
  operationId: string
  idempotencyKey: string | null
  assetId: string
  title: string
  version: string
  kind: "install" | "update" | "uninstall"
  state: "queued" | "running" | "installed" | "failed" | "cancelled" | "interrupted"
  stage: string
  progress: number
  message: string | null
  error: string | null
  createdAt: string
  updatedAt: string
}
