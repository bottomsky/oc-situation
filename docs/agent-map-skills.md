# 船舶高亮与海图镜头技能

`vessel-highlight` 和 `map-camera` 将任务关注对象及镜头操作接入现有 Agent 界面命令链路。启用 `AGENT_ENABLED=true`、`AGENT_UI_ENABLED=true` 后，在已登录的海图页面使用；账号私有组合技能还需 `AGENT_DYNAMIC_SKILLS_ENABLED=true`。

## 使用方式

| 指令示例                                | 行为                             |
| --------------------------------------- | -------------------------------- |
| 高亮 MMSI 413793000                     | 标出该船，保持当前镜头           |
| 高亮 MMSI 413793000 并聚焦              | 高亮并移动镜头                   |
| 聚焦 MMSI 413793000，缩放到 8           | 查询真实位置，聚焦并设置缩放     |
| 镜头聚焦经度 122.3 纬度 31.5，缩放到 10 | 聚焦指定坐标                     |
| 海图放大 2 级                           | 在当前镜头基础上提高两个缩放级别 |
| 清除任务 1 高亮                         | 清除管理列表中的对应任务组       |
| 清除全部高亮                            | 清除当前页面全部任务高亮         |

船舶目标支持 MMSI、船名、IMO、呼号、AIS 船型和档案中已登记的型号。查询复用现有船舶筛选器；名称匹配多艘时补充选择，具体型号来自对象元数据。区域船型查询使用明确的区域范围。每页最多高亮 100 艘不同船舶，超限需缩小范围；缺少有效位置的船舶会在结果中说明。

高亮使用明黄 `#FFD84D` 图标及沿图形轮廓扩散的柔光。船舶随有效航向旋转，未知航向使用对称菱形。高亮层独立于普通 AIS 层；缩小海图后，关注船舶仍有独立标识。人工高亮、任务高亮与 AI Focus 对同一实体合并绘制，分别保留各自引用。

首次强调采用统一的 1360ms 时序：在面板和回复卡避让后的可见区内，以短边三分之一为初始尺寸，600ms 收缩至 24px；随后熄灭 120ms，再执行两次“亮 200ms、灭 120ms”。批量目标先展示一个整体大图标，再由各目标分别闪烁两次。结束后保留静态高亮并停止动画帧。系统减少动态效果设置直接展示静态结果，页面隐藏时暂停动画计时，恢复前台后继续剩余阶段。

点高亮由 MapLibre 的单个 `vessel-highlight-marker` symbol 图层绘制，柔光预先写入缓存 glyph 图像。线面高亮与统一选择框、临时强调由 `ChartMapEffects` 绘制。所有强调请求共用一个 RAF 时钟和队列，闪烁阶段按目标切换点图标可见性。坐标刷新和样式恢复复用原请求身份，更新投影与图源；首次强调的生命周期由请求标识管理。

高亮属于本页任务组：同船被多个任务使用时显示一份标记，清除一个组保留其他组的引用。海图“船舶高亮”管理入口支持分组清除及全部清除。任务结束后继续显示，刷新、离开海图或注销时释放。切换 Agent 会话保留本页高亮，后续指令可清除已验证的旧组。

## 船位刷新

前端每 5 秒向 `GET /api/v1/vessels/positions?mmsis=413793000,413793001` 批量读取最新位置。接口沿用 API 认证，最多接受 100 个 MMSI，返回：

```json
{
  "items": [
    {
      "mmsi": "413793000",
      "lon": 122.3,
      "lat": 31.5,
      "observedAt": "2026-10-17T10:00:00Z"
    }
  ],
  "missing": ["413793001"]
}
```

位置有效期沿用最近 30 天，观测时间随位置保留。页面隐藏、暂停更新或没有高亮船舶时停止刷新。刷新失败保留最后位置并显示提示；管理入口的更新时间表示最后成功读取时间。船位刷新只更新坐标数据，保持首次动画标识及命令并发版本稳定。

## 前端接口与回执

共享类型位于 `packages/contracts/agent-map.ts`。`prepare_vessel_highlights`、`prepare_map_camera` 仅生成受校验的业务产物；界面副作用由原有 claim／receipt 通道执行。

| 组件／接口                                      | 职责                                                   |
| ----------------------------------------------- | ------------------------------------------------------ |
| `chart.vessel-highlights` 的 `show`／`close`    | 显示或清除产物指定的高亮组                             |
| `chart.viewport` 的 `focus`                     | 执行可信镜头产物                                       |
| `ChartMapControls.applyCamera(request, signal)` | 统一镜头执行、取消和真实结果返回                       |
| `ChartMapControls.cameraIntent()`               | 在异步查询开始时保留镜头意图，后续人工操作使旧意图失效 |
| `highlightsPresentation`／`cameraPresentation`  | 服务器领取命令时投影的高亮／镜头载荷                   |

镜头请求包含三种模式：`point` 使用 `center` 和 `zoom`；`bounds` 使用 `bbox` 和 `maxZoom`；`current` 使用互斥的 `zoom` 或 `zoomDelta`。经纬度顺序为经度、纬度，缩放范围 0～22。点位默认 zoom 10，区域默认最大 zoom 10，过渡约 800ms。区域包含多船或跨日期变更线时整体适配；面板遮挡参与可见范围计算。

人工拖动、滚轮或触屏接管会中断镜头命令；绘图、框选和未保存几何遵循交互锁。旧轨迹与情报查询返回时，仅仍有效的镜头意图可以定位。失败和中断通过回执报告，Agent 依据实际结果回复。

高亮展示确认对应产物的目标集合及保留组；镜头确认对应命令的实际中心、缩放和范围。热力图、航线和高亮均按对应数据源处理完成后的绘制帧确认，强调动画期间也可完成展示回执。

## 统一效果接口与生命周期

`app/types/mapEffects.ts` 定义效果目标、图标、强调请求、投影范围及动画帧。预设图标覆盖 `vessel`、`alert`、`danger`、`opportunity`，并提供表示未知航向的 `unknown`。目标携带稳定 `key`、几何集合以及可选方向和观测时间；船舶使用 `vessel:<MMSI>` 合并身份，其他对象使用类型、标识和修订版组成的键。

`useChartEffects` 管理唯一选中对象。`select` 接受 `MapEffectTarget | null`，也接受 `{ kind, id, revision?, geometries, ... }` 业务便利输入；直接目标保留原 `key` 和已有业务元数据，无元数据时作为 opaque 对象处理，标准 `vessel:MMSI` 键继续跟随最新合法船位。`select(null)` 与 `clearSelection` 均取消选择并使旧代次失效；`updateSelected` 补齐仍有效的几何，直接目标的键保持稳定，业务便利输入随所选版本更新键。`playAttention` 接受带唯一 `id` 的 `MapAttentionRequest`，`cancelAttention` 取消指定请求或全部请求。`ChartMapEffects` 负责队列播放、可见几何投影和完成通知；页面销毁时释放 RAF、地图监听、媒体查询和尺寸观察器。

搜索、地图点选、业务 SVG 的 Enter、AI 关联对象名称及结论证据入口共用单选状态。船舶和单点使用 44px 四角框，线面使用可见几何边界外 8px 的四角框；描边为 2px 明黄并带深色衬影。关闭详情保留选中，点击地图空白或普通交互下按 Escape 取消选中。模态、详情层级和绘图优先处理 Escape。独立高亮继续按人工和任务引用管理。

## 动态技能与后续事件接入

动态技能可使用两个新工具及 `vessel_highlights`、`map_camera` 产物类型。输入通过 `input.selection` 或前序船舶查询结果引用，沿用宿主工具权限、版本绑定和步骤恢复规则。“查询 → 高亮 → 聚焦”共享查询确定的对象；高亮和镜头分别回执，失败步骤保留真实状态。

未来事件适配器应创建具备用户身份、有效页面绑定与明确目标的任务，并复用本链路。自动事件订阅、目标页面选择、离线投递和镜头打扰规则由事件接入任务实现。

## 升级与验证

发布前执行数据库迁移 `021`，扩展任务意图和产物类型，并为内置与动态 Skill 的界面产物建立统一登记与作用域外键。已有动态产物回填，新增动态产物通过数据库触发器同步登记。随后同步更新 API、Agent 和 Web。回滚应用时先关闭界面控制，保留迁移与历史证据。

定向验证入口：

```powershell
bunx vitest run packages/domain/agent-map.test.ts apps/agent/map-runtime.test.ts apps/api/src/vessels/positions.test.ts apps/web/map-camera.test.ts apps/web/map-source-render.test.ts apps/web/vessel-highlights-map.test.ts apps/web/vessel-highlights-state.test.ts apps/web/map-effects.test.ts apps/web/chart-effects-state.test.ts apps/web/map-effects-seamap.test.ts
bunx playwright test tests/e2e/map-effects.spec.ts tests/e2e/agent-map-skills.spec.ts tests/e2e/vessel-detail-actions.spec.ts tests/e2e/reply-objects.spec.ts tests/e2e/heatmap-ui-feedback.spec.ts
```

数据库集成测试为 `packages/infrastructure/agent-map.integration.test.ts`，与旧 UI、动态 Skill 集成测试一并运行。实际执行结果及环境故障应记入交付报告，测试入口存在本身不等于验证通过。
