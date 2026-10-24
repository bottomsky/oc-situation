# 海事底图与态势预测数据

系统以离线版本化 GeoJSON 提供陆地、港口和海标展示，以独立海岸约束支撑船舶预测。地图发布入口为 `/maps/maritime/manifest.json`，覆盖范围为东经 105°—135°、北纬 3°—42°。每次发布先完成版本目录，再原子更新 manifest，前端据此读取同一批资源。

## 工作台操作

在海图选择船舶，打开左侧“航行预测”，使用当前船舶或输入九位 MMSI，执行即时预测。结果提供 15、30、60、120 分钟时间切换，以及“位置概率”和“沿途概率走廊”两个口径；图例说明平滑密度，悬停读取原始网格概率。定位标记优先引用该预测版本实际采用的末报坐标与时间。

点击“关注”加入当前账号的持续分析清单，最多 20 艘；地图全量显示船数单独管理。专题管理页也支持创建两个新专题，并校验固定目标 MMSI。当前预测版本与审核公告相交后，右侧展示影响概率、首次进入时间、条件和证据，可打开原始情报核对。

输入不足、末报陈旧、海岸约束不可用和有效路径过少均显示明确状态。历史结果按固定修订查看，自动更新保留用户正在阅读的历史版本。首次真实使用前，应确认 AIS 采集已恢复、精细计算陆地已激活，并按既有启动方式启动新增预测 worker。

## 已安装资源与来源

| 图层     | 来源与处理                                                                                                                                                 | 展示用途与精度                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 陆地     | [OSM land polygons](https://osmdata.openstreetmap.de/data/land-polygons.html) 的 simplified complete 3857 ZIP，转换为 WGS84，并用 Shapely 精确裁切覆盖范围 | 官方建议缩放级别 0—9；保留源数据中的岛屿，小岛与局部岸线可能受简化影响 |
| 港口     | Overpass 查询 `harbour=yes/port`、`landuse=port`、`industrial=port`、`seamark:type=harbour`，保留 OSM 标签与标识                                           | node 使用原始位置，way/relation 使用几何中心；中心点用于港口标注       |
| 海标     | Overpass 查询 `seamark:type`；资源状态、实际条数及失败原因由 manifest 给出                                                                                 | 覆盖程度取决于 OSM 贡献；节点采集模式会记录在执行参数中                |
| 水深     | 接入经过准备的 GEBCO 或有许可的水深资源后发布                                                                                                              | 当前 manifest 如实记录安装状态                                         |
| 官方海图 | 由具备许可的 ENC 提供方配置                                                                                                                                | 当前入口状态为 `unconfigured`                                          |

OSM 数据采用 ODbL 1.0，展示署名为 `© OpenStreetMap contributors`，链接至 [OSM 版权和许可](https://www.openstreetmap.org/copyright)。manifest 和版本目录的 `metadata.json` 保存资源 URL、来源、许可、数据时间、获取时间、发布文件 SHA256、原文 SHA256、记录数与精度说明。Overpass 原文随版本保存在 `ports.source.json` 或 `seamarks.source.json`；陆地 ZIP 缓存在 `.data/maritime/`，其来源校验文件紧邻 ZIP。

所有展示层均带 `displayOnly: true`。禁止将这些简化底图、社区海标和模型输出用于实船导航、避碰或替代正式航海资料。

## 重新获取并发布

准备 Python 转换环境后，使用 Bun 运行发布工具。Python 依赖仅用于离线坐标转换与裁切，环境放在已忽略的 `.data/` 中。

```powershell
python -m venv .data/maritime/python
& .data/maritime/python/Scripts/python.exe -m pip install pyshp==2.3.1 shapely==2.1.2

bun scripts/prepare-maritime-map.ts `
  --version=osm-cn-20261024-new `
  --download=true `
  --python=.data/maritime/python/Scripts/python.exe `
  --overpass=true
```

陆地下载上限为 40 MiB，单次下载最多 180 秒。2026 年 10 月 24 日实际下载的简化陆地 ZIP 为 24,452,838 字节，服务器修改时间为 2026 年 10 月 23 日 03:43:11 UTC。Overpass 单层响应上限为 16 MiB、单次请求最多 60 秒，默认最多尝试两个服务端。服务繁忙、无记录或响应不完整时，对应图层发布为 `unavailable`，其他成功资源照常提供。

覆盖 bbox 固定为 `[105,3,135,42]`。陆地标准 GeoJSON 输入应已完成裁切；工具会校验坐标范围、闭合环和图层几何类型。点资源按覆盖范围过滤。版本名称仅允许字母、数字、点、横线和下划线，并校验路径穿越。已存在的版本目录保持不可变。

| 参数                                                      | 用途                                             |
| --------------------------------------------------------- | ------------------------------------------------ |
| `--version=<name>`                                        | 必填，新版本名称                                 |
| `--output=<directory>`                                    | 发布根目录，默认 `apps/web/public/maps/maritime` |
| `--cache=<directory>`                                     | 原始文件缓存，默认 `.data/maritime`              |
| `--land=<file>`、`--ports=<file>`、`--seamarks=<file>`    | 读取已准备的标准 GeoJSON                         |
| `--land-url=<https-url>` 等                               | 下载相应标准 GeoJSON，支持同样校验               |
| `--land-zip=<file>`                                       | 使用已缓存的官方简化 3857 ZIP                    |
| `--land-source=<https-url>`、`--land-modified=<ISO-time>` | 指定缓存 ZIP 的来源和服务器修改时间              |
| `--python=<executable>`                                   | 选择已安装 pyshp、Shapely 的 Python              |
| `--overpass=true`                                         | 获取尚未指定的港口、海标层                       |
| `--overpass-url=<https-url>`                              | 指定单个 Overpass 服务                           |
| `--ports-overpass=<file>`、`--seamarks-overpass=<file>`   | 重放原始 Overpass JSON，重新计算原文校验值       |
| `--ports-source=<url>`、`--seamarks-source=<url>`         | 为重放原文记录实际来源                           |
| `--seamarks-nodes=true`                                   | 仅采集海标节点，减少公共服务的查询负担           |

常规更新选择一个新版本名称。前端从 manifest 读取 `status`、`url`、`license`、`attribution`、`sourceDataTime` 和 `coverageNote`；缺少图层时按状态展示说明。公共 Overpass 的使用约束见 [官方服务清单](https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances)。

## 预测模型与概率口径

预测要求最近 60 分钟至少三个有效观测时刻，末报距预测时刻最多 10 分钟。方向优先使用 COG，缺少 COG 时由有效轨迹推导。艏向保留为输入证据，运动模拟采用对地运动方向。

每次预测以固定默认 seed 20261024 生成 2048 条路径，按一分钟步长模拟至 120 分钟。近期速度、加减速和转向估计与历史残差共同决定扰动；输出记录残差来源和样本数。停船状态保持当前位置，并明确提示离泊时机需要后续模型评估。末报早于预测时刻时，完整路径同时包含末报至预测起点的外推线段，供海岸检查统一处理。

海岸约束通过一次异步 `checkPaths(paths)` 批量注入，判定对象为每条路径的全部连续线段。有效路径少于 1024 条时，状态为 `model_not_applicable`，对应概率层为空。缺少海岸检查时同样标记模型不适用；诊断路径与诊断网格用于分析模型行为，正式界面仅展示 `ready` 状态的概率层。

概率条件是“整条 120 分钟路径通过海岸检查”。15、30、60、120 分钟的输出分别包含：

- 时刻位置概率格：每条路径在该时刻落入一个格子，各格概率之和为 1。
- 沿途经过概率格：按完整线段穿越格网，每条路径对同一格至多贡献一次，表示截至该时刻至少经过一次的概率。
- 50%、80%、95% 累计覆盖区：按时刻概率从高到低累积格子，以嵌套的 GeoJSON MultiPolygon 表示。实际累计概率随离散格子记录。

格网尺寸根据预测距离自适应，范围为 200—5000 米。覆盖区保留格网形态，岸线附近的格子仍有显示分辨率误差。地图格网与真实路径分开输出，API 面向前端返回 summary，完整路径用于后端公告影响和回测。

校准状态固定为 `uncalibrated`。输出中的蒙特卡洛标准误和公告 Wilson 95% 区间描述抽样误差，预测准确率与真实覆盖率由独立航次回测评估。

## 航行警告影响

参与计算的公告须审核为 `confirmed`，具有明确正长度生效时段、Polygon/MultiPolygon 和适用船舶条件。适用条件支持全部船舶、MMSI 清单或船型清单。缺项、审核未完成或不适用记录均返回明确跳过原因。

计算沿完整路径线段进行，并裁剪至预测时刻和公告生效时间的交集。即使线段两端均在区域外，穿越区域也会计为命中。每条路径每条公告最多计一次，结果包括影响概率、首次进入时间范围、命中数、有效样本数和 Wilson 区间；零次命中仍有非零上界。公告到期时刻按区间右端开区间处理。

公告只用于计算基础预测之后的影响，基础运动模型保留自己的轨迹分布。

## 真实航次回测

纯函数入口为 `packages/domain/reachability-backtest.ts` 的 `runReachabilityBacktest`，离线命令入口为 `scripts/reachability-backtest.ts`。输入为 JSON 数组或 `{ "voyages": [...] }`。每个航次包含 `voyageId`、`mmsi`、`forecastAt`、`observations`，可附 `shipType` 和经审核的 `warnings`。观测字段为 `observedAt`、`longitude`、`latitude`，可附 `speedOverGround`、`courseOverGround`、`heading`。

```powershell
bun scripts/reachability-backtest.ts `
  --input=.data/backtest/real-voyages.json `
  --split-at=2026-10-01T00:00:00Z `
  --land=.data/backtest/verified-land.geojson `
  --coverage=105,3,135,42 `
  --land-version=verified-coast-20261001 `
  --land-quality=verified_coastline `
  --output=.data/backtest/report.json
```

海岸输入需具备与评估区域匹配的精度和覆盖范围。命令为海岸线建立空间索引，批量校验路径的整段穿陆情况；超出已知覆盖范围的路径按未通过处理。简化展示目录的资源会被拒绝用于此入口。未提供海岸文件时，报告明确返回 `model_not_applicable` 与 `landConstraint: unavailable`。

训练航次的全部观测需早于分界时刻，测试航次的全部观测需位于分界之后；跨界航次被列入排除清单，同一航次标识重复会报错。测试时仅使用 `forecastAt` 及之前的观测生成预测，真实后续轨迹用于评分。真值插值限制相邻观测间隔在 15 分钟以内，公告评分同时检查真实轨迹完整性。

报告保留每个航次、每个预测时刻的误差、匀速匀向基线误差、格网多类别 Brier 分数、50%/80%/95% 经验覆盖与覆盖面积，以及公告命中正样本、负样本及 Brier 分数。报告同时记录训练/测试/排除航次、海岸版本、覆盖范围和输入校验值。样本量不足和缺少真实后续位置均作为跳过原因保留。

完成真实 AIS 数据回放并形成独立校准评估后，再评估模型参数和概率校准方案。单元测试与合成轨迹用于验证算法行为，实际预测效果以真实航次报告为准。

## 验证入口

工程检查沿用 `bun run test`、`bun run typecheck`、`bun run lint`、`bun run build` 与 `bun run deployment:check`。预测数据库和计算执行链可通过 `bun run test:integration:isolated packages/infrastructure/predictions.integration.test.ts` 独立验证。

五万合成船位与双概率视图的浏览器验收入口如下。硬件模式使用 Windows D3D11；其他环境可使用软件模式验证功能，并分别记录性能结果。

```powershell
bun --no-env-file run --filter @ais/web build
$env:MARITIME_COMPILED = '1'
$env:MARITIME_RENDERER = 'hardware'
bunx playwright test --config apps/web/playwright.maritime.config.ts
```

本轮环境、真实数据覆盖、独立回放可用性与已知问题见[交付验证报告](reports/maritime-gis-delivery-2026-10-24.md)。
