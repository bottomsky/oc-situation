# 海图覆盖与裁切边界修复实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复全球视图仅显示中国近海小矩形、覆盖外陆地消失及裁切框被描成海岸线的问题。

**Architecture:** 全球 Natural Earth 概略背景始终作为独立底层；中国近海使用独立陆地填充和海岸线图层，海岸线生成时剔除资源裁切边。区域海水覆盖与区域细节仅在所需资源成功载入后一起启用，失败时保留完整全球背景。资源采用新版本发布，保留原始来源时间与旧版本；本次修复保持现有缩放精度声明，多级精细瓦片另行补齐。

**Tech Stack:** MapLibre、Nuxt/Vue、TypeScript、Bun、GeoJSON、Vitest、Playwright。

## 共享边界

- manifest 增加可选 `coastline` 资源，结构沿用 `land` 的状态、URL、来源、许可、覆盖、缩放和校验值。产物为 LineString／MultiLineString GeoJSON。
- 全球概略陆地保留 `/maps/ne_110m_land.geojson`。区域图层使用独立 source／layer ID，覆盖框负责资源范围，海岸线负责真实边界。
- 区域资源缺失、出错或旧 manifest 缺少独立海岸线时，全球背景与 AIS 持续显示。
- 数据线独占 `scripts/prepare-maritime-map.ts`、对应测试、`apps/web/public/maps/maritime/**`；界面线独占 `apps/web/**`（排除 public 地图资源）与相关浏览器测试。主会话负责文档、审查、最终验证与提交。

## 数据修复

- [x] 为裁切矩形边、保留真实海岸、闭环、多多边形与空结果编写失败测试，并观察失败。
- [x] 从陆地环提取连续海岸线，剔除位于覆盖框四边的线段，保留原始陆地坐标。
- [x] 发布新的不可变资源版本，保存来源、派生关系与校验值；复核实际产物中不存在人工裁切长边。

## 地图修复

- [x] 为全球背景保留、区域图层分离、资源失败回退及深浅主题编写失败测试，并观察失败。
- [x] 修正 style 与资源就绪流程；区域填充和海岸线使用独立资源，主题切换同步更新各底图层。
- [x] 保留 AIS、航迹、证据与地图实例；旧 manifest 和区域资源失败时保持全球地理参考。

## 集成验收

- [x] 在独立端口运行修复版，核验全球视图、北纬 42°和东经 135°附近、中国沿海、浅深主题及资源失败截图；收尾检测原服务退出后，按用户明确授权使用原入口恢复运行。
- [x] 运行相关单测、类型、lint、格式及生产构建，复验浏览器图层绘制与显隐。
- [x] 独立审查差异与截图，记录数据精度限制；本次作为完整逻辑单元提交，当前实例使用开发模式加载新代码，恢复后的登录、资源和 worker 健康单独核验。

最终结果与运行限制见[修复验证报告](../reports/chart-coverage-fix-2026-10-24.md)。
