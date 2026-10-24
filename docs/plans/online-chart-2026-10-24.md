# OSM 在线矢量底图与 OpenSeaMap 接入计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 按用户已确认的近期方案，默认接入公开 OSM 矢量底图与 OpenSeaMap 海标，保留 AIS、航迹、预测及现有本地背景回退。

**Architecture:** 使用可配置的 Shortbread v1 TileJSON 与独立海标 raster source。在线底图含全视口背景与同组矢量图层，透明预热、当前视口实际就绪后共同显示，失败时共同回退；海标独立失败和重试。通过 MapLibre 公开协议接口保留真实 HTTPS 请求与正常缓存，显式识别失败，解决库将矢量 404 转为空瓦片的问题。人工重试只替换对应在线 source 与其图层，并使用新代次 ID；全部业务 source、Map 与相机实例保留。MapLibre 6.11.2 省略 glyphs 时使用本地字体，首期只使用填充、线和文字，保持第三方依赖集中于两个已确认图源。

**Tech Stack:** Nuxt、Vue、MapLibre GL JS 6.11.2、TypeScript、Bun、Vitest、Playwright。

## 已确认来源

- OSM：`https://vector.openstreetmap.org/shortbread_v1/tilejson.json`，真实元数据为 XYZ、原生缩放 0—14，更高缩放采用 overzoom。关键 source-layer 为 `ocean`、`water_polygons`、`water_lines`、`land`、`streets`、`buildings`、`boundaries`、`place_labels`、`boundary_labels`、`pier_lines`、`pier_polygons`。
- OpenSeaMap：`https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png`，256 像素透明 XYZ；客户端保守配置最大级别 18，实际社区覆盖按当前数据展示。
- OSM 页面署名包含 OpenStreetMap contributors；海标署名包含 OpenSeaMap contributors 和 CC BY-SA 2.0。图源规则见 [OSMF 矢量政策](https://operations.osmfoundation.org/policies/vector/)及 [OpenSeaMap FAQ](https://www.openseamap.org/index.php?L=1&id=faq)。
- 使用标准浏览器 Referer／User-Agent 与正常 HTTP 缓存，按视口获取；保留可替换 URL，自动化验证以本地合成瓦片为主，真实公共图源只做一个中国沿海代表视口的受控验收。

## 文件与共享接口

- 样式线独占 `apps/web/app/utils/onlineChartStyle.ts`、`apps/web/online-chart-style.test.ts`、`apps/web/nuxt.config.ts`、`apps/web/package.json`；配置示例由主会话维护。
- 生命周期线独占 `apps/web/app/utils/onlineChartState.ts`、`onlineChartRequests.ts`、对应单测、`SeaMap.client.vue`、相关浏览器测试及 fixture；保留现有区域状态机与 `chartPresentation.ts`。
- 两条线共用 `OnlineChartConfig`：`enabled`、`vectorTileJsonUrl`、`seamarksEnabled`、`seamarkTilesUrl`。Nuxt public 默认键为 `chartOnlineEnabled`、`chartVectorTileJsonUrl`、`chartSeamarksEnabled`、`chartSeamarkTilesUrl`；默认全部启用，URL 使用上述官方源。
- 样式模块导出规范化配置函数、`addOnlineChartStyle(base, theme, config)`、`applyOnlineChartTheme(map, theme)`、在线矢量／海标 source ID 和底图各图层 opacity 描述表。描述表记录 layer ID、paint 属性与 ready 值，生命周期复用以保证原子显隐。
- 在线层顺序：现有全球／区域回退 → 在线全视口底色与矢量细节 → 本地港口等海事标识与在线海标 → AIS／航迹／预测／证据。业务图层继续由既有入口注册。

## 样式与配置

- [x] 先编写失败测试，验证真实 Shortbread layer 名、默认图源、配置关闭／无效值、深浅样式、当地字体与完整署名。
- [x] 实现在线样式：海洋、水系、土地覆盖、道路、建筑、边界、城镇／行政区文字及码头，按实际 schema 和级别控制密度。
- [x] Nuxt runtime 配置支持替换兼容 Shortbread v1 URL及独立关闭在线／海标；新增测试纳入现有 Web Bun 入口。

## 生命周期与页面

- [x] 先编写失败测试，覆盖成功、延迟、源错误、迟到事件、移动／缩放、关闭、重试和卸载。
- [x] 在线底图以 opacity 0 预热，等待当前视口 source 实际加载及 render 后共同启用；记录 source error，防 errored tile 被误认成功。海标独立管理，失败只影响海标。
- [x] 对持续 pending、没有 error 的加载设置有限等待；人工重试开启新一轮，旧轮计时器和迟到事件保持隔离，移动期间正确协调等待。
- [x] 在公开协议请求层识别非成功 HTTP 响应，TileJSON 保持并重写同作用域瓦片地址，保留缓存与取消信号；每轮 source ID 独立，回归全矢量 404、混合成功／失败及旧轮迟到错误。
- [x] 初始样式装配与 theme paint 更新保持地图及业务 source；合并本地／在线状态，常显图源署名，提供有界人工重试。
- [x] 调整原本地底图验收为明确关闭在线的回退场景，保留原实绘、显隐、焦点与地图实例断言；新增在线成功与故障验收。

## 整体验证与交付

- [x] 检查当前用户服务和启动配置，隔离目录／缓存执行生产构建；QA 使用独立配置和端口，不操作用户现有浏览器和数据。常规 Playwright 服务默认关闭公共在线源，Web 禁止自动复用用户实例；在线专属 fixture 显式启用并拦截全部外部瓦片。
- [x] 本地模拟瓦片验证在线样式、中文文字、深浅切换、底图与海标独立失败、重试、关闭和业务层持续绘制；单个真实中国沿海视口验证 MVT／海标请求与实际显示，记录覆盖限制。
- [x] 单测、类型、lint、格式、构建及相关浏览器回归通过；独立审查规格与质量，修正发现。
- [x] 核验当前 13001 可加载新图源、API与预测 worker 正常，若进程意外退出按用户此前明确授权恢复；按完整功能单元提交并交付。

最终验收结果与已知限制见[在线图源验证报告](../reports/online-chart-2026-10-24.md)。
