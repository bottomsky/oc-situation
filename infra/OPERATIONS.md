# AIS 后台链路运行说明

## 初始化与启动

开发环境使用 `infra/compose.yaml`，项目名为 `ais-platform`。PostgreSQL、ClickHouse、NATS 与 SeaweedFS S3 服务分别监听本机 15432、18123、14222 和 19000；NATS 监控端口为 18222。Caddy、Prometheus 与 Grafana 分别使用 18080、19090 和 13003。数据库、对象存储与消息端口绑定 `127.0.0.1`。

初始化入口 `infra/init.ts` 依次调用版本迁移、JetStream 拓扑创建与 S3 桶检查。开发种子只创建来源和任务；样例位置由采集链路生成。生产初始化要求外部 S3 桶已存在，并允许设置 91 天生命周期兜底策略。首次部署需明确提供 ADMIN_USERNAME 与至少 12 字符的 ADMIN_PASSWORD；已有有效管理员的部署可继续使用已有账号。生产 DATABASE_URL 显式提供，并对密码中的 URI 保留字符执行 URL 编码；它应指向内部 postgres 服务及 ais 数据库。

后台入口包括 `apps/processor/main.ts`、`apps/writer/main.ts` 和 `apps/archiver/main.ts`。writer 通过 `WRITER_TARGET=postgres|clickhouse` 选择目标。内部健康与指标端口为 API 13100、processor 13101、PG writer 13102、CH writer 13103、archiver 13104、collector 13105、crawler 13106。主机开发默认监听本机；容器内部通过 `METRICS_HOST=0.0.0.0` 提供内部网络访问。

## 消息拓扑与恢复

RAW 使用 file storage 和 InterestPolicy，300 GB 容量上限，cleaner 与 archiver 两个 durable 均建立后开放采集。NORMALIZED 同样采用 InterestPolicy，150 GB 上限，PG 和 CH writer 各自维护 durable。命令流采用 WorkQueuePolicy，crawl、collect 和 replay 使用互不重叠的 filter，每个命令 consumer 的 max pending 为 1。流采用 DiscardNew 与无时间淘汰；确认完成前保留消息。

采集门禁每秒检查流设置、完整 consumer 拓扑、占用字节和最旧消息年龄。达到 70% 或 1 小时为预警；达到 85% 或 24 小时、consumer 缺失或设置漂移时暂停采集。发布失败立即清除健康缓存。拓扑创建只在显式初始化入口执行。

采集确认 RAW 发布后推进检查点。processor 等待每条规范化发布确认后确认 RAW。writer 持久写入整个批次后确认消息；连接失败保留消息并延迟重试。PG 采用 1000 条或 1 秒，CH 采用 5000 条或 2 秒。PG 同批 MMSI 先归并再执行带时间、来源优先级与 eventId 条件的 upsert；静态信息和字段来源通过批量读取、内存逐字段合并和批量 SQL 写回。CH 同步插入使用稳定批次 token 和非复制 MergeTree 去重窗口；历史查询仍应使用 FINAL 或等价逻辑去重。

归档按 receivedAt 的一分钟桶、来源及 10000 条序号分片分组，最长 60 秒刷新，缓冲达到 16 MiB 提前刷新。RAW archiver 拉取消费使用 16 MiB 字节预算；数据库准备数据也受 32 MiB 限制。先持久准备清单与有界临时原文，再上传稳定键的 gzip JSONL，提交清单后确认消息。提交时立即清空 PostgreSQL 临时原文与 captureIds；保留对象键、来源、时间范围、计数、校验和及压缩 sequence_ranges。重复消费按精确序号成员判定，序号区间的空洞保持待归档状态。

大型响应超过 256 KiB 时进入独立 artifact 对象，响应总上限 10 MiB。归档保留其对象引用和清理信息。对象读取校验 SHA-256；归档读取限制压缩输入 32 MiB、解压输出 128 MiB。

## 过期与重放

归档业务到期时间为最后 receivedAt 加 90 天。API 和重放读取依据清单到期字段执行截止判断。archiver 启动及每日执行清理：到期清单进入 pending_delete，删除失败保留重试状态，成功删除记录保留至 7 天观察期结束。外部 S3 的 91 天生命周期负责兜底。PG 最新位置按 30 天清理，CH positions 使用 observedAt 加 30 天 TTL。

重放读取 committed 且有效的清单，保留原 captureId、eventId 和观测时间，经相同 processor 发布 NORMALIZED。清单按时间桶、首序号与清单 ID 排序，每页最多 100 个，以完整游标推进检查点；旧检查点缺失及已知到期缺口记录可见失败。每条原文处理前检查停机信号和取消状态，命令消费维持心跳。终端业务错误确认命令并保留失败结果，连接故障延迟重试。当前接收 cleaningVersion 1 与 targetDataset current；其他目标进入显式能力门禁，数据集迁移和新表切换需要独立实现及验收。

PG 最新位置 writer 使用已持久化、已加锁的上一位置判断跳跃，旧或乱序更新保持当前位置。implausible_jump 的已实现范围为 PG 最新位置质量；CH 历史质量保存输入清洗标记。仪表盘应把最新位置跳跃数量与历史隔离、清洗标记区分展示。

归档确认响应数按 PG committed 清单计数聚合，可能滞后一个归档周期。一个原始响应可以展开多条独立观测，CH 以 eventId 去重的观测数量用于清洗和隔离统计。实时响应量由采集指标和 run counters 提供。

## 生产部署与验收状态

`infra/compose.production.yaml` 使用内部数据库网络、外部 S3、显式生产密钥、持久卷、服务健康检查和资源限制。公网入口由 Caddy 的 HTTPS 域名提供。镜像入口采用 Node.js 24 与实际构建产物；SQL 资源随初始化产物打包。生产镜像应经独立镜像构建与依赖审查后指定 AIS_IMAGE。Crawlee 请求队列与运行状态存入 crawler-state 持久卷；镜像应保证 node 用户对该路径具有写权限。当前网页来源支持受控开发样例，正式网页采集需要经过来源授权和专用适配器准入。

本地四个基础服务已实际启动并健康。已通过真实集成测试：PG 批内去重和条件更新、逐字段静态来源、最新位置跳跃与乱序保护、CH 重复同步写逻辑去重、consumer 缺失停采集、S3 大对象回读、prepared 归档恢复与精确序号空洞、租约 fencing、S3 上传故障恢复，以及 RAW→processor→双 writer→S3 的完整处理链路。

当前开发宿主内存约 15.5 GiB。16 核、64 GiB 生产基线、1000 条每秒持续负载、历史查询和地图指标的完整性能验收、外部 S3 IAM/TLS、生命周期删除权限、生产镜像运行、备份恢复和故障域切换应在对应部署环境执行。运维扩展应覆盖队列字节和年龄、隔离比例、断流、归档延迟、磁盘余量以及 Grafana 仪表盘。健康端点当前共同检查全部存储依赖，单个存储故障会让多个后台服务报告未就绪；持久化处理仍按各自写入边界重试。
