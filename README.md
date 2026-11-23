# OpenCode Web × Skill Store

将现有 Go Skill Store 原生集成到 OpenCode Web。目标是在 OpenCode 的 Settings → Extensions → Skills 中完成目录发现、详情查看、安装、启停、更新和卸载；所有 Store 凭据、包下载、ZIP 校验和 Runtime 注册都在 OpenCode Server 侧执行。

> 当前实现基线：OpenCode Fork 的 skill-store-ui 分支 + 本仓库 skill-store-mvp 分支。此仓库目前不包含 Go Store 服务本身；Store HTTP 路由由可配置 Adapter 对接，真实 Router/OpenAPI 必须在本地部署时核验。

## 仓库内容

| 路径 | 职责 |
|---|---|
| packages/opencode-skill-store-plugin/ | OpenCode Server Plugin：Store Client、Typed RPC、安装器、ZIP 安全解包、Skill Runtime 注册 |
| docs/architecture.md | 完整架构与技术决策 |
| docs/architecture.html | 可视化技术报告；PDF 由 GitHub Actions 从此文件生成 |
| docs/implementation-guide.md | 本地部署、配置、启动、验收教程 |
| docs/api-contract.md | Go Store HTTP API 与 OpenCode RPC 契约 |
| docs/testing.md | 单元、集成、E2E、故障注入测试矩阵 |
| docs/pi-agent-prompt.md | 交给 Pi Agent 的部署与迭代 Prompt |
| docs/source-audit.md | OpenCode Fork 源码审计与差异记录 |
| docs/code-map.md | 完整 code category 与模块职责 |
| docs/security-and-rbac.md | 多租户与跨部门权限边界、生产上线门槛 |
| docs/verification-2026-11-23.md | 已执行的 CI 命令和测试结果 |

## 两个仓库

- OpenCode Fork：<https://github.com/1998x-stack/opencode>
- 本集成仓库：<https://github.com/1998x-stack/opencode-skill-store>

## 快速开始

1. 按本地部署教程检出两个分支并安装依赖。
2. 在 OpenCode Server 进程环境中配置 SKILL_STORE_BASE_URL 与 SKILL_STORE_API_KEY。
3. 在 opencode.jsonc 加载本地 opencode-skill-store-plugin。
4. 启动 OpenCode Server 与 Web，打开 Settings → Extensions → Skills → Discover。
5. 安装测试 Skill，在 Session 输入 @ss-<asset-slug>-<hash>，确认 Agent 加载了正确的 SKILL.md 和 supporting files。

## 重要边界

- OpenCode Skill Registry 是 Location-scoped；本插件按 `directory + workspaceID` 隔离安装目录与安装记录。Host 的 `ctx.storage` 只按 plugin ID namespace，因此安装记录和操作记录还必须显式使用 `location:v1:<hash>:` key prefix。
- 浏览器不直接访问 Go Store，不接触 API Key，也不下载 ZIP。
- SHA-256 校验只证明下载字节与可信 Store metadata 一致；发布者身份认证需要后续增加签名验证。
- ZIP 安装不执行脚本。脚本只有在 Agent 后续调用工具时才可能运行，并继续受 OpenCode 权限规则约束。
- 当前 Store 路由是候选默认值，不是已核验的 Go Store 实现事实。请先对照实际 Go Router/OpenAPI。
- 当前不具备 per-user / per-department 授权，不能在跨部门共享生产环境直接启用；见 docs/security-and-rbac.md。

## 开发状态

- [x] Server Plugin / RPC / Installer 第一版代码结构
- [x] OpenCode Web 原生 Skills Store UI 第一版
- [x] 安全解包路径校验与 frontmatter 单元测试
- [x] 部署教程、API 契约、测试计划和 Pi Agent Prompt
- [ ] 对接真实 Go Store Router/OpenAPI
- [x] GitHub Actions：Server Plugin TypeScript typecheck；最新 Location-isolation 修复 CI 为 55/55 测试通过（见 verification record）
- [x] GitHub Actions：OpenCode Web TypeScript typecheck；2876/2876 现有 App 单元测试通过
- [x] 生成并提交 docs/architecture.pdf（HTML 源码也已提交）
- [ ] 本地真实 Go Store / 浏览器 Playwright E2E / LLM Agent 实际调用验收
- [ ] 多用户、多部门鉴权委托与权限隔离的生产验证

测试状态以目标机器和 CI 实际执行结果为准；不能把尚未运行的测试标记为通过。
