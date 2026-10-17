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

高亮首次显示感叹号及三次约 600ms 的光圈，然后持续约 2 秒一轮的水波。高亮层独立于普通 AIS 聚合层；缩小海图后，关注船舶仍有独立标识。未知航向使用圆环标记。系统减少动态效果设置下采用静态光圈。

地图内部由共享 RAF 驱动 `feature-state` 更新光圈半径和透明度，坐标变化才更新 GeoJSON。动画与数据源加载相互独立，持续水波期间仍可完成图层绘制确认。

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

高亮展示确认对应产物的目标集合及保留组；镜头确认对应命令的实际中心、缩放和范围。热力图、航线和高亮均按对应数据源处理完成后的绘制帧确认，持续动画期间也可完成展示回执。

## 动态技能与后续事件接入

动态技能可使用两个新工具及 `vessel_highlights`、`map_camera` 产物类型。输入通过 `input.selection` 或前序船舶查询结果引用，沿用宿主工具权限、版本绑定和步骤恢复规则。“查询 → 高亮 → 聚焦”共享查询确定的对象；高亮和镜头分别回执，失败步骤保留真实状态。

未来事件适配器应创建具备用户身份、有效页面绑定与明确目标的任务，并复用本链路。自动事件订阅、目标页面选择、离线投递和镜头打扰规则由事件接入任务实现。

## 升级与验证

发布前执行数据库迁移 `021`，扩展任务意图和产物类型，并为内置与动态 Skill 的界面产物建立统一登记与作用域外键。已有动态产物回填，新增动态产物通过数据库触发器同步登记。随后同步更新 API、Agent 和 Web。回滚应用时先关闭界面控制，保留迁移与历史证据。

定向验证入口：

```powershell
bunx vitest run packages/domain/agent-map.test.ts apps/agent/map-runtime.test.ts apps/api/src/vessels/positions.test.ts apps/web/map-camera.test.ts apps/web/map-source-render.test.ts apps/web/vessel-highlights-map.test.ts apps/web/vessel-highlights-state.test.ts
bunx playwright test tests/e2e/agent-map-skills.spec.ts tests/e2e/heatmap-ui-feedback.spec.ts
```

数据库集成测试为 `packages/infrastructure/agent-map.integration.test.ts`，与旧 UI、动态 Skill 集成测试一并运行。实际执行结果及环境故障应记入交付报告，测试入口存在本身不等于验证通过。
