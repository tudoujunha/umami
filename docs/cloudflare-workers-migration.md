# umami → Cloudflare Workers 迁移 Spec（OpenNext）

```yaml
status: 已搁置 shelved（评估完成、技术可行，但决定不迁移）— 2026-06-21
date: 2026-06-20（评估）/ 2026-06-21（搁置决策）
owner: tudoujun
repo: /Users/tudoujun/projects/saas_01/umami  (fork tudoujunha/umami, branch master)
app: umami 3.1.0 · Next.js 16.2.4 · React 19 · Prisma 7 (@prisma/adapter-pg + pg 8.20)
current: Vercel + Supabase Postgres
target: Cloudflare Workers via @opennextjs/cloudflare，数据库继续 Supabase
```

> 本文是「讨论 → 执行」分离的沉淀件。设计已收敛，执行另起一轮、交全新上下文，按本文推进。

## 决策（2026-06-21）：搁置迁移，继续留在 Vercel + Supabase

**结论：不迁移。** 技术上已验证可行（见 §0，umami 在 workerd 上能真正跑起来，Prisma 7 `runtime=cloudflare` 也绕过了 wasm 崩溃），但 OpenNext 产物 **gzip ~9.7 MiB**：免费档（3 MiB）装不下、强制 Workers 付费档，且余量薄，还要长期维护一份对上游的 CF 补丁。对一个自用分析工具，代价 > 收益。

- 迁移最初动机是**降成本**；后来发现更省事的路径：**Vercel 侧降套餐 / 转移到其它账号**即可控成本，Neon（其它项目）同理。本项目迁移需求因此消失。
- 唯一后续课题：**降低数据库存储**（独立于本迁移）。umami 存储大头通常是 `website_event`（每条埋点）和会话回放 `rrweb` 录制；方向是数据保留期裁剪 + 关闭/精简回放。
- `cloudflare` 分支（2 个提交）与下方技术记录**保留作存档**——若将来 umami 体积下降或策略改变，可据此快速重启。

下方为当时的技术验证记录，仅作参考。

## 0. 实测验证结果（2026-06-20，本地 workerd 通过）

已在分支 `cloudflare` 完成适配并用真 workerd 本地验证：build ✅、SSR(`/login` 200)✅、pg 连 Supabase ✅、**Prisma 7.6 query compiler 在 workerd 运行 ✅（登录查库返回 401，无 #28657 的 wasm 崩溃）**、tracker 脚本(`/script.js` 200)✅、日志 0 条致命错误。

相对原始设计的关键更新：

- **Prisma generator 加 `runtime = "cloudflare"`**：生成边缘 wasm client（`import("...wasm?module")` 静态导入），既绕过 workerd「运行时编译 wasm 被禁」的崩溃（[prisma#28657](https://github.com/prisma/prisma/issues/28657)），又把多方言 ~87MB 砍到单 postgresql ~8.1MB。
- **`serverExternalPackages` 只放 `pg` / `pg-cloudflare` / `@prisma/adapter-pg`**，不放 `@prisma/client`（外置会把全方言 runtime 整包拷进来）。
- **OpenNext `buildCommand` 改跑 `build:cf-app`**：`prisma generate`(不跑 umami 的 `build-prisma-client` esbuild 预打包——它不认 `.wasm`) + tracker/recorder + `next build`；跳过 `check-db`（会自动迁移生产库）和 `build-geo`（下 63MB mmdb）。
- DB 沿用现有 Supabase 双串：运行时 `DATABASE_URL`(6543 池) + 迁移 `DIRECT_DATABASE_URL`(5432)。

实测数字：

- worker 上传 **gzip 9.47 MiB** → 免费档(3MiB)出局，**必须付费档**(10MiB，余量仅 ~0.5MiB，后续建议 minify 瘦身)。
- 冷启动首查 ~5.5s（Prisma/wasm 初始化 + 连池），热查询 ~17ms。

仍未做：`/api/send` 写入路径实测；云端部署（见 §0.1）。

## 0.1 Cloudflare Workers Builds（git 集成 CI）部署配置

用 Workers Builds（连 git 仓库自动构建）部署时，**控制台 → Worker → Settings → Build** 必须改成下表。默认值会跑 umami 的 `pnpm build`：① 产出的是 `.next` 不是 worker，② 还会因 `runtime=cloudflare` 让 `build-prisma-client` 撞 `.wasm` 而构建失败。Workers Builds **不读** wrangler 配置里的 custom build，只认控制台设置。

| 字段 | 值 |
|---|---|
| Build command | `pnpm run build:cf` |
| Deploy command | `npx opennextjs-cloudflare deploy` |
| Non-production branch deploy command | `npx opennextjs-cloudflare upload` |
| Root directory | 仓库根（默认 `/`） |

**环境变量分两处设**（Build variables 只在构建期可用、运行时拿不到）：

- **Settings → Build → Build variables**：`DATABASE_URL`（构建期 `prisma generate` / `next build` 解析用，不连库）；可选 `TRACKER_SCRIPT_NAME`。
- **Settings → Variables & Secrets（运行时）**：把 `DATABASE_URL`（6543 池串）设为 **Secret**（worker 运行时连库；不设则 build 过、一访问即 500）。`APP_SECRET` 不用设（从 DATABASE_URL 派生）。

**其它**：

- Worker 必须在 **付费档**（9.47 MiB > 免费档 3 MiB 上限）。
- **Production branch** 设为正在 push 的分支（如 `cloudflare`），否则只走 upload 不切流。
- Workers Builds 用项目账号凭据，**不需要 `wrangler login`**。

> 排障记录：若云端构建报 `No loader is configured for ".wasm" ... build-prisma-client exited with 1`，说明 Build command 还是默认的 `pnpm build`（在跑 umami 自带的 esbuild 预打包），改成 `pnpm run build:cf` 即可。

## 1. 目标与决策（已锁定）

- **运行时**：从 Vercel 迁到 **Cloudflare Workers**，构建链用 **@opennextjs/cloudflare**（OpenNext）。动机：与 fleet 内其他项目（seedream / shortra）统一到 CF Workers。
- **数据库**：**继续 Supabase Postgres，不引入 Hyperdrive，不迁 D1**（D1 是 Postgres 重 raw SQL，工作量另算，明确排除在本阶段外）。
- **计费档**：默认先按**免费档**试，但要把「量 worker gzip 体积」当成第一步（见 §7）。免费/付费的分界**不是流量**，是包体积(3MB)和单请求 CPU(10ms)，需实测后定。
- **可选服务**：ClickHouse / Kafka / Redis 保持关闭（纯 Postgres 模式），不进本阶段。

## 2. 可行性结论（已对抗式复核）

**可行，无真正硬阻塞。** 三个曾被怀疑的「硬阻塞」复核后全部降级：

| 曾被当作硬阻塞 | 复核后真相 | 处置 |
|---|---|---|
| `pg` 走原生 TCP，workerd 不支持 | **假**。Workers 自 2025-01 原生支持 `node:net`；`pg@8.20` 的 `isCloudflareRuntime()` 会自动切到 `pg-cloudflare` 的 `CloudflareSocket`。仓库已含 `pg-cloudflare@1.3.0`。 | DB 驱动**零改动** |
| Next 16.2.4 不被 OpenNext 支持 | **半对**。OpenNext 支持 Next 16，但 16.x 下限是 **16.2.6**，16.2.4 卡在空档。 | **升** Next → ≥16.2.6 |
| MaxMind `.mmdb`(~63MB) 运行时读文件 | **文件方案确不可行**，但 `detect.ts:23-28` 在读文件前先读 `cf-ipcountry` 等 CF 头，挂在 CF 后根本走不到文件。 | 跳过 mmdb + 用 CF geo 头 |

umami 对 OpenNext 友好的关键事实：**纯 Node runtime、零 `export const runtime='edge'`、无 `src/middleware.ts`**（仅 `next.config.ts` 的 rewrites/headers，OpenNext 支持）。

## 3. 真实失败基线（2026-06-20 部署日志）

在「代码未改动」下用 Cloudflare Workers Builds 部署失败。日志（`tmp/umami.production.6663a1f7-...build.log`）解读：

1. `pnpm install` + `pnpm run build`（umami 原生全量构建）**全部成功**：prisma generate、check-db 连上 Supabase（`aws-0-us-east-1.pooler.supabase.com:5432`）、build-geo 下载了 mmdb、`next build --turbo` 49s 编过、全部 117 路由为动态 `ƒ`。
2. **deploy 阶段失败**：deploy 命令是 `npx wrangler deploy`。wrangler 检测到 Next.js 但项目**没有 OpenNext 配置**，于是触发自动引导 `@opennextjs/cloudflare migrate`，其内部执行 `pnpm add --force @opennextjs/cloudflare@latest` →
3. **报错 `ERR_PNPM_ADDING_TO_ROOT`**：因 `pnpm-workspace.yaml` 的 `packages: ['**']` 把根标记为 workspace，根目录加依赖必须 `-w`，wrangler 的自动安装没带 `-w` → 失败 → `Failed: error occurred while running deploy command`。

**根因**：不是运行时不兼容，是**项目根本没做 OpenNext 适配**就 `wrangler deploy`，wrangler 的自动引导又撞上 pnpm workspace。即便绕过这个安装错误，构建产物仍是 `.next`/standalone 而非 `.open-next/worker.js`，也无法部署成 Worker。**「零改动部署」本就不可能成立——这次失败正是本 Spec §4 工作项的体现。**

附带发现（需在 CF 构建里改掉）：
- 构建跑了 `build-geo`（下了 63MB mmdb，会污染 bundle）→ 应 `SKIP_BUILD_GEO=1`。
- 构建跑了 `check-db` → 它会 `prisma migrate deploy` 自动改**生产** DB schema。自动迁移生产是 footgun，迁移应受控、独立执行（见 §9）→ 部署构建里 `SKIP_DB_CHECK=1 SKIP_DB_MIGRATION=1`。

## 4. 需要改的东西（清单）

按工作量：

1. **升 Next** 16.2.4 → ≥16.2.6（package.json）。trivial。
2. **装 OpenNext 工具链**（用 `-w` 避开 workspace 报错）：
   ```bash
   pnpm add -w -D @opennextjs/cloudflare wrangler
   ```
3. **新增 `open-next.config.ts`**（最小配置即可，增量缓存按需后加）。
4. **手写 `wrangler.jsonc`**（**绝不照抄 PR #4077**，它硬编码了别人账号的 account_id/Hyperdrive id）：
   ```jsonc
   {
     "$schema": "node_modules/wrangler/config-schema.json",
     "name": "umami",
     "main": ".open-next/worker.js",
     "compatibility_date": "2026-06-20",
     "compatibility_flags": ["nodejs_compat"],
     "assets": { "directory": ".open-next/assets", "binding": "ASSETS" },
     "observability": { "enabled": true }
   }
   ```
5. **`next.config.ts`**：加 `initOpenNextCloudflareForDev()`（本地 `next dev` 取 binding）。`output:'standalone'` 可留可删（OpenNext 自有构建，忽略它）。
6. **新增 CF 专用构建/部署脚本**（见 §6）。
7. **构建环境变量**：`SKIP_BUILD_GEO=1`、`SKIP_DB_CHECK=1`、`SKIP_DB_MIGRATION=1`。
8. **Geo**：CF 后台开启 "Add visitor location headers" managed transform；可选给 `detect.ts` 的 maxmind fallback 加防护，确保 Workers 上永不调用 `maxmind.open`。
9. **Worker secrets**（Human Gate）：`DATABASE_URL`(Supavisor 6543)、`APP_SECRET`，以及 umami 其他必需 env。

## 5. 数据库连接设计（沿用你现有 Supabase 配置）

你已做的 commit `5f8f490b`（`prisma.config.ts: DIRECT_DATABASE_URL || DATABASE_URL`）正是本方案的基础：

- **运行时**（`src/lib/prisma.ts:365,371` 读 `process.env.DATABASE_URL`）→ Supavisor 连接池串（6543，transaction 模式）。
- **迁移 / Prisma CLI**（`prisma.config.ts`）→ `DIRECT_DATABASE_URL` 直连串（5432，session 模式）。

在 Workers 上：把这两个串设为对应位置的 secret/CI 变量即可，`prisma.ts` **零改动**（pg.Pool 懒连接，顶层无 I/O；pg 8.20 自动用 CloudflareSocket）。

- 复核确认：`@prisma/adapter-pg@7.6` 默认用**未命名**扩展协议语句，**不触发** Supavisor transaction 模式下的 prepared-statement 报错（umami 未设 `statementNameGenerator`）。
- 小坑：`prisma.ts:265` 仅在连接串带非默认 `schema` 时发 `SET search_path`，transaction pooler 下可能跨连接失效。Supabase 默认 `public`、umami 不设 schema → 对本项目无影响。
- **不用 Hyperdrive**：边缘连接池只在高并发写时才值；本项目流量极小（<100 万/月）用不上，且 Hyperdrive 免费档每天 10 万 query 反而会被分析写入撑爆。

## 6. 构建 & 部署流程（修正后的命令）

失败的根因是命令错了。正确流程：

- **OpenNext 的构建**(`opennextjs-cloudflare build`)内部会自己跑 `next build`，但 umami 还需先 `prisma generate` + 打 tracker/recorder。建议加脚本（package.json，注意 workspace 下脚本仍在根）：
  ```jsonc
  "build:cf":  "cross-env SKIP_BUILD_GEO=1 SKIP_DB_CHECK=1 SKIP_DB_MIGRATION=1 npm-run-all build-db build-tracker build-recorder && opennextjs-cloudflare build",
  "deploy:cf": "opennextjs-cloudflare deploy",
  "preview:cf":"opennextjs-cloudflare preview"
  ```
- **首次部署建议走本地**（迭代快、能先量包体积），跑通后再接 CF Workers Builds CI。
- 若用 **CF Workers Builds**：把 dashboard 的 Build command 改成 `pnpm run build:cf`、Deploy command 改成 `npx opennextjs-cloudflare deploy`（**不要**用默认的 `wrangler deploy`）。

## 7. 第一步必做：量 worker 体积（定免费/付费档）

`pnpm run build:cf` 后看 `.open-next/worker.js`（gzip）体积：
- **≤ 3MB**：免费档可部署 → 按你说的走免费档。
- **> 3MB**：免费档**部署不了**，只能 Workers 付费档（$5/月，10MB）。一个参照：Next 16 的 OpenNext 服务端产物在加 umami 这类依赖前已约 3.4MB gzip，所以**大概率会超**，但以实测为准。
- 同时关注单请求 CPU：仪表盘聚合渲染可能破免费档 10ms。

## 8. 必测路径（部署后）

登录/session · `/api/send` 写入 · 仪表盘聚合查询 · `/script.js` 下发 · geo 是否从 CF 头取到 country/city · realtime（`/api/realtime`）· export。

## 9. 迁移（migrations）处理

- 从 **CI/本地**对 `DIRECT_DATABASE_URL`(5432) 跑 `prisma migrate deploy`，作为**独立、受控**步骤，**不**放进部署 Worker 的构建里（避免每次 deploy 自动改生产 schema）。
- 改 schema / 跑迁移属 Human Gate。

## 10. 两个上游 PR（仅参考，勿 merge）

- #4077 与 #3475 **均 closed & unmerged**，上游无 Workers 分支。
- #4077 硬编码别人账号 account_id/Hyperdrive id、default 与 staging 共用同一 DB、且**无条件** import `CloudflareSocket` 会**搞坏本地/Docker**。
- 你有 pg 8.20 自动检测，**两 PR 的 socket 改法都不需要**。

## 11. 长期成本（如实记一笔）

umami 是 fleet 里唯一**官方就是 Docker 容器**的应用。走 OpenNext+Workers 的长期代价：**每次升级 umami 都要重打一遍 CF 补丁**，上游永不维护此路。接受此成本的前提是「整个 fleet 统一在 CF Workers」这一战略目标——已确认。

## 12. Human Gates（必须先问）

- 创建/绑定 Cloudflare Worker 项目。
- 设置/修改 Worker secrets、`.env`、CI/CD 构建与部署命令。
- 跑生产 DB 迁移。
- 正式部署 / 生产切流。

## 13. 明确不做（本阶段）

D1 迁移 · 启用 ClickHouse/Kafka/Redis · Hyperdrive · 改动业务逻辑。
