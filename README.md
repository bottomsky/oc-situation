# 海上多元情报分析系统

AIS 与情报融合专题系统，提供数据采集、历史存储、独立专题计算、结论证据链与海图展示。Bun 管理 TypeScript 单仓库，Node.js 24 运行后台服务；Nuxt 4、Nuxt UI 4 与 MapLibre 提供中文地图、专题事件和采集治理界面。

## 文档入口

后续开发按下表顺序阅读。当前系统支持内置技能与账号私有动态技能；SDK 抽库、远程 MCP 和全站业务控制按路线图继续推进。

| 阅读顺序 | 文档                                                                              | 用途                                 |
| -------- | --------------------------------------------------------------------------------- | ------------------------------------ |
| 系统现状 | [当前架构](docs/architecture.md)、[能力与验证状态](docs/implementation-status.md) | 确认已有服务、数据流和能力边界       |
| SDK 目标 | [Agent SDK 架构设计](docs/agent-sdk-architecture.md)                              | 理解四包结构、宿主适配与扩展协议     |
| 开发路线 | [Agent SDK 开发路线图](docs/agent-sdk-roadmap.md)                                 | 按依赖领取任务，执行测试、迁移和回滚 |
| 本地开发 | [开发说明](docs/development.md)                                                   | 配置环境、启动服务、执行验证         |
| 部署运维 | [Docker 与 Kubernetes 运维](infra/OPERATIONS.md)                                  | 配置密钥、初始化、上线和恢复         |

[产品资料](docs/product/README.md)集中保存正式方案、Word 和流程图；[报告索引](docs/reports/README.md)保留历史验收、成功与失败性能数据及本轮清理依据。

专题协议、服务边界、数据流与扩展方法见[融合专题架构](docs/fusion-architecture.md)。

Pi 与 DeepSeek 的一次性区域研判任务、模型外发边界和启用方式见[区域研判智能体](docs/agent-analysis.md)。

Agent 使用内置技能目录与个人版本目录组织任务选择与工具执行，配置见[智能体技能](docs/agent-skills.md)，自主创建、即时加载、版本绑定和恢复协议见[动态个人技能](docs/agent-dynamic-skills.md)。海图与 Agent 共用历史 AIS 去重船数热力查询，支持固定区域、时间和来源筛选；统计口径、查询限制和容量基准见[AIS 历史热力图](docs/ais-heatmap.md)。

历史航线支持按 AIS 船型、具体型号或船舶信息查询并叠加多船轨迹，提供人工生成、Agent 绘制与关闭；查询口径、档案字段和资源限制见[船舶历史航线](docs/vessel-tracks.md)。

Agent 可用三连光圈和持续水波高亮任务船舶，并独立控制坐标聚焦、区域入镜与缩放；人工清除、船位刷新和动态技能接入见[船舶高亮与镜头技能](docs/agent-map-skills.md)。

会话对象继承、账号长期记忆、候选确认和个人记忆管理见[智能体会话与账号记忆](docs/agent-memory.md)。

情报录入、审核、对象关联、影响认定和单条/批量海图标绘见[情报管理与海图标绘](docs/intelligence-chart.md)。定时入库、AI 本地工具与版本引用见[外部情报入库与 AI 检索](docs/intelligence-search.md)。真实公开来源与联网验证见[公开海事情报采集](docs/intelligence-ingestion.md)，本地开源参考清单见[开源情报参考仓库](docs/osint-reference.md)。

## 快速启动

准备 Node.js 24、Bun 1.3.12、Docker Compose。

Windows 可直接执行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start.ps1`；只检查环境使用 `-CheckOnly`。脚本以 UTF-8 处理原生命令输出，文件需保留 UTF-8 BOM 以兼容 Windows PowerShell 5.1。

```powershell
bun --no-env-file install --frozen-lockfile
bun --no-env-file run infra:up postgres clickhouse nats s3
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) '.data/playwright'
node node_modules/playwright/cli.js install chromium
bun --no-env-file run demo
```

访问[本地 Web](http://127.0.0.1:13001)。随机管理员、操作员和只读账号保存在 `.data/demo-admin.json`，该文件被 Git 排除。演示运行受控网页、Crawlee、RAW 清洗、独立 PostgreSQL/ClickHouse 写入及 S3 归档，生成 4 艘样例船和轨迹；记录带“样例数据”标记。

启动时先恢复已有消费者，恢复成功后才开启定时任务调度。AISStream 长连接的采集命令会持续保留至运行结束；只有已投递、来源与任务启用、运行中且持有有效来源租约的命令，才不按等待年龄计算积压。健康接口保留真实消息年龄 `oldestAgeMs`，另返回用于背压的等待年龄 `pendingAgeMs` 和被排除的流式命令数 `activeStreamingCommands`。真实排队命令、失效租约、容量超限或消费者异常仍会阻止启动；等待 120 秒超时后保留队列和数据，请检查消费者与租约状态，不要清空队列来绕过检查。

Linux/macOS 安装浏览器前执行 `export PLAYWRIGHT_BROWSERS_PATH="$PWD/.data/playwright"`。配置通过部署环境或明确的 Node `--env-file` 参数注入；新服务不主动读取旧原型 `.env.local`。`.env.example` 与本地 Compose 端口、字段一致。

## 工程与命令

| 路径                                                  | 职责                                |
| ----------------------------------------------------- | ----------------------------------- |
| `apps/web`、`apps/api`                                | Web、登录权限、查询和控制面         |
| `apps/agent`                                          | Pi 任务执行、内置技能与受控海图操作 |
| `apps/collector`、`apps/crawler`                      | 官方接口/流、受控网页采集           |
| `apps/processor`、`apps/writer`、`apps/archiver`      | 清洗、独立双写入、原始归档          |
| `apps/intelligence`、`apps/topics`                    | 情报接入、独立专题计算与可追溯结果  |
| `packages/contracts`、`packages/domain`               | 运行时 Schema、清洗和来源选择       |
| `packages/source-adapters`、`packages/infrastructure` | 协议适配、数据库、队列和对象存储    |
| `infra`、`tests`、`scripts`                           | 部署、样例、验证和操作入口          |

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
# 需要 Docker Compose 与 kubectl；仅解析配置，不连接集群
bun --no-env-file run deployment:check
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

生产镜像使用 `infra/Dockerfile`。Docker 入口为 [compose.production.yaml](infra/compose.production.yaml)，Kubernetes 入口位于 [infra/k8s](infra/k8s)。两种方式共用当前构建产物，分别按运维说明配置域名、外部专用 S3 桶及凭据；初始化成功后再启动应用。Kubernetes 按基础组件、初始化 Job、应用三个阶段发布，Agent 与监控按需启用。

当前模板采用单实例存储和单副本应用，生产容量、备份恢复与故障切换需要在目标环境验收。配置静态检查、镜像构建、容器运行和真实集群部署分别记录结果，详见[能力与验证状态](docs/implementation-status.md)。
