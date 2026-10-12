# AIS 与情报融合专题

系统以统一数据接入、独立专题计算、持久化证据和海图展示组成业务链路。AIS 采集、清洗与历史写入沿用现有服务，新增情报服务和专题服务；每个专题实例有自己的订阅、运行状态、检查点和结果历史。

## 服务与代码边界

| 模块           | 入口                                                    | 职责                                                     |
| -------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| AIS 接入与清洗 | `apps/collector`、`apps/crawler`、`apps/processor`      | 来源适配、标准化、质量标记                               |
| 数据写入与查询 | `apps/writer`、`packages/infrastructure/fusion-data.ts` | 当前船位、历史轨迹、对象标识、历史船舶属性、数据就绪记录 |
| 情报服务       | `apps/intelligence/main.ts`                             | JSON/API、受控文件、RSS 原文接入、归档和轮询隔离         |
| 专题控制面     | `apps/api/src/topics/controller.ts`                     | 注册定义、创建实例、配置、启停、人工计算与运行查询       |
| 专题计算进程   | `apps/topics/main.ts`                                   | 独立持久订阅、历史计算、定时运行、租约、重试与进度       |
| 专题算法       | `packages/domain/topics.ts`                             | 港口限制船舶识别、区域低速活动与公告关联                 |
| 结果与证据     | `packages/infrastructure/topics.ts`                     | 输入快照、结论版本、撤回、证据链、持久通知记录           |
| 实时 API       | `apps/api/src/live/gateway.ts`                          | 会话鉴权、视野船位增量、结果通知、断线恢复               |
| Web            | `apps/web`                                              | 海图、情报来源与原文、专题控制、事件和证据面板           |

当前控制面与查询接口部署在同一个 API 进程，数据和结果分别由独立模块管理。采集和专题计算独立部署。未来拆分 API 服务时，可沿当前 HTTP 接口和数据所有权拆分。

## 数据与证据

PostgreSQL/PostGIS 保存对象、情报、专题控制和结果；ClickHouse 保存 AIS 历史；S3 保存情报原文和原始 AIS 归档。运行输入与结论证据保存 JSON 快照，保留当次采用的具体船位、静态属性、公告段落、参数和算法版本。

船舶查询采用内部对象标识和带有效时间的标识关系。当前根据 MMSI 初始化对象，并按历史有效区间关联轨迹；IMO 等标识的自动合并需要接入可核验的船舶档案及消歧规则，作为对象管理的后续扩展。

AIS 的 PostgreSQL 与 ClickHouse 写入完成后，各自记录持久回执。两方回执齐备才生成 `fusion_ready_outbox`，发布到 `FUSION_READY` 的 `fusion.ready`。写入后进程退出时，可通过原消息重投恢复回执。发布成功但标记前退出时会重复发布，专题按事件标识幂等处理。

`FUSION_READY` 使用 Limits 保留策略，默认保留七天。每个实例使用自己的 `topic-<实例 ID>` durable consumer。同一专题的副本共享该实例的消费进度，不同实例分别接收相同数据。历史数据从数据库查询，消息保留期限独立于业务历史。

情报同时保留发布时间、生效区间、接收记录、来源、原文摘要、段落和版本。相同来源与外部标识的版本递增，修订通过 `supersedesId` 指向上版；已有版本内容保持不变。`commonSourceId` 表达转载的共同来源；当前规则逐公告匹配，输出保持具体来源，后续可信度算法可基于该字段合并独立证据。

RSS 接入保存原文，供操作员审核和结构化。自动专题只使用满足结构化协议的公告。任意新闻的地名消歧、条件抽取和可信度评估，可另接抽取模块，并用业务验收样本验证。

数据查询默认每类最多 50,000 条，AIS、静态属性和情报查询分别设 32 MiB 返回上限；跨语言执行器的完整输入另受 32 MiB 限制。超出上限会报错，专题显示降级并保留上次有效结论。当前 AIS 在线保留期为 30 天，更早重算需要恢复原始归档。情报归档使用独立 `intelligence/` 前缀，结论和输入快照无自动删除任务；保留期由业务后续制定。

## 专题运行和算法扩展

定义描述算法、版本和依赖；实例描述区域、时间窗口、阈值和启停；运行记录描述触发原因、输入、执行状态和结果。业务管理员管理实例，操作员可以发起人工计算，只读用户查看事件和证据。

启用后建立订阅并执行历史预热。实例独立保存检查点；恢复时补算积压时段。数据更新、定时检查和人工请求使用同一执行链路。增量消息聚合为待计算时间段，以限制重复计算。运行通过数据库租约认领，失败按退避策略重试，达到次数上限后留下可查询的失败状态。

配置或启停变更提高实例 generation。旧 generation 的任务无法提交新结果。结果、修订记录和待通知事件在同一事务中保存；通知重复投递时，前端按游标和结果版本处理。

新增 TypeScript 算法时，在专题定义和配置协议中声明输入、参数及能力依赖，并为计算器增加实现和业务测试。采集服务继续提供共享数据。专题计算器输入 `TopicInstance` 与 `TopicDataset`，输出 `AnalysisResult[]`，其中 `evidence` 为必填结构。

跨语言算法通过 `TOPIC_EXECUTOR_COMMAND` 配置 JSON argv 数组。宿主以标准输入输出传递版本化 JSON，执行超时和输出上限由宿主控制。命令来自部署配置，使用 shell=false 启动；算法运行身份应按部署环境控制。具体协议与 Python 示例见 [专题说明](../apps/topics/README.md)。默认生产镜像运行内置 TypeScript 算法；部署 Python 执行器时，需要在自定义镜像中安装运行时、复制算法文件，并通过 Compose override 传入执行命令。

现有两个专题分别输出“限制条件规则匹配”和“多点低速与公告的时空共现”。区域使用边界框，证据面板明确这一空间近似。航次延误、行为原因等判断需要专门的数据条件和算法验收。

## HTTP 与实时协议

HTTP 基础路径为 `/api/v1`。登录使用现有同源会话；写入同时校验角色、Origin 与 CSRF。人工计算要求 UUID `Idempotency-Key`。

| 接口                                  | 用途                         |
| ------------------------------------- | ---------------------------- |
| `GET/POST /intelligence/sources`      | 查询和注册来源               |
| `PUT /intelligence/sources/:id`       | 更新来源或启停               |
| `GET/POST /intelligence/events`       | 查询情报版本或录入结构化情报 |
| `GET /intelligence/archives`          | 原文归档索引                 |
| `GET /intelligence/archives/:id`      | 授权读取原文                 |
| `GET /topics`                         | 专题定义、实例和依赖能力     |
| `POST /topics/instances`              | 创建实例                     |
| `PUT /topics/instances/:id/state`     | 启停实例                     |
| `PUT /topics/instances/:id/config`    | 更新分析配置                 |
| `POST /topics/instances/:id/run`      | 人工计算                     |
| `GET /topics/instances/:id/runs`      | 运行历史                     |
| `GET /topics/runs/:id`                | 当次输入、参数与算法版本快照 |
| `GET /analysis/results`               | 最新结果列表                 |
| `GET /analysis/results/:id`           | 结论与完整证据               |
| `GET /analysis/results/:id/revisions` | 不可变修订历史               |
| `GET /analysis/feed?cursor=...`       | 按游标补取通知               |

WebSocket 地址为 `/api/v1/live?cursor=<已处理游标>`，握手检查会话和允许的 Origin，并定期重新检查会话。客户端发送：

```json
{ "type": "viewport", "version": 1, "query": { "bbox": "123,32,126,35", "zoom": 8, "hours": 24 } }
```

服务端先返回 `ais.snapshot`，随后发送 `ais.delta`。增量包含 `upsert`、`remove`、总数、截断标记和生成时间，记录键为 `point:<mmsi>` 或 `cluster:<clusterId>`。视野版本防止旧查询覆盖新视野。当前服务端每两秒查询已订阅视野并计算增量；前端断线时使用 HTTP 查询恢复。

结论通知为 `analysis.updated`，携带持久游标、结果 ID 和 revision。前端再读取完整结果与证据。慢连接触发断开后，客户端通过持久 feed 补取。

## 本地运行与验收

```powershell
bun install
bun run infra:up postgres clickhouse nats s3
bun run migrate
bun run demo
```

演示程序通过真实 AIS 流水线写入合成船位，接入带“合成数据”标记的公告，并启动两类独立专题进程。海图可以查看专题事件、证据和对应区域。生产来源按配置接入，演示公告仅用于开发验收。

独立启动情报服务：`bun run dev:intelligence`。独立启动专题服务：设置 `TOPIC_DEFINITION_ID=port-restriction` 或 `area-low-speed-notice` 后运行 `bun run dev:topics`，多个本地进程用不同 `INTERNAL_METRICS_PORT`。生产 Compose 已分开定义情报和两类专题进程。

验证依次覆盖单元测试、真实 PG/ClickHouse/NATS/S3 集成、浏览器流程、类型检查和构建。核心场景是独立消费、预热衔接、重复投递、修订撤回、停用隔离、故障重试、证据快照及跨语言协议。测试结果与未验证事项记录在实施状态中。

`bun run test:integration:isolated` 与 `bun run test:e2e:isolated` 会创建独立 Docker Compose 测试项目，分别使用 15433、18124、14223、19001 端口。每次创建全新数据库和队列，并在结束后删除该次测试专用卷。开发数据卷保持原样；两个隔离命令应顺序执行。

完成 `bun run build` 后，可运行 `bun run test:e2e:isolated --compiled-smoke`：浏览器验收结束后，沿用该次数据库检查编译 API 的认证、船舶查询、两个专题的结果与证据，并启动 Nuxt 生产服务。

知识图谱能力当前声明为不可用，基础专题直接使用时空数据。后续图谱服务通过能力接口提供带来源和有效时间的关系查询；图谱依赖必须满足后才能启动相应专题。

## 既有归档兼容

新 AIS 原始报文使用带版本的规范化 JSON 校验，确保对象字段在 JSONB 中重排后仍可验证。归档准备记录额外保存原始序列化文本，兼容使用旧校验规则的生产者；读取时同时验证文本与索引记录一致、内容校验值正确。

升级前已经写入 JSONB、缺少原始序列化文本的旧 `prepared` 批次，由归档器在重投处理时自动恢复。恢复在数据库事务行锁内进行，先核对批次记录数、序列范围和起止序列，再按记录序列读取 `AIS_RAW` 中仍保留的原始消息，逐条核对消息序列、来源主题、报文协议、校验值、来源时间桶，以及原文与 JSONB 索引的完整内容。整批验证通过后，仅补齐缺失的原始文本，随后按常规流程写入归档对象、提交批次并确认消息。原消息缺失或任一核对失败时，事务回滚，批次保持 `prepared`，保留失败信息并等待可核验的原文恢复；该批次不会写入归档对象或确认消息。既有内容、索引和校验规则保持原样。
