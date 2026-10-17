# 账号动态技能

账号动态技能将一次分析流程保存为可复用的声明式程序。Agent 可根据任务目标提出候选，宿主校验通过后自动发布并绑定版本，再在同一任务内顺序执行。船舶清单、历史航线和 AIS 热力图分别保存为步骤产物，任务详情同时显示本次创建和使用的技能版本。

## 启用与账号权限

`AGENT_DYNAMIC_SKILLS_ENABLED=true` 启用私有技能发布、加载和执行，默认值为 `false`。API 与 Agent 工作进程使用一致配置。原有 `AGENT_ENABLED` 与 `AGENT_UI_ENABLED` 分别控制 Agent 运行和受控界面展示。

“智能研判 → 我的技能”对应 `/skills`。目录按当前登录账号隔离：viewer 查阅自己的目录、定义和历史版本；operator 与 admin 管理自己的私有技能。管理员沿用同一所有权约束。写入由全局会话 Guard 校验角色、可信 Origin 和当前会话 CSRF。资源归属从服务端会话取得，跨账号资源统一返回 404。

功能开关关闭后，目录、版本和历史任务继续提供读取；新发布、状态调整、版本切换及动态执行按开关拒绝。

## 使用方式

在海图中确认区域与时间，向 Agent 发送“查询当前区域货船，绘制过去 24 小时航线并显示热力图”。宿主优先发现当前账号的可用技能；缺少组合方法时，由 Pi 提出候选，校验发布后继续当前任务。后续相同目标复用已发布版本，存在多个兼容方法时在补充条件窗口选择具体版本。

“我的技能”可查看自动生成的方法、工具范围与版本，并执行启停或版本切换。API 调用方也可在消息中传 `skillRef: {skillId, version?}` 明确选择方法；具体区域、时间与船舶条件仍由该次任务绑定。方法中的安全船类常量 `vesselClass` 或 `vesselClasses` 保留货船、油轮等用途，多类别按并集处理，再与本次任务筛选范围取交集。型号、船名和 IMO 条件由本地查询解析，所需信息不完整时先补充条件。

## 定义、发布与版本

技能包含中文说明 `body`、参考正文 `references`、必需输入 `requiredInputs`、工具集合 `toolIds` 和有序 `steps`。每步声明稳定 `id`、`toolId`、结构化 `input`，可追加产物类型 `artifactKind` 与白名单展示动作 `ui`。`expectedArtifacts` 和 `requiredDisplays` 由宿主根据步骤校验并固定。

当前可信工具为 `query_vessels`、`query_vessel_tracks`、`query_ais_heatmap` 和 `search_intelligence`。工具权限取宿主目录、版本绑定和执行上下文的交集。动态定义禁止声明脚本、shell、任意 HTTP、MCP 或技能管理工具，正文与参考文件不能扩大宿主授权。

任务参数通过 `$ref` 取得。例如 `{"selection":{"$ref":"input.selection"}}` 引用当前任务输入；`{"vessels":{"$ref":"steps.cargo"}}` 引用已完成 `cargo` 步骤的完整船舶结果。宿主在本地抽取船舶集合供航线、热图使用，模型侧只接收批准的摘要投影。固定区域、时间、船舶标识和凭据禁止嵌入可复用定义。

可复用的船舶类别通过 `query_vessels.input.vesselClass` 声明，当前支持 `cargo`、`tanker`、`passenger`、`fishing`。宿主将类别与本次任务筛选范围取交集；货船组合技能在首步声明 `vesselClass: "cargo"`，后续航线与热图继续引用该步船舶集合。

发布流程校验结构、大小、工具范围、阶段、步骤顺序、引用和展示类型。成功后生成不可变版本、内容摘要和适配器版本，同时推进账号目录修订。每次管理写入携带 UUID `operationId` 与 `expectedCatalogRevision`；重试保持同一操作键，目录冲突返回 409，页面提示刷新并核对后继续。

启停作用于技能，活动版本决定后续未指定版本的加载目标。历史版本可切换为活动版本；撤销保留定义与任务证据，后续加载与执行重新校验撤销状态。在途任务保持原绑定，活动版本切换后按其已绑定版本继续授权检查。

## 任务与多步骤产物

任务使用统一 `skill` 意图，`skillRef` 包含 `skillId` 与可选 `version`。宿主解析当前账号可用目录后绑定确切版本、摘要、适配器版本和工具上限。候选的校验、修正与执行受任务模型／工具预算限制。

目录中存在多个匹配版本时，任务以 `ambiguous_skill` 原因请求补充 `skill` 字段，候选保存在 `request.prefill.skillCandidates`。界面显示技能名称、描述和版本，用户选择后提交精确 `values.skillRef`，服务端按持久候选核对。收起弹窗保留当前草稿，确认后继续同一任务。目标尚不明确时，沿用 `goal` 补问并通过 `purpose` 选择已有任务类型；新增技能以确认后的任务输入和宿主工具范围生成。

组合技能的补问按请求字段渲染。`topic` 展示情报主题与检索类型，首次默认事件检索并保留已有海况类型；`time` 与 `vessel_selector` 分别展示时段和船舶筛选条件。组合流程可直接补充这些字段，保留自身的 `skill` 意图与绑定版本。

每步调用保存任务所有者、输入修订、执行代次、步骤 ID、工具 ID、输入、状态、本地结果、模型投影和产物引用。步骤恢复先查询账本，已完成步骤复用持久产物；未知结果进入对账状态。每次写入复核任务租约、取消状态与输入修订。

任务响应包含 `dynamicSkill` 和 `artifacts`：前者保存绑定版本、创建版本、调用记录，后者按步骤保留多个产物。相同产物类型的不同步骤分别展示，输入条件改变后按输入修订隔离旧结果。当前卡片支持船舶清单／详情、历史航线与热力图；其他持久产物保留记录并沿用已有结果展示入口。

自动海图展示使用带 `stepId`、`artifactRef` 的持久命令。服务端认领时检查任务、账号、技能授权和产物类型，并投影实际航线或热力快照。浏览器只消费服务端投影，回执携带原命令的步骤和产物引用。持久产物缺少投影时拒绝回退旧快照；成功以执行回执及界面后置条件核验。

## 管理接口

所有接口位于 `/api/v1/agent/skills`。

| 方法与路径                             | 功能                             |
| -------------------------------------- | -------------------------------- |
| `GET /`                                | 当前账号目录及 `catalogRevision` |
| `GET /:id`                             | 技能摘要及全部历史版本           |
| `GET /:id/versions/:version`           | 单一不可变版本                   |
| `POST /publish`                        | 自动校验并发布首版或新版本       |
| `PUT /:id/state`                       | 启用／停用技能                   |
| `POST /:id/versions/:version/activate` | 切换活动版本                     |
| `POST /:id/versions/:version/revoke`   | 带原因撤销版本                   |

发布请求包含 `definition` 和可选 `skillId`。所有管理写入包含操作键与目录修订；撤销另需 `reason`。运行时创建技能通过受控宿主端口调用同一发布规则。

## 验证入口与交付记录

单元测试覆盖目录请求竞态、账号切换、写操作重试、版本选择、类型校验、多步骤产物与回执身份；API HTTP 测试通过基础设施替身检查真实会话 Guard、角色、Origin 和 CSRF。仓储事务与真实运行时测试由对应模块提供。

```powershell
bunx vitest run apps/web/skills-state.test.ts apps/web/skill-artifacts.test.ts apps/web/agent-ui-artifacts.test.ts apps/web/navigation.test.ts apps/api/src/agent/skills-controller.test.ts apps/api/src/agent/ui-controller.test.ts
```

浏览器回归用例位于 `tests/e2e/skills-workbench.spec.ts`，使用 API 夹具验证 viewer 只读、发布重试、目录冲突恢复、启停、活动版本、账号切换和同任务多产物。测试结果、真实模型与数据库验证范围以本轮交付报告为准；测试用例存在本身不表示已运行通过。

通用文件目录热刷新、远程 MCP 与独立 SDK 发布继续按[通用 SDK 路线图](agent-sdk-roadmap.md)推进。

历史输入修订通过 `GET /api/v1/agent/tasks/:id?inputRevision=0` 读取，与旧 `resultVersion` 参数互斥；读取不会自动恢复历史图层。当前交付证据见[专项核验报告](reports/agent-dynamic-skills-2026-10-17.md)。
