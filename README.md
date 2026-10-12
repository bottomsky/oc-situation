# 海上多元情报分析系统

AIS 与情报融合专题系统，提供数据采集、历史存储、独立专题计算、结论证据链与海图展示。Bun 管理 TypeScript 单仓库，Node.js 24 运行后台服务；Nuxt 4、Nuxt UI 4 与 MapLibre 提供中文地图、专题事件和采集治理界面。

专题协议、服务边界、数据流与扩展方法见[融合专题架构](docs/fusion-architecture.md)。

Pi 与 DeepSeek 的一次性区域研判任务、模型外发边界和启用方式见[区域研判智能体](docs/agent-analysis.md)。

情报录入、审核、对象关联、影响认定和单条/批量海图标绘见[情报管理与海图标绘](docs/intelligence-chart.md)。真实公开来源与联网验证见[公开海事情报采集](docs/intelligence-ingestion.md)，本地开源参考清单见[开源情报参考仓库](docs/osint-reference.md)。

## 快速启动

准备 Node.js 24、Bun 1.3.12、Docker Compose。

```powershell
bun --no-env-file install --frozen-lockfile
bun --no-env-file run infra:up postgres clickhouse nats s3
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) '.data/playwright'
node node_modules/playwright/cli.js install chromium
bun --no-env-file run demo
```

访问[本地 Web](http://127.0.0.1:13001)。随机管理员、操作员和只读账号保存在 `.data/demo-admin.json`，该文件被 Git 排除。演示运行受控网页、Crawlee、RAW 清洗、独立 PostgreSQL/ClickHouse 写入及 S3 归档，生成 4 艘样例船和轨迹；记录带“样例数据”标记。

Linux/macOS 安装浏览器前执行 `export PLAYWRIGHT_BROWSERS_PATH="$PWD/.data/playwright"`。配置通过部署环境或明确的 Node `--env-file` 参数注入；新服务不主动读取旧原型 `.env.local`。`.env.example` 与本地 Compose 端口、字段一致。

## 工程与命令

| 路径                                                  | 职责                               |
| ----------------------------------------------------- | ---------------------------------- |
| `apps/web`、`apps/api`                                | Web、登录权限、查询和控制面        |
| `apps/collector`、`apps/crawler`                      | 官方接口/流、受控网页采集          |
| `apps/processor`、`apps/writer`、`apps/archiver`      | 清洗、独立双写入、原始归档         |
| `apps/intelligence`、`apps/topics`                    | 情报接入、独立专题计算与可追溯结果 |
| `packages/contracts`、`packages/domain`               | 运行时 Schema、清洗和来源选择      |
| `packages/source-adapters`、`packages/infrastructure` | 协议适配、数据库、队列和对象存储   |
| `infra`、`tests`、`scripts`                           | 部署、样例、验证和操作入口         |

```powershell
bun --no-env-file run migrate
# 注入 ADMIN_USERNAME 和 >=12 字符的 ADMIN_PASSWORD 后执行
bun --no-env-file run seed
bun --no-env-file run lint
bun --no-env-file run format:check
bun --no-env-file run typecheck
bun --no-env-file run test
bun --no-env-file run build
bun --no-env-file run test:integration
bun --no-env-file run test:e2e
# 复用 demo 数据检查实际 Node 编译产物
bun --no-env-file run build:smoke
bun --no-env-file run api:generate
```

集成测试使用真实本地数据库、NATS 和 S3；执行时暂停 demo 后台进程，防止故障注入影响运行来源。浏览器测试自动启动或复用 API 与 Web，从本地凭证文件取得账号。`demo --backend-only` 单独启动后台，另开终端执行 `bun --no-env-file run dev:web`。

后台构建输出 `apps/<应用>/dist/main.mjs`，第三方依赖保持外部引用，共享工作区编入产物，SQL 随产物复制。生产运行 `node apps/api/dist/main.mjs` 等入口，writer 通过 `WRITER_TARGET=postgres|clickhouse` 选择目标。Nuxt 入口为 `node apps/web/.output/server/index.mjs`。类型检查与实际构建分别执行。

## 功能与验收

实现船位地图、搜索与详情、历史轨迹及播放、来源配置、任务/运行管理、清洗质量、隔离记录、受控重放和用户角色管理。持久队列提供发布确认、持久写入确认、背压和重试；原始归档保留 90 天，历史位置查询限制最近 30 天。

详见[实施状态](docs/implementation-status.md)、[架构与数据规则](docs/architecture.md)、[本地操作](docs/development.md)、[生产运行说明](infra/OPERATIONS.md)。MarineTraffic 与 AISStream 协议适配已实现，正式账号、覆盖范围、卫星权限和断线补数需完成真实联调。

## 性能与部署

先启动 `demo --backend-only`，再运行以下命令。合成 AIS 经真实 RAW→清洗→双写入→归档，不向外部站点发送压力请求。

```powershell
bun --no-env-file run bench
# 约 75 分钟：1000/s 60 分钟、3000/s 5 分钟、1000/s 10 分钟恢复
bun --no-env-file run bench --full
```

报告保存在 `docs/reports/`，记录响应数与展开观测数、20 个查询用户、吞吐、积压恢复、查询延迟、归档和容量。短冒烟证明链路可运行；25.9 亿条的 30 天历史规模、生产承载和备份恢复需要专项验收。

生产镜像使用 `infra/Dockerfile`，模板为 `infra/compose.production.yaml`。注入数据库/NATS/外部 S3/管理员及 HTTPS 域名，指定已构建镜像 `AIS_IMAGE`；Caddy 提供 HTTPS，数据库与指标在内部网络。单机部署存在主机故障停服及未归档消息损失风险。
