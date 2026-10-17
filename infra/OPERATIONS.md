# 部署与运行手册

本手册对应当前仓库的 API、Nuxt Web、采集和处理后台，以及可选 Agent。Docker Compose 面向单机，Kubernetes 使用集群内单实例 PostgreSQL、ClickHouse、NATS 和外部 S3。两种方式部署相同业务入口；当前单副本边界由租约、队列拓扑、持久卷与应用恢复能力共同决定。

## 文件与发布入口

| 文件或目录                      | 用途                                                                   |
| ------------------------------- | ---------------------------------------------------------------------- |
| `infra/Dockerfile`              | Node.js 24 运行镜像，Bun 1.3.12 安装依赖，包含 Chromium 与当前构建产物 |
| `infra/compose.production.yaml` | 生产单机服务与可选 agent、monitoring profile                           |
| `infra/.env.production.example` | 全部为合成值的 Compose 环境变量样例                                    |
| `infra/k8s/bootstrap`           | Namespace、ConfigMap、NetworkPolicy、数据库 StatefulSet 和 PVC 模板    |
| `infra/k8s/init`                | 执行迁移、JetStream 拓扑、S3 检查和管理员初始化的 Job                  |
| `infra/k8s/apps`                | API 与 Caddy sidecar、Web、九类后台、Ingress 与服务                    |
| `infra/k8s/components`          | 可选 Agent 和 Prometheus/Grafana                                       |
| `infra/k8s/overlays/production` | 生产参数与分阶段 Kustomize 入口                                        |
| `infra/k8s/examples`            | Secret 契约和资源覆盖样例                                              |
| `scripts/check-deployment.ts`   | 本地与 CI 静态检查入口                                                 |

从仓库根目录构建发布镜像：

```sh
docker build -f infra/Dockerfile -t registry.example.invalid/ais-platform:2026.10.17 .
```

将示例仓库地址和标签替换为受控镜像仓库与唯一发布版本，完成镜像扫描后推送。生产环境可使用 digest 固定镜像。Kubernetes 的 init、apps、apps-agent 三个 overlay 的 images 配置须使用同一版本；组合 overlay 继承这些设置。私有仓库通过命名空间的镜像拉取凭据接入，可为各 Pod 设置 imagePullSecrets，或由平台配置专用 ServiceAccount。

镜像中默认专题执行器为 TypeScript。启用 `TOPIC_EXECUTOR_COMMAND` 外部 Python 执行器时，需单独制作包含指定 Python、算法脚本和依赖的镜像，并验收标准输入输出协议。当前发布配置使用默认执行器。当前地图使用内置离线底图，生产配置未声明源码没有消费的地图运行时变量。

## 外部 S3 与密钥

部署前创建专用 S3 桶，准备 HTTPS endpoint、region、bucket 和两组凭据。运行凭据负责对象上传、读取、列举和到期删除，并须具备健康检查使用的 HeadBucket 桶级访问权限；初始化凭据另需桶检查与生命周期配置权限。按所选 S3 服务的 IAM 动作分别授予桶资源与对象前缀权限。Compose 使用 `S3_INIT_ACCESS_KEY_ID`、`S3_INIT_SECRET_ACCESS_KEY`；Kubernetes 将它们放入 `ais-bootstrap`，应用只读取 `ais-runtime`。

**当前初始化会调用 PutBucketLifecycleConfiguration，覆盖该桶现有生命周期配置**，写入 raw 与 artifacts 前缀的 91 天到期规则。因此该桶应专供本系统；共享桶必须先调整初始化实现并完成规则合并验证。业务归档在 90 天到期，S3 91 天规则负责兜底。版本化桶的非当前版本和未完成分段上传清理由存储管理员另行配置，并核对每次初始化后的规则。

生产 Secret 由部署平台、密钥管理系统或仓库外受限文件提供。示例文件只用于展示键名，不能作为生产凭据部署。PostgreSQL 密码与 DATABASE_URL 的密码、ClickHouse 两处密码、NATS_AUTH_TOKEN 与 NATS_TOKEN 必须一致；DATABASE_URL 中密码的 URI 保留字符须编码。首次初始化提供 ADMIN_USERNAME 和至少 12 字符的 ADMIN_PASSWORD。初始化凭据只挂载至 Job；按发布窗口授权和回收。

## Docker Compose 部署

将 `infra/.env.production.example` 复制到仓库外受限路径，例如 `/secure/ais.production.env`，填入镜像、域名、外部 S3、数据库和管理员配置。Compose 会解析整个配置，因此样例包含可选监控所需的 GRAFANA_PASSWORD。域名解析到主机，开放 80/443，Caddy 自动申请和续期 HTTPS 证书。

```sh
docker compose --env-file /secure/ais.production.env -f infra/compose.production.yaml config --quiet
docker compose --env-file /secure/ais.production.env -f infra/compose.production.yaml up -d --wait
docker compose --env-file /secure/ais.production.env -f infra/compose.production.yaml ps
```

依赖顺序为数据库健康 → init 成功退出 → 业务容器 → Caddy。首次部署查看 init 日志并检查管理员登录、地图查询和消息流。升级需先完成备份、安排维护窗口并停止写入链路；更新镜像后显式重建 init，确认成功后恢复业务。已成功退出的旧 init 容器不能替代新发布的迁移执行。

启用 Agent 时，将 AGENT_ENABLED 与 AGENT_UI_ENABLED 同时设为 true，配置 DEEPSEEK_API_KEY，再在上述启动命令中加入 `--profile agent`。仅传 profile 而保持 false 会使 Agent 进程退出。可叠加 `--profile monitoring` 启用 Prometheus/Grafana；它们只进入内部网络，访问方式由运维平台安排。停用 Agent 时同步关闭两个旗标并停止 Agent 容器，防止 API 继续接受无人消费的任务。

启用 Agent 和监控后的完整启动命令如下；profile 参数位于 up 前。仅启用 Agent 时去掉 monitoring 参数。

```sh
docker compose --env-file /secure/ais.production.env -f infra/compose.production.yaml --profile agent --profile monitoring up -d --wait
```

完成备份、更新 env 中的镜像版本并安排维护窗口后，可按以下命令显式重建初始化。stop 保留命名卷；最后一步按原有启用范围加入 profile。

```sh
docker compose --env-file /secure/ais.production.env -f infra/compose.production.yaml --profile agent --profile monitoring stop
docker compose --env-file /secure/ais.production.env -f infra/compose.production.yaml up -d --wait postgres clickhouse nats
docker compose --env-file /secure/ais.production.env -f infra/compose.production.yaml up --no-deps --force-recreate --abort-on-container-exit --exit-code-from init init
# Continue only after init exits successfully.
docker compose --env-file /secure/ais.production.env -f infra/compose.production.yaml up -d --wait
```

内部数据库和消息端口没有发布到宿主。Caddy 固定内部 IP 与 API 的 TRUSTED_PROXY_CIDRS 配套；调整 AIS_BACKEND_SUBNET 时同时调整 CADDY_BACKEND_IP，确保该地址属于所选子网。Compose 使用本机命名卷，数据库、NATS 与 crawler-state 须纳入备份和磁盘容量管理。删除卷是数据销毁操作，应遵循专门的退役流程。

## Kubernetes 参数与容量

使用 Kubernetes 1.34 客户端内置的 Kustomize 渲染以下入口。部署集群须提供 StorageClass、Ingress controller、TLS 证书工作流和支持 NetworkPolicy 的 CNI。所有资源使用 ais-platform 命名空间。上线前按实际环境修改：

| 配置位置                                                   | 必填或可调项目                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------ |
| `overlays/production/bootstrap/site-config.yaml`           | PUBLIC_DOMAIN、WEB_ORIGINS、S3 三项配置、Ingress 实际来源可信 CIDR |
| `overlays/production/bootstrap/ingress-policy-patch.yaml`  | Ingress controller 所在命名空间                                    |
| `overlays/production/bootstrap/storage-patch.yaml`         | PG/CH/NATS 容量和 StorageClass                                     |
| `overlays/production/apps/ingress-patch.yaml`              | ingressClassName、与 PUBLIC_DOMAIN 一致的 host、TLS Secret         |
| `overlays/production/apps/storage-patch.yaml`              | crawler-state 容量和 StorageClass                                  |
| `overlays/production/init/kustomization.yaml`              | 每次发布的新 nameSuffix 和镜像版本                                 |
| `overlays/production/{apps,apps-agent}/kustomization.yaml` | 镜像版本                                                           |
| `examples/secrets.example.yaml`                            | 部署平台需要创建的 Secret 名称与键                                 |

可选应用入口四选一：apps、apps-agent、apps-monitoring、apps-agent-monitoring。Agent 组件会同时打开 API 与 worker 的 Agent/UI 开关，并要求 ais-agent Secret；监控组件要求 ais-monitoring Secret。切换 overlay 后旧资源不会自动删除：先确认任务排空，再显式停用退出范围内的 Deployment，保留持久卷。回退基础 apps 时先确认 API 旗标回到 false。

| 数据卷                       | 初始申请   | 说明                                                   |
| ---------------------------- | ---------- | ------------------------------------------------------ |
| PostgreSQL                   | 100 GiB    | 元数据、任务、归档清单                                 |
| ClickHouse                   | 500 GiB    | AIS 历史                                               |
| NATS                         | 500 GiB    | JetStream file store 配置上限 460 GB，保留文件系统余量 |
| crawler-state                | 10 GiB     | Crawlee 队列和运行状态                                 |
| Prometheus / Grafana（可选） | 20 / 5 GiB | 指标保留 15 天及监控配置                               |

所有卷默认 ReadWriteOnce，省略 storageClassName 时使用集群默认类。生产首次创建前应明确存储性能、可用区和回收策略，必要时填入 storageClassName。StatefulSet 卷模板在创建后受不可变字段约束；扩容须按 StorageClass 的 allowVolumeExpansion、实际 PVC 和 StatefulSet 变更流程执行，不能仅修改模板后假定数据卷已扩容。监控卷在 components/monitoring/workloads.yaml 中定义，可复制 `examples/monitoring-storage-patch.yaml` 到选用的监控 overlay 并加入 patches。

数据库内存 request/limit 分别为 PG 1/8 GiB、CH 4/24 GiB、NATS 512 MiB/4 GiB。普通后台默认 request 256 MiB、limit 2 GiB，processor limit 4 GiB，Web limit 512 MiB；CPU 与各服务完整配置以 YAML 为准。这些值是初始部署预算，需结合真实峰值、节点 allocatable 和查询负载调整。可将 `examples/resources-patch.yaml` 复制到 apps overlay 并加入 patches，按同样结构覆盖其他服务。

应用固定单副本，Deployment 使用 Recreate，终止宽限 120 秒；数据库 StatefulSet 单实例。该配置包含停机升级和单实例故障窗口。高可用、多副本扩缩容、共享 crawler 队列及跨故障域恢复需完成独立设计与验收。

## Kubernetes 分阶段执行

以下命令由有权限的运维人员在配置就绪后执行。先建立命名空间，部署平台再在其中创建正式 Secret 与 ais-ingress-tls；命令中的 `/secure/ais-secrets.yaml` 代表仓库外受控输入。

```sh
kubectl apply -f infra/k8s/bootstrap/namespace.yaml
kubectl apply -f /secure/ais-secrets.yaml
kubectl apply -k infra/k8s/overlays/production/bootstrap
kubectl -n ais-platform rollout status statefulset/postgres --timeout=600s
kubectl -n ais-platform rollout status statefulset/clickhouse --timeout=600s
kubectl -n ais-platform rollout status statefulset/nats --timeout=600s
kubectl apply -k infra/k8s/overlays/production/init
kubectl -n ais-platform wait --for=condition=complete job/ais-init-20261017-01 --timeout=900s
kubectl -n ais-platform logs job/ais-init-20261017-01
kubectl apply -k infra/k8s/overlays/production/apps
kubectl -n ais-platform rollout status deployment -l app.kubernetes.io/part-of=ais-platform --timeout=600s
```

Job 名称与 nameSuffix 同步替换。初始化失败时停留在当前阶段，检查日志和依赖，不继续应用业务清单。Kustomize 只渲染资源，apply 的排列顺序不形成就绪门禁。每次发布创建新版本 Job；Kubernetes Job 的 Pod 模板不能原地替换。init 已成功但后续发布中断时，应先核实数据库版本与拓扑，再决定恢复步骤。数据库迁移回滚由发布计划明确，应用镜像回退不能自动撤销数据变更。

升级遵循相同的基础设施 → 新版本初始化 → 应用顺序，并在涉及不兼容迁移前进入维护窗口、停止应用写入。应用保持单副本 Recreate，用户请求会经历短暂不可用。

## 网关、真实客户端 IP 与长连接

Kubernetes 请求路径为 Ingress TLS → gateway Service:8080 → API Pod 内 Caddy。API 只监听 127.0.0.1:13000，只信任 loopback。Caddy 将 /api/* 原路径交给 API，其余交给 web:13001；/api/v1/live 的 WebSocket 升级由反向代理处理。Ingress 的 WebSocket/SSE 空闲超时应覆盖实际会话时长，上线验收须包含长连接与断线重连。

Caddy 的 INGRESS_TRUSTED_CIDRS 必须对应它实际看到的 Ingress 来源网段，使用空格分隔多个网段。当前文档地址 192.0.2.0/24 是占位值。Caddy 启用严格从右到左解析，将验证后的 client_ip 覆写为单个 X-Forwarded-For，并固定上游 X-Forwarded-Proto 为 https。API 登录按请求 IP 限流，真实 IP 识别需验收正确用户地址与伪造头被拒绝两类场景。Ingress 应按其负载均衡链路清洗客户端伪造头；禁止直接信任全部地址或任意客户端 X-Forwarded-For。

NetworkPolicy 限定 Ingress 命名空间访问 gateway:8080，并允许本命名空间 Prometheus 访问 API 指标。其余服务接受同命名空间流量。当前未限制 egress，平台可按 DNS、外部 S3、授权来源与模型服务地址进一步收敛。hostNetwork Ingress、源地址 SNAT 和 CNI 实现会影响 namespaceSelector 的匹配，使用这类集群配置时须按实际源地址调整策略并验证。TLS 在 Ingress 终止，Caddy 不管理证书；公网应只通过该 Ingress 进入。

## 健康检查与监控

| 服务                                         | 内部 HTTP 端口                |
| -------------------------------------------- | ----------------------------- |
| API                                          | 13100                         |
| processor / PG writer / CH writer / archiver | 13101 / 13102 / 13103 / 13104 |
| collector / crawler / intelligence           | 13105 / 13106 / 13107         |
| port-restriction / low-speed / Agent         | 13108 / 13109 / 13110         |
| Web / K8s gateway                            | 13001 / 8080                  |

API 与后台在 /metrics 提供指标，在 /ready 检查依赖。Kubernetes startup/liveness 使用 /metrics，仅判断 HTTP 进程可响应；readiness 使用 /ready。当前后台 /health 同样包含存储检查，因此没有用于 liveness，防止存储故障引发全链路重启。指标存活探针也不能证明业务消费进度正常，应结合队列年龄、消费延迟和错误率判断。Web 使用 /，Caddy 使用 /healthz；PG 使用 pg_isready/TCP，CH 使用 /ping，NATS 使用 /healthz 及 JetStream 就绪检查。

Compose healthcheck 使用就绪状态；unhealthy 本身不会自动重启容器。Prometheus 对常驻后台使用静态抓取，对可选 Agent 使用 DNS 发现，未部署 Agent 时不生成常驻失败目标。告警规则来自 infra/alerts.yaml，Kubernetes 副本由部署检查核对一致性。监控 Service 只在集群内部开放，可使用受控 port-forward 或平台内网入口访问 Grafana。

## 配置变更、备份与恢复

ais-config、ais-nats 和 Secret 使用稳定名称，更新后已有进程不会自动重新加载环境变量。修改后先验证配置，再按服务依赖顺序执行 rollout restart；变更 NATS token 需同时更新服务端和客户端并协调维护窗口。Caddy 的文件 ConfigMap 带内容哈希，重新渲染应用会更新 Pod 模板；域名、WEB_ORIGINS 与可信 CIDR 来自稳定 ais-config，仍需重启 API Pod。重建初始化 Job 以刷新迁移或初始化权限，不把旧 Job 成功记录当成新配置已验证。

备份至少覆盖 PG 全量/WAL 策略、CH 数据、NATS 持久消息与 consumer 状态、S3 对象/生命周期配置、crawler-state 和运行配置。Secret 由密钥管理系统单独恢复。恢复顺序先验证基础设施数据一致性，再执行版本匹配的初始化检查，随后恢复处理链路并核对消息积压、归档清单和对象校验和。跨系统一致恢复、RPO/RTO、磁盘满、连接中断和优雅退出需要在目标环境演练。

## 开发环境与验证边界

开发环境使用 infra/compose.yaml，项目名 ais-platform。PG、CH、NATS 与 SeaweedFS S3 本机端口分别为 15432、18123、14222、19000，NATS 监控为 18222。Caddy、Prometheus、Grafana 分别为 18080、19090、13003。开发与隔离测试入口继续由根目录 bun 脚本管理。

静态检查命令：

```sh
bun --no-env-file run deployment:check
node --import tsx --test scripts/check-deployment.test.ts
```

检查使用合成 env 样例执行四种 Compose profile 的 config 渲染，并使用 kubectl kustomize 渲染六个阶段，核对端口、探针、Secret/ConfigMap/PVC/Service 引用和应用镜像版本一致性。它不会读取真实 .env 或 kubeconfig，也不会连接 Docker daemon 或 Kubernetes API。缺少 CLI 时可运行 `bun --no-env-file run deployment:check --source-only` 做语法检查，其验证范围较小。静态检查不是 Kubernetes OpenAPI 服务端校验，也不包含镜像运行、Caddy 二进制配置加载或网络连通验收。

本轮环境 Docker daemon 不可用，未构建和启动生产镜像，未访问 Kubernetes 集群。上线验收须覆盖镜像拉取、初始化幂等、挂载权限、外部 S3 IAM/TLS/生命周期、登录真实 IP、HTTP/WebSocket、后台消费、Agent 可选启停、监控采集、重启恢复与备份还原。16 核 64 GiB、1000 条每秒等容量目标仍需专项压测，清单资源配额不等同于性能承诺。

## 消息拓扑与恢复

RAW 使用 file storage 和 InterestPolicy，300 GB 容量上限，cleaner 与 archiver 两个 durable 均建立后开放采集。NORMALIZED 同样采用 InterestPolicy，150 GB 上限，PG 和 CH writer 各自维护 durable。命令流采用 WorkQueuePolicy，crawl、collect 和 replay 使用互不重叠的 filter，collector 命令 consumer 的 max pending 为 8，crawler 与 replay 为 1。流采用 DiscardNew 与无时间淘汰；确认完成前保留消息。

采集门禁每秒检查流设置、完整 consumer 拓扑、占用字节和最旧消息年龄。达到 70% 或 1 小时为预警；达到 85% 或 24 小时、consumer 缺失或设置漂移时暂停采集。发布失败立即清除健康缓存。拓扑创建只在显式初始化入口执行。

采集确认 RAW 发布后推进检查点。processor 等待每条规范化发布确认后确认 RAW。writer 持久写入整个批次后确认消息；连接失败保留消息并延迟重试。PG 采用 1000 条或 1 秒，CH 采用 5000 条或 2 秒。PG 同批 MMSI 先归并再执行带时间、来源优先级与 eventId 条件的 upsert；静态信息和字段来源通过批量读取、内存逐字段合并和批量 SQL 写回。CH 同步插入使用稳定批次 token 和非复制 MergeTree 去重窗口；历史查询仍应使用 FINAL 或等价逻辑去重。

归档按 receivedAt 的一分钟桶、来源及 10000 条序号分片分组，最长 60 秒刷新，缓冲达到 16 MiB 提前刷新。RAW archiver 拉取消费使用 16 MiB 字节预算；数据库准备数据也受 32 MiB 限制。先持久准备清单与有界临时原文，再上传稳定键的 gzip JSONL，提交清单后确认消息。提交时立即清空 PostgreSQL 临时原文与 captureIds；保留对象键、来源、时间范围、计数、校验和及压缩 sequence_ranges。重复消费按精确序号成员判定，序号区间的空洞保持待归档状态。

大型响应超过 256 KiB 时进入独立 artifact 对象，响应总上限 10 MiB。归档保留其对象引用和清理信息。对象读取校验 SHA-256；归档读取限制压缩输入 32 MiB、解压输出 128 MiB。

## 过期与重放

归档业务到期时间为最后 receivedAt 加 90 天。API 和重放读取依据清单到期字段执行截止判断。archiver 启动及每日执行清理：到期清单进入 pending_delete，删除失败保留重试状态，成功删除记录保留至 7 天观察期结束。外部 S3 的 91 天生命周期负责兜底。PG 最新位置按 30 天清理，CH positions 使用 observedAt 加 30 天 TTL。

重放读取 committed 且有效的清单，保留原 captureId、eventId 和观测时间，经相同 processor 发布 NORMALIZED。清单按时间桶、首序号与清单 ID 排序，每页最多 100 个，以完整游标推进检查点；旧检查点缺失及已知到期缺口记录可见失败。每条原文处理前检查停机信号和取消状态，命令消费维持心跳。终端业务错误确认命令并保留失败结果，连接故障延迟重试。当前接收 cleaningVersion 1 与 targetDataset current；其他目标进入显式能力门禁，数据集迁移和新表切换需要独立实现及验收。

processor 在发布 NORMALIZED 前通过 assessPositionQualityBatch 统一判定 implausible_jump，使用持久化的 MMSI 状态与异常决策保持重试一致性，正常处理与重放均复用该逻辑。PG 最新位置与 CH 历史接收同一质量标记；PG 条件更新保留旧或乱序消息到达前的当前位置。仪表盘按最新位置、历史观测和隔离数量分别展示质量统计。

归档确认响应数按 PG committed 清单计数聚合，可能滞后一个归档周期。一个原始响应可以展开多条独立观测，CH 以 eventId 去重的观测数量用于清洗和隔离统计。实时响应量由采集指标和 run counters 提供。
