# 航线管理与自动航路规划

计划航线保存不可变修订，支持手工几何、GeoJSON 导入、规划结果保存、归档和复制比较。每次写入使用 UUID `operationId`；更新同时提交 `expectedRevision`。重复同一操作返回原结果，同键异输入及过期修订返回 409。业务变更、审计和操作回执通过同一 PostgreSQL 事务提交。

## 运行与数据准备

API 注册 `RoutesController` 和 `RoutePlanningService`，执行增量迁移 023 和 025。任务调度沿用 API `scheduler` 配置和 `ROUTE_PLANNING_ENABLED` 开关；显式设为 `false` 时，新规划请求在获取数据库连接前返回 503 `planning_disabled`。每实例同时运行两个任务，单任务默认 30 秒。任务状态为 `queued / running / completed / failed / cancelled`，重启后超过 35 秒的遗留运行任务标记 `worker_interrupted`。

导入工具需要 Docker、Bun/Node 24 和可访问的 PostGIS 数据库。全球陆地 ZIP 约 0.93 GB，导入后的数据库需要数 GB 可用空间。文件保存在已被 Git 忽略的 `.data/routes/raw`。

```powershell
$env:DATABASE_URL='postgresql://USER:PASSWORD@127.0.0.1:15433/DATABASE'
bun --no-env-file run routes:data:import --download
```

工具通过固定 GDAL 镜像 `ghcr.io/osgeo/gdal:ubuntu-small-3.11.4` 导入，使用 `/vsizip/` 直接读取海岸线 ZIP，形成临时 UNLOGGED staging 表；正式数据先提交为待准备版本，完成可恢复的基础可航性计算后，在独立事务中激活。数据导入失败回滚；准备失败保留待恢复版本和进度，原激活版本持续服务。随后清理 staging。重复导入已存在版本会报错，保留已有激活版本。下载由工具完成时记录下载时间与 HTTP Last-Modified；后者单独作为资源时间。既有文件缺失下载旁证时下载时间保留未知，海岸线源数据时间从 ZIP 内 README 读取。

固定来源：

- Eurostat SeaRoute 3.5，提交 `4fcdc74cf4a072b3c493fcdd64b7bec47c1ad597`，`marnet_plus_5km.gpkg`，SHA256 `75ca6cc130b3748f568196a9caf62889e9f096ec358f65223b4095ac070be0e7`，EUPL-1.2。导入前校验固定校验值。[源仓库](https://github.com/eurostat/searoute)
- OSM 完整 WGS84 split land polygons，ODbL-1.0，归属 `© OpenStreetMap contributors`。工具记录实际 ZIP 校验值、README、CRS、转换器及安装时间。[数据说明及许可](https://osmdata.openstreetmap.de/data/land-polygons.html)

既有数据集升级 025 后，运行显式准备命令。版本省略时选择当前激活版本；准备完成后，如需发布指定的新版本，增加 `--activate`。

```powershell
bun --no-env-file run routes:data:prepare --version=DATASET_VERSION
bun --no-env-file run routes:data:prepare --version=DATASET_VERSION --activate
```

准备任务以版本为粒度获取数据库 advisory lock，每批计算 1000 条原始边与完整陆地、关闭通道和北极区域的相交关系，提交 `base_navigable` 与 `navigation_checked_edges`。状态为 `unprepared / preparing / ready / failed`，异常记录 `navigation_error`；再次运行从未完成边继续。正式导入在激活前调用同一准备服务。请求仅使用 ready 数据集，其他状态返回 `dataset_unprepared`。运行时按任务固定的生效禁区过滤已验证基图，端点、连接段和最终完整折线继续实时检查陆地、通道和禁区。

正式规划使用这套独立数据。陆地细分保留原始海岸线，图层完整折线用于避陆校验。已有 110m 展示底图继续承担地图显示。

## 规划算法与边界

输入为 2～10 个有序航点，即最多 8 个中间途经点。每个点需位于海上，并连接 200 公里范围内最近的 16 个可见节点。每条路网原始折线、端点连接段及最终整条路线均使用 PostGIS geography 与陆地及本轮生效禁行区相交校验；geography 直接按球面处理跨日期变更线，消除平面经度跨越的误判。

A* 在独立 Node worker thread 中执行，边权为完整折线的球面长度，启发函数使用相同球面模型的直线距离。结果里程包含所有连接段。每轮返回一条最短可行候选，通过复制计划与修改条件重新计算比较。

默认关闭源数据标记的运河、苏伊士／巴拿马／基尔／科林斯保守地理闸口，以及北纬 66.5°以北航路；连接段和最终线路同样适用这些约束。新增通道应在专门的数据和通行条件验收后开放。当前数据用于态势研判与方案比较，实际航行决策需要专业航海数据和验收。

禁行区保存 Polygon/MultiPolygon、有效期及不可变版本。任务提交时固定数据版本、禁行区版本和生效时刻；后续数据或禁行区修订会使旧计划 `stale=true`，原结果继续保留。规划未实际完成时无法通过 `planId` 保存航线。

错误码包括 `planning_disabled`、`dataset_unprepared`、`dataset_unavailable`、`endpoint_on_land`、`endpoint_restricted`、`no_connector`、`no_path`、`route_blocked`、`timeout`、`cancelled`、`worker_interrupted` 和 `planning_failed`。取消先改变持久状态，数据库提交使用 `status='running'` 条件拦截迟到结果。任务预算从数据库连接获取开始计时；超时后才返回的连接会释放并保留任务待领取。领取、输入查询、worker 和最终校验共享剩余预算，完成状态还受数据库时钟栅栏保护；worker 超时后被终止。

## 接口与验证

`/api/v1/routes` 提供查询、创建及导入；`/:id` 提供详情和 PUT 更新；`/:id/history` 提供历史；`/:id/archive`、`/:id/copy` 和 `/:id/export` 提供归档、复制、导出。写入沿用 operator/admin、Origin 和 CSRF 检查。`/plans`、`/plans/:id`、`/plans/:id/cancel` 提供规划任务。`/restrictions` 和 `/restrictions/:id` 提供禁行区版本管理。

圆形查询参数为 `longitude / latitude / radiusMeters`，完整传入后转统一 `CircleRegionSchema`；ST_DWithin geography 在计数和分页前执行，范围 100～2000000 米。返回 `{items,total}`。

Agent 可直接调用 infrastructure 服务，actor 为 `{id,role}`，可选 `fence(client)` 在实际业务写入前后执行任务代次、输入修订等校验，失败使整个事务回滚。

```powershell
bunx vitest run packages/domain/route-planning.test.ts packages/infrastructure/route-planning.test.ts
$env:AIS_TEST_SCOPE='integration'
bunx vitest run packages/infrastructure/routes.integration.test.ts
bunx esbuild scripts/route-worker-smoke.ts --bundle --platform=node --format=esm --packages=external --outfile=.data/routes/worker-smoke.mjs
node .data/routes/worker-smoke.mjs
```

单测覆盖竞争路径最短解、完整折线、连接段计费、断路、缺少连接点、日期线、运河关闭及实际 worker。隔离 PostGIS 集成测试覆盖幂等、修订冲突、fence 回滚、角色、精确圆形筛选、真实规划任务、取消、陆地点和禁区断路。编译产物 smoke 实际启动 worker 并验证日期线里程。

## 运行指标与回归范围

`GET /api/v1/system/metrics` 要求 admin；独立 operations 服务的 `/metrics` 面向受控监控网络。每次抓取从数据库同一查询快照聚合 `ais_route_plans{status}`，状态标签固定为 queued/running/completed/failed/cancelled。`ais_route_plan_duration_seconds_sum` 汇总已有领取时间的终态任务从领取到最后更新时间的秒数，包含执行、取消及失败过程。该指标为保留记录的 gauge，配合 completed/failed 数量评估当前样本；连接排队时间由总任务预算约束，未计入该执行时长。

补充回归包括独立 O(V²) Dijkstra、独立球面距离参考与 A* 在 60 个弯曲多连接图上的最短距离对照；真实 PostGIS 陆地阻断连接段；调度并发上限 2 与 stop 等待在途任务；真实 Nest AccessGuard 的 viewer 写入拒绝、CSRF 拒绝与修订冲突。船舶圈查询另以 143 个实际数据库候选验证圆外剔除先于 100 条分页、total 稳定、毫米级内外边界、高纬与日期线，以及 ST_Project 边界与 ST_DWithin 使用相同椭球距离。

本次独立验证库已安装版本 `searoute-3.5-75ca6cc130b3-osm-290ea91109bb`，包含 1,358,009 个陆地细分几何、36,121 个节点和 72,478 条原始边；其中 68,348 条通过基础可航性校验。优化前每次请求重新校验全图，三个真实海上样例均在 30 秒超时。调整为显式基图准备后，在空闲执行窗口通过实际 Node/tsx worker、默认 30 秒预算完成以下验证：

| 样例     | 航点                    | 规划耗时 | 路程       | 几何点数 |
| -------- | ----------------------- | -------- | ---------- | -------- |
| 东海     | `[122,29] → [123,30]`   | 1,092 ms | 160.746 km | 3        |
| 绕台湾   | `[119.5,24] → [123,24]` | 728 ms   | 689.477 km | 5        |
| 跨日期线 | `[179,20] → [-179,20]`  | 1,391 ms | 208.978 km | 3        |

独立 PostGIS 查询确认三个最终折线与完整陆地、本轮生效禁区均无交集；绕台湾样例的起终点直接连线实际穿陆，返回折线成功绕行。脚本 `scripts/route-public-smoke.ts` 将结果与 GeoJSON 写入 `.data/routes/`，任一任务失败或空间校验失败都会以非零状态退出。以上为该验证库的样例实测，部署环境容量与并发表现需按实际资源评估。
