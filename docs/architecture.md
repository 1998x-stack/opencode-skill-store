# OpenCode Web × Skill Store — 核心技术架构

版本：0.2.0  
审计基准：2026-11-23  
实施分支：1998x-stack/opencode-skill-store:skill-store-mvp 与 1998x-stack/opencode:skill-store-ui

## 1. 目标与核心决策

将 Go Skill Store 接入 OpenCode Web 原生 Skills 管理体验。用户在现有 Settings → Extensions → Skills 页面中浏览目录、查看版本、安装、更新、启停和卸载；安装后的 Skill 由 OpenCode 原生 Skill Runtime 管理，并能通过 @skill-id 被 Agent 实际调用。

核心架构：

~~~mermaid
flowchart LR
  WEB["OpenCode Web<br/>Settings / Extensions / Skills"]
  RPC["Typed RPC<br/>SkillStoreRPC"]
  PLUGIN["OpenCode Server Plugin<br/>Store Adapter + Installer"]
  STORE["Go Skill Store<br/>Catalog / Version / ZIP API"]
  FS["Location-scoped disk<br/>staging / versions / active.json"]
  RUNTIME["OpenCode Skill Runtime<br/>ctx.skill.transform / reload"]
  WEB --> RPC --> PLUGIN
  PLUGIN --> STORE
  PLUGIN --> FS
  FS --> RUNTIME
  RUNTIME --> WEB
~~~

- UI 复用现有 Skills subtab，不新建外部站点或 iframe。
- 浏览器只调用 OpenCode Server 的 Typed RPC。
- Store API Key、ZIP 下载、SHA 校验、解包和文件系统写入只发生在 Server。
- 插件只管理自己登记的 ss- Runtime IDs，不覆盖普通 Skill。
- 安装、更新、启停、卸载都必须可恢复；失败不能破坏旧活动版本。

## 2. 基于实际 Fork 的 Web 接入点

上一版方案曾建议新增 /skills 路由；本次源码审计发现当前 Fork 已有 Skills subtab，因此更小、更原生的实现是扩展 packages/app/src/settings/providers/extensions.tsx。

### 2.1 具体修改

| 文件 | 修改 |
|---|---|
| packages/app/src/settings/providers/skill-store-rpc.ts | 定义与 Server Plugin 同步的 JSON Schema RPC contract。 |
| packages/app/src/settings/providers/skill-store.tsx | Discover / Installed 视图、搜索、详情、安装、更新、启停、卸载、操作进度。 |
| packages/app/src/settings/providers/extensions.tsx | 在现有 Skills 列表后嵌入 SettingsSkillStore。 |
| packages/app/src/runtime/i18n/en.ts | 添加 UI 文案键。 |

### 2.2 当前 Server 的调用方式

useServerSDK() 来自 packages/app/src/runtime/server/client.tsx。其 api 是当前 Server 的 OpenCode Client，Server endpoint 重连时可能被替换。不要长期缓存旧 client；每次 RPC 操作从当前 serverSdk.api 创建 RPC subclient：

~~~ts
const rpc = () => serverSdk.api.rpc(SkillStoreRPC)
const result = await rpc().catalogSearch({ query, limit: 24 })
~~~

SettingsExtensions 已在 SettingsServerDataScope 内运行，所以 Skills Store 操作天然绑定所选 Server。RPC events 会带 event.location；前端按当前目录过滤事件，避免多个 Location 的进度混入同一页面。

### 2.3 为什么不是 GUI Plugin

当前目标是 OpenCode Web，不是 Desktop GUI。Server Plugin 的 RPC 可以被 Web Client 直接调用；因此无需把 GUI Plugin Web 动态加载能力作为 P0 前提。原生页面位于 OpenCode App 源码，插件只提供 Server 能力。

## 3. Server Plugin 与 Go Store

Server Plugin 位于本仓库 packages/opencode-skill-store-plugin/。

模块分层：
- config.ts：插件 options、环境变量、Location 安装根目录。
- store/client.ts：唯一 Go Store HTTP Adapter；负责认证、请求、响应字段归一化。
- contracts.ts：Typed RPC contract 与 DTO。
- installer/manager.ts：后台操作、幂等、并发、持久化、更新、回滚。
- installer/archive.ts：ZIP entry 安全校验与解压。
- runtime/frontmatter.ts：SKILL.md frontmatter 解析。
- index.ts：Plugin lifecycle、RPC 注册和 cleanup。

### 3.1 RPC 数据流

~~~mermaid
sequenceDiagram
  participant UI as OpenCode Web
  participant RPC as Server Plugin RPC
  participant STORE as Go Skill Store
  participant DISK as Location Install Root
  participant SKILL as Skill Runtime
  UI->>RPC: installStart(assetId, version, idempotencyKey)
  RPC-->>UI: operationId + queued
  RPC->>STORE: catalog detail / package metadata
  RPC->>STORE: stream package ZIP
  RPC->>DISK: staging write + SHA-256
  RPC->>DISK: safe extract + manifest
  RPC->>DISK: atomic active.json switch
  RPC->>SKILL: ctx.skill.reload()
  SKILL-->>RPC: ctx.skill.list() contains ss-id
  RPC-->>UI: operationProgress(installed)
~~~

### 3.2 RPC 方法

| Method | 作用 |
|---|---|
| catalogSearch | 搜索 Store Skill Catalog |
| catalogDetail | 读取资产、版本、包信息 |
| installationList | 当前 Location 的已安装记录 |
| operationList / operationGet | 恢复和查询安装操作 |
| installStart | 创建异步安装/更新任务 |
| operationCancel | 取消可取消的任务 |
| installationSetEnabled | 启用/禁用并刷新 Runtime |
| installationPin | 固定版本 |
| installationUninstall | 从 Runtime 移除并清理本插件目录 |
| updateCheck | 比较当前安装版本和 Store latest version |

事件 operationProgress 用于实时 UI；事件是 live-only，不能作为唯一事实来源。刷新页面后，必须调用 operationList / installationList 恢复持久化状态。

## 4. Location 维度与隔离

当前 OpenCode 的 Skill Registry 是 Location-scoped。`ctx.location` 描述插件实例加载的 Location，而不是所有 Session 的位置。Location 身份由 `directory` 与可选 `workspaceID` 共同确定。

重要实现细节：OpenCode Host 的 `ctx.storage` 仅按 plugin ID 建立 namespace，不会自动隔离 Location。因此插件必须显式使用 `location:v1:<location-hash>:` 作为每个 durable key 的前缀；只隔离磁盘目录是不够的。

安装根目录结构：

~~~text
$OPENCODE_SKILL_STORE_DIR/
  <location-hash>/
    skills/
      ss-<asset-slug>-<hash>/
        active.json
        versions/
          1.0.0/
            SKILL.md
            references/
            scripts/
            .store-manifest.json
    staging/
      <operation-id>/
        package.zip
        content/
~~~

- 默认根目录：~/.opencode/skill-store/<location-hash>，hash 输入为 `directory + NUL + workspaceID`。
- `ctx.storage` keys 使用 `location:v1:<location-hash>:` 前缀，例如 `location:v1:<hash>:installations` 与 `location:v1:<hash>:operations`。
- 不把 Store 安装记录写入 Go Store 全局 Catalog。
- 不把一个 Location 的 installed list 返回给另一个 Location。
- 如未来需要真正 Server-global 安装，应设计显式共享作用域、全局锁和跨 Location reload 通知；不能简单移除 location hash。

## 5. Go Store HTTP API 适配

当前 `opencode-skill-store` 仓库是 OpenCode Server Plugin 集成仓库，不包含 Go Store 服务端源码。因此下列是插件默认候选路径，不是已经核验的后端事实：

- GET /v1/asset-store/assets?kind=skill&q=&limit=&cursor=
- GET /v1/asset-store/assets/{asset_id}
- GET /v1/asset-store/packages/{package_id}/content

真实路径可通过环境变量映射：
- SKILL_STORE_ASSETS_PATH
- SKILL_STORE_ASSET_DETAIL_PATH
- SKILL_STORE_PACKAGE_CONTENT_PATH

真实 Go Router/OpenAPI 必须在部署前核验。禁止为了让 Demo 通过而伪造生产 API。

## 6. Package 与 Skill Runtime 契约

ZIP 根目录必须直接包含 SKILL.md，并保留 references/、scripts/、assets/ 等相对路径资源。

~~~text
skill-package.zip
  SKILL.md
  references/
  scripts/
  assets/
  examples/
~~~

SKILL.md 至少应提供可发现的 description；缺少 frontmatter 时可继承 Store asset metadata。Runtime ID 使用稳定的 Store namespace：

ss-<slug(asset_id)>-<sha256(asset_id)[0:8]>

注册通过：
- Skill.ID.make(runtimeId)
- Skill.Name.make(name)
- Skill.Info.fields.path.make(absoluteSkillFile)
- ctx.skill.transform(editor => editor.add(info))
- 外部状态更新后 ctx.skill.reload()

安装后的 supporting files 必须与 SKILL.md 保持同一版本目录；不能只把 Markdown 正文塞入 JSON 存储。

## 7. 安装状态机与原子提交

~~~mermaid
stateDiagram-v2
  [*] --> QUEUED
  QUEUED --> RESOLVING
  RESOLVING --> DOWNLOADING
  DOWNLOADING --> VERIFYING
  VERIFYING --> EXTRACTING
  EXTRACTING --> COMMITTING
  COMMITTING --> REGISTERING
  REGISTERING --> INSTALLED
  DOWNLOADING --> FAILED
  VERIFYING --> FAILED
  EXTRACTING --> FAILED
  COMMITTING --> FAILED
  REGISTERING --> FAILED
  DOWNLOADING --> CANCELLED
  EXTRACTING --> CANCELLED
~~~

关键步骤：
1. 按 asset ID 获取详情与目标版本包信息。
2. 选择匹配 Server process.platform / process.arch 的 package。
3. 下载到 staging，流式计算 SHA-256 和字节数。
4. 比对 Store metadata 中 SHA-256、size。
5. 安全解压至 staging/content。
6. 校验 SKILL.md、frontmatter 和 supporting files。
7. 写入不可变 versions/<version> 目录和 package manifest。
8. 临时写 active.json，原子 rename 切换活动版本。
9. 刷新 Skill Runtime 并确认 ctx.skill.list() 出现目标 ID。
10. 将 operation 标记为 installed，发出事件。

如果 Runtime 注册失败，恢复旧 active.json、旧安装记录并 reload；旧版本目录不得提前删除。相同 asset/version 不允许对应不同 SHA。

## 8. ZIP 与供应链安全

P0 控制：
- 拒绝绝对路径、..、反斜杠绕过、盘符、UNC、NUL、冒号路径段。
- 拒绝 symlink、hardlink 和特殊文件类型。
- 拒绝重复 entry 和大小写冲突。
- 限制压缩包大小、解压总字节数、entry 数、单文件大小和压缩比。
- ZIP 根目录必须有非空 SKILL.md。
- 文件以普通权限写入 staging；安装不保留 setuid/setgid，也不自动执行 scripts。
- SHA-256 与可信 Store metadata 比对。
- 卸载时对目标路径做 installRoot containment check。

SHA-256 不等于发布者身份认证。P1 增加签名 manifest（如 Ed25519），包含 asset_id、version、package_id、sha256、size、publisher_key_id，由管理员配置可信公钥。

参考：https://cheatsheetseries.owasp.org/cheatsheets/Path_Traversal_Prevention_Cheat_Sheet.html

## 9. 并发、幂等和恢复

- idempotencyKey 保证重复提交返回同一个 operation。
- 同一 Location 同一 asset 同时只允许一个 active install/update。
- 每个 asset 使用互斥锁；全局下载并发后续可配置。
- operation 状态写入 Plugin durable storage 的 Location 前缀空间（`location:v1:<hash>:`）；Host 的 plugin-ID namespace 不提供 Location 隔离。
- Server 重启后，queued/running operation 标记 interrupted；清理 staging；从 installation state 和 active pointer reconcile。
- UI 刷新后重新读取 operationList，而不是自动重发安装请求。

## 10. 权限与信任边界

- 浏览器仅发送 asset_id、version、idempotency_key。
- SKILL_STORE_API_KEY 只存在 OpenCode Server 进程环境。
- Store Base URL 由服务端配置，不接受浏览器提交 URL，避免 SSRF。
- 下载只访问配置好的 Store package route；默认禁止重定向。
- Skill 内容属于不可信指令；安装不执行脚本，Agent 后续执行工具仍受 OpenCode permission rules 控制。
- 安装范围是当前 Location，不覆盖用户的全局目录或项目 Skill。
- 日志不记录 API Key、签名 URL、完整 Skill 内容。

## 11. 测试和验收

测试分层见 docs/testing.md。

P0 必须证明：
1. Store API 返回的真实资产可以在 Web Discover 中显示。
2. 安装成功后磁盘存在版本目录和 active.json。
3. SHA 错误、恶意 ZIP、缺失 SKILL.md 均被拒绝。
4. ctx.skill.list() 出现 ss-... ID。
5. Session 中输入 @ss-... 能加载正确正文。
6. Skill 指定读取 references/example.md 时，Agent 能读取同版本 supporting file。
7. 更新失败时旧版本仍然 active、Runtime 仍可用。
8. Server A / Location A 的安装状态不会泄漏给另一个 Server / Location；同一 Server 中相同 directory、不同 workspaceID 也必须隔离 durable state。
9. 刷新页面或重启 Server 后，operation / installation 状态可恢复。

## 12. 参考资料

- OpenCode Server Plugin：https://opencode.ai/docs/build/plugins/server/
- OpenCode Plugin RPC：https://opencode.ai/docs/build/plugins/rpc/
- OpenCode Skills：https://opencode.ai/docs/skills/
- OWASP Path Traversal Prevention：https://cheatsheetseries.owasp.org/cheatsheets/Path_Traversal_Prevention_Cheat_Sheet.html
- Go filepath.IsLocal：https://pkg.go.dev/path/filepath#IsLocal
