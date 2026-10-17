# 船舶高亮与镜头技能交付核验

## 实现内容

新增 `vessel-highlight`、`map-camera` 内置 Skill，接入可信工具、动态组合技能、任务产物、界面命令及真实回执。前端提供独立高亮图层、三次提醒与持续水波、批量船位刷新、分组清除和统一镜头执行器。接口与操作方法见[使用说明](../agent-map-skills.md)。

数据库迁移 `021` 扩展任务意图与产物类型，并保留内置和动态界面产物的作用域外键。升级顺序为迁移、API／Agent、Web。

## 静态与单元验证

- Contracts、Domain、Infrastructure、Agent、API 和 Web 类型检查已执行通过，最后地图增量使用现有 Nuxt 类型配置复核。
- 已构建 Contracts、Domain、Infrastructure、API、Agent 和 Web；Agent 打包资源检查成功加载七个内置 Skill。
- 定向 ESLint、Prettier 与差异空白检查已通过，按仓库配置保留 LF。
- 最新相关单元测试为 72 个文件、670 次执行通过；命令覆盖 Agent、Domain、Contracts、Web、新船位 API 及界面命令和地图输入测试。新增回归覆盖动画状态与 ISO 时间比较。运行器仍包含既有共享测试导入造成的重复执行，次数用于复现本轮命令结果。

Web 构建保留 MapLibre 大分包、上游模块导出弃用等警告，构建退出码为 0。构建成功只确认产物可生成，服务连通另行验收。

## 浏览器验证

新增用例位于 `tests/e2e/agent-map-skills.spec.ts`，覆盖聚合级别独立高亮、任务组引用隔离、持续动画下热图与航线绘制确认、坐标／缩放／跨日期线聚焦、百船批量刷新、人工清除、刷新释放及手势中断。

同时回归热力图工作台、热力图反馈和历史航线工作台。旧工作台的历史恢复测试补上打开任务详情浮层的操作；原来拦截 `idle` 的测试改为阻塞指定数据源的绘制确认，继续验证人工关闭后迟到回执不会恢复图层。

最终动画及时间比较修正后，四份文件共 16 项浏览器测试再次全部通过，用时约 2 分钟。镜头投影以地图真实状态为准，查询范围的延迟回填保持镜头版本稳定；高亮管理入口已验证让出折叠面板按钮。百船截图验证独立水波图层；本轮没有进行生产规模帧率基准。

本轮浏览器使用真实 MapLibre WebGL 和业务组件，业务 API 由夹具提供。因数据库服务故障，使用被 Git 排除的 `.data/map-skills.playwright.config.ts` 启动独立 Web，浏览器临时结果写入 `D:/CodexTemp/ais-map-validation/test-results`。该结果用于前端行为验收，真实后端端到端验证单独记录。

## 数据库与运行环境

首次数据库集成已执行迁移 `021`。恢复环境后补上真实读取高亮组、按任务序号清除及新鲜度边界测试，以下三个文件的最终 24 项集成全部通过，退出码为 0，用时约 10 秒：

- 地图产物、权限、跨会话清除、镜头恢复、页面新鲜度与心跳恢复：6 项。
- 原 UI 命令与回执兼容：7 项。
- 动态 Skill 与统一产物登记、外键兼容：11 项。

运行中曾出现系统盘空间耗尽，Playwright 返回 `ENOSPC`，Web 进程退出。已将项目可再生 Chromium 缓存搬到 `D:/CodexTemp/ais-map-validation/playwright`，原 `.data/playwright` 通过目录联接继续访问；临时文件转到同一 D 盘验证目录。业务数据库、对象存储、凭据及容器卷均保留。

随后 Docker Desktop 日志显示 Inference manager 初始化失败，`dockerInference` 运行套接字无法访问；常规停止和重启未恢复。清理该套接字的操作被自动审批以“策略阻止”拒绝，操作未执行。Docker 官方问题库已有[同类启动异常记录](https://github.com/docker/desktop-feedback/issues/448)，本机诊断依据仍为实际日志。

用户恢复 Docker 后，已确认 Docker Engine 29.5.3 可用，PostgreSQL、ClickHouse、NATS 和 S3 四项既有容器均健康，容器和数据卷保留。数据库回归在应用启动前执行，测试仅创建和清理随机测试用户的 fixtures。复核命令为：

```powershell
$env:AIS_TEST_SCOPE = 'integration'
node --env-file=.env.local node_modules/vitest/vitest.mjs run packages/infrastructure/agent-map.integration.test.ts packages/infrastructure/agent-ui.integration.test.ts packages/infrastructure/dynamic-skills.integration.test.ts
Remove-Item Env:AIS_TEST_SCOPE
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
```

随后通过 `start.ps1` 启动本地全套服务，日志目录为 `.data/startup-map-skills-final-20261017-224947`。启动后 Web 与 `13100～13110` 共 11 项后台就绪端点均返回 200。日志保留外部情报采集失败与专题任务触发 ClickHouse 内存上限后的重试记录，服务就绪检查与业务运行结果分别判定。

## 真实浏览器补验与故障过程

真实 API、数据库、Agent 和浏览器零 mock 补验发现：MapLibre 6.11 中，混合逐船数据的 `global-state` 动画会不断触发数据源重载，已绘制目标仍无法达到加载完成条件。动画已改为共享 RAF 更新 `feature-state`，保留真实数据源完成及绘制确认门槛。新增百船三次提醒、水波周期与源更新隔离回归。船位时间比较统一使用解析后的时间戳，覆盖 `Z` 与带毫秒 ISO 表达的等时、先后及跨任务合并。

修复后真实位置查询返回 200，以下三条指令均完成，模型调用次数均为 0：

- “高亮 MMSI 413793000 并聚焦”：高亮与镜头两步均取得成功回执。
- “海图放大 1 级”：实际缩放完成。
- “镜头聚焦经度 122.3 纬度 31.5 缩放 8”：实际中心和缩放完成。

“清除任务 1 高亮”在准备阶段返回 `conflict`，尚未下发清除命令。只读核对显示用户、客户端、页面代际及高亮组与原成功产物一致；缺少失败瞬间的心跳样本，暂不能确认具体冲突原因，权限及新鲜度保护保持原状。

随后 C 盘再次耗尽至 0 字节，PostgreSQL 进入恢复状态，整组应用退出；下一轮独占补验因 Web／API 连接拒绝未能发出新任务。当时保留必要验证前的未提交状态。空间恢复后已补测读取真实高亮组的数据库路径、完成真实四步清除闭环，并重跑最新代码的浏览器回归与类型检查；最终结果见下节。

真实回执、截图及原始失败证据保存在 `.data/agent-map-real-verification`；只读心跳采样保存在 `D:/CodexTemp/ais-map-validation/map-ui-freshness-samples.jsonl`。采样期间没有复现清除指令，离线样本不能用于推断清除逻辑有误。

## 空间恢复后的最终复核

用户释放空间后，C 盘可用空间约 24GB。基础组件接口恢复正常，使用与 `start.ps1` 相同的应用入口启动全套服务：

```powershell
node --env-file-if-exists=.env.local --import tsx scripts/workspace.ts demo
```

本次应用父进程为 `17500`，日志目录为 `.data/startup-map-skills-release-20261017-233806`。数据库补验在启动应用 worker 前完成，避免消费者抢占测试任务。

真实浏览器最终四步全部通过：高亮 MMSI `413793000` 并聚焦、放大 1 级、聚焦 `[122.3,31.5]` 并设置缩放 8、清除任务 1 高亮。全部任务模型调用次数为 0；高亮与镜头共 5 条 UI 命令均收到成功回执，实际缩放为 `10 → 11 → 8`。清除后管理入口消失，目标数组及源要素数均为 0，浏览器没有页面错误。

数据库独立复核清除任务约 1.34 秒完成。该会话执行区间的 47 条心跳采样全部保持 fresh／live；清除阶段两条观测年龄约 145ms／307ms。生产权限、10 秒新鲜度及页面隔离规则保持不变，未加入推测性重试。

最终真实结果为 `.data/agent-map-real-verification/results-success-final.json`，另存 `D:/CodexTemp/ais-map-validation/map-real-success-results.json`；最终心跳采样为 `D:/CodexTemp/ais-map-validation/map-ui-freshness-final.jsonl`。历史失败记录继续保留用于定位环境和动画问题。

最终提交前再次构建 Contracts、Domain、Infrastructure、API、Agent 与 Web，全部退出码为 0；打包资源检查加载七个内置 Skill。最新代码的定向 ESLint、Web 与 Infrastructure 类型检查通过，16 项浏览器回归全部通过。构建后复核 `13001/` 与 `13100～13110/ready`，12 个端点均返回 200，应用父进程保持运行。
