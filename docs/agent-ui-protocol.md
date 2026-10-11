# 智能体业务界面协议

## 状态与适用范围

本协议版本为 `1.0`，形成于 2026-10-11，状态为**已确定设计、待代码实现**。本文定义智能体读取业务界面状态、查询受控数据、请求界面操作和接收执行结果的边界。当前仓库已有分析会话、地图和情报编辑能力；本文新增的注册表、命令账本、确认中心与通知记录均属于后续实现内容。

实现顺序和文件责任见[界面控制实施计划](superpowers/plans/2026-10-11-agent-ui-control.md)。两份文档共同约束后续实现；接口和状态语义以本文为准，开发分工与验证步骤以实施计划为准。

启用条件为现有 `AGENT_ENABLED=true` 且新增 `AGENT_UI_ENABLED=true`；后者默认 `false`。关闭 UI 开关时停止领取与执行，保留已存在记录的授权读取和核对。

业务组件通过描述符注册能力。智能体只接触固定工具、业务引用和受控参数；Vue 实例、DOM 选择器、任意 JavaScript、任意 HTTP 地址以及通用属性写入均禁止暴露。新增组件接入时提交描述符、运行时校验、权限规则、执行器、状态投影和契约测试。

## 当前源码与适配位置

| 已核对源码                                             | 当前行为                                                                          | 后续适配要求                                                               |
| ------------------------------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `packages/contracts/agent.ts`                          | 定义会话、消息、任务、事件；任务已有 `generation`、`resultVersion`                | 新增本文契约；区分任务代次与页面代次                                       |
| `apps/api/src/agent/controller.ts`                     | 会话按当前用户读取；提交消息使用 `Idempotency-Key`；事件按游标补取                | 增加 UI 子路由和独立命令幂等账本，复用身份与所有权校验                     |
| `packages/infrastructure/agent.ts`                     | 持久化分析任务与事件，worker 租约及 generation 隔离迟到结果                       | 补充确认等待、命令审计与恢复事务                                           |
| `apps/agent/gateway.ts`                                | 本地有限意图分类，模型只收安全投影；`V1`、`E1` 当前由结果顺序生成                 | 扩展有限 UI 槽位，持久化带作用域的引用映射                                 |
| `apps/agent/runtime.ts`                                | 工具顺序执行，分析运行默认超时 180 秒                                             | UI 确认等待持久化并释放 worker；确认后以续作恢复                           |
| `apps/web/app/composables/useAgentConversation.ts`     | 本地 generation 管理会话切换，维护分析事件游标                                    | 单独维护客户端、页面代次、命令发现和事件恢复游标                           |
| `apps/web/app/composables/useChartWorkspace.ts`        | 提供船舶查询、选中、轨迹和回放状态                                                | 增加业务适配器与独立轨迹临时展示状态                                       |
| `apps/web/app/composables/useIntelligenceWorkspace.ts` | `select(id)` 默认调用 `add`；`add/hide/remove/clear` 经 `persist` 写入 `plot-set` | 详情读取使用 `select(id, false)`；临时展示走独立状态，持久展示另行确认     |
| `apps/web/app/pages/index.vue`                         | `locateIntelligence` 先 `add`；面板开关 watcher 写入 `localStorage`               | 临时定位与面板覆盖态分离，人工默认偏好独立保存                             |
| `apps/web/app/components/SeaMap.client.vue`            | 轨迹 watcher 执行 `flyTo`，证据 watcher 执行 `fitBounds`；TerraDraw 管理人工绘图  | 展示数据和移动视野分开，智能体临时 GeoJSON 使用独立 source/layer           |
| `apps/web/app/components/IntelligenceDetail.vue`       | geometry watcher 写人工关系草稿，`save` 创建或修订情报关系                        | 新增候选草稿缓冲和具体预览；覆盖、保存分别受确认约束                       |
| `apps/api/src/intelligence/controller.ts`              | 已有关系、地理对象、plot 与 plot-set 接口及操作权限                               | 先从 controller 与 intelligence-store 提取统一事务服务，再供命令执行器调用 |

现有按钮和函数存在业务持久化、移动视野及偏好写入等副作用，适配器接入前逐项分离。将现有方法直接注册为“展示”命令会产生超出指令的写入。

## 身份、作用域与状态权威

| 标识                    | 来源与生命周期                     | 校验职责                                            |
| ----------------------- | ---------------------------------- | --------------------------------------------------- |
| `userId`                | 认证层生成，接口请求体不能指定身份 | 每次读取、提交、领取、确认和执行重新鉴权            |
| `sessionId`             | 已有分析会话 UUID                  | 校验会话归属，关联完整问答与操作记录                |
| `clientInstanceId`      | 每次页面挂载生成 UUID              | 标识实际执行页面；刷新生成新值                      |
| `pageGeneration`        | 同一实例内递增正整数               | 会话切换、工作区重建时推进，拦截迟到命令和结果      |
| `taskId/taskGeneration` | 已有分析任务及服务端执行代次       | 隔离任务取消、重跑和旧 worker；独立于浏览器生命周期 |
| `resultVersion`         | 已有任务结果版本                   | 固定匿名引用的解析集合                              |
| `componentVersion`      | 浏览器业务适配器维护               | 仅在相关选择、视野、图层覆盖或草稿变化时递增        |
| `targetVersion`         | 业务对象当前版本                   | 保存时执行乐观并发检查                              |

浏览器是当前视野、选中项、活动面板、临时图层、人工草稿及交互锁的权威来源。后台保存带观测时间的镜像，用于规划、审计和预检；执行器在产生副作用前再次读取权威状态。业务对象、权限、命令结果和确认记录由后台权威维护。

组件在未挂载、正在拖拽、编辑中、来源数据过期等情况下上报 `availability` 和阻塞原因。后台镜像超过 10 秒未更新时标为 `stale`，`ui.get_state` 返回补取提示；涉及变化的操作先取得新状态。AIS 数据更新记入 `observedAt/dataVersion`，只改变显示内容的更新不推进操作冲突版本。地图拖动、人工选择和草稿编辑立即推进各自版本。

首次进入海图且尚无分析会话时，以 sessionId=null 注册账号范围客户端。账号命令的 taskId/taskGeneration/resultVersion/executionGeneration 均为 null，仅允许构建时登记的用户动作；模型命令必须具备完整 task scope。同一用户可有多个客户端；会话发起端确定命令目标。目标有歧义时要求用户选择当前页面。关闭页面、注销、离开海图或会话切换使旧绑定失效；新页面通过重新注册建立新绑定，禁止自动接管旧实例命令。

## 业务组件能力目录

下表是首期目标能力。每项能力通过契约、权限、执行器和副作用隔离验证后，才以 `available` 注册。表内标识是业务名称，不绑定 Vue 组件名。

| `componentId`         | 状态投影                         | 注册动作                                                                             | 主要执行位置               |
| --------------------- | -------------------------------- | ------------------------------------------------------------------------------------ | -------------------------- |
| `chart.viewport`      | 视野版本、区域引用、人工交互锁   | `focus`                                                                              | 浏览器                     |
| `chart.layers`        | 业务图层、会话覆盖态             | `set_visibility`                                                                     | 浏览器                     |
| `chart.selection`     | 当前对象引用及选择版本           | `select`                                                                             | 浏览器                     |
| `chart.presentation`  | 临时展示集合及数据版本           | `show_vessel`、`show_track`、`show_intelligence`、`show_geometry`、`remove`、`clear` | 浏览器                     |
| `workspace.panels`    | 活动业务面板、临时开关           | `open`                                                                               | 浏览器                     |
| `intelligence.draft`  | 草稿标识、版本、是否有人工内容   | `preview`、`apply`、`save`                                                           | 浏览器预览与应用；后台保存 |
| `agent.conversation`  | 会话、消息引用、当前回复浮卡     | `show_reply`、`hide_reply`                                                           | 浏览器                     |
| `agent.notifications` | 事件引用、严重度、已读与关闭状态 | `show_event`、`dismiss`、`details`、`locate`、`start_conversation`                   | 本地业务动作与后台记录     |

`follow`、`like` 暂无对应业务服务，列入后续扩展。服务与权限、回执、记录全部接通前，能力目录和界面均不显示可用按钮。任意路由跳转、删除业务数据、审核结论和系统配置变更进入另行评估。

## 类型草案

以下 TypeScript 描述领域结构。实现时以 Zod strict schema 为运行时入口，动作参数使用按 `componentId + action` 区分的联合类型，拒绝未知字段；`Record` 仅用于本草案压缩展示。

```typescript
type Id = string;
type Version = number;
type SafeValue = string | number | boolean | null | SafeValue[] | { [key: string]: SafeValue };
type CommandStatus =
  | 'queued'
  | 'awaiting_confirmation'
  | 'claimed'
  | 'executing'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'unknown';
type Scope = { clientInstanceId: Id; pageGeneration: number } & (
  | { kind: 'task'; sessionId: Id; taskId: Id; taskGeneration: number; resultVersion: Version }
  | { kind: 'account'; sessionId: null; taskId: null; taskGeneration: null; resultVersion: null }
);
interface ComponentDescriptor {
  protocolVersion: '1.0';
  componentId: string;
  capabilityVersion: Version;
  actions: Array<{
    name: string;
    parameterSchemaId: string;
    resultSchemaId: string;
    effect: 'read' | 'temporary' | 'draft' | 'persistent';
    confirmation: 'never' | 'when_overwriting' | 'always';
    permission: string;
    allowedActors: Array<'agent' | 'user'>;
  }>;
  stateSchemaId: string;
}
interface ComponentState {
  componentId: string;
  componentVersion: Version;
  mounted: boolean;
  opened: boolean;
  visible: boolean;
  observedAt: string;
  availability: 'ready' | 'busy' | 'unmounted' | 'stale';
  blockedReason: string | null;
  dataVersion: string | null;
  projection: Record<string, SafeValue>;
}
interface DataReference {
  ref: string;
  kind:
    | 'vessel'
    | 'track'
    | 'intelligence'
    | 'evidence'
    | 'geometry'
    | 'target'
    | 'draft'
    | 'presentation'
    | 'event'
    | 'message'
    | 'time-range';
  scope:
    | { type: 'task'; sessionId: Id; taskId: Id; resultVersion: Version }
    | { type: 'notification'; notificationId: Id; revision: number };
  expiresAt: string;
}
interface UiCommand {
  protocolVersion: '1.0';
  commandId: Id;
  scope: Scope;
  executionGeneration: number | null; // task 为执行 fence；account 为 null
  componentId: string;
  action: string;
  params: Record<string, SafeValue>;
  expectedVersions: Record<string, Version>;
  dependsOn: Id[];
  paramsHash: string;
  createdAt: string;
  expiresAt: string;
}
interface CommandReceipt {
  receiptId: Id;
  commandId: Id;
  clientInstanceId: Id;
  pageGeneration: number;
  claimToken: string;
  sequence: number;
  status: 'executing' | 'succeeded' | 'partial' | 'failed' | 'rejected' | 'cancelled' | 'unknown';
  completedAt: string | null;
  itemResults: Array<{ itemId: string; status: string; code: string | null }>;
  resultingVersions: Record<string, Version>;
  result: Record<string, SafeValue>;
  error: { code: string; messageKey: string; retryable: boolean } | null;
}
interface UiEvent {
  eventId: Id;
  revision: number;
  cursor: string;
  sessionId: Id | null;
  taskId: Id | null;
  commandId: Id | null;
  messageId: Id | null;
  type: string;
  severity: 'info' | 'warning' | 'critical';
  occurredAt: string;
  payload: Record<string, SafeValue>;
}
```

UUID 用于实体标识；版本为非负安全整数；时间采用 UTC ISO 8601；游标采用十进制字符串，禁止转为 JavaScript `number`。`Scope` 由受信网关注入，模型调用不能覆写。DataReference 的 userId 由后台认证上下文绑定；notification 作用域仅用于无会话通知的 N 引用，转对话时创建新的 task 作用域映射，并保留原事件与 revision 关联。mounted/opened/visible 分别表达挂载、逻辑展开与实际显示；折叠面板可以 mounted=true、opened=false、visible=false。对外模型投影移除实际 UUID、时间、地理坐标等本地字段，仅保留授权匿名引用和必要枚举。

`paramsHash` 对验证后的动作参数计算 SHA-256：递归按 Unicode 键序排列对象，保留数组顺序，时间先规范到 UTC，拒绝非有限数值和 `undefined`，采用无空白 UTF-8 JSON。同一规则写入契约测试。幂等账本另比对 scope、动作、前置版本及依赖列表，防止同一 commandId 改换目标。

## 工具与动作输入输出

### 固定工具

| 工具                   | 输入                                                         | 成功输出                                        | 失败处理                                 |
| ---------------------- | ------------------------------------------------------------ | ----------------------------------------------- | ---------------------------------------- |
| `ui.list_capabilities` | 可选 `componentIds`                                          | `protocolVersion`、可用描述符及受控阻塞原因     | 无活动实例返回 `NO_ACTIVE_CLIENT`        |
| `ui.get_state`         | `componentIds`、可选 `maxAgeMs`，上限 10000                  | 组件状态安全投影及相关版本                      | 过期返回 `STATE_STALE` 并请求本地补取    |
| `ui.query_data`        | `kind`、`refs`、可选 `timeRangeRef`、`limit`，1～100         | 匿名 `DataReference`、数量、覆盖状态、`limited` | 歧义、缺失及过期分别补问                 |
| `ui.execute`           | `componentId`、`action`、严格参数、预期版本、`dependsOnRefs` | `commandRef`、当前状态、安全确认摘要            | 持久排队后返回；禁止把 accepted 当作完成 |
| `ui.get_command`       | `commandRef`                                                 | 当前状态、逐项结果、安全回执、可选确认状态      | 始终按当前用户与会话核验                 |

模型工具使用网关发放的 C1/C2 等 `commandRef` 和 `dependsOnRefs`。commandId UUID 由网关在接收工具调用时生成，并按持久工具调用标识映射；相同调用重试复用原 UUID，模型不能指定或生成幂等 ID。内部服务和 HTTP 仍使用 commandId，`ui.get_command` 将 commandRef 在本地解析后查询。确认 UUID 仅进入本地界面，模型只获得等待确认状态。

工具只有授权运行时可调用；浏览器通过下文 HTTP 通道交换状态、命令和回执。`ui.query_data` 的 `kind` 首期限定 `vessel/track/intelligence/evidence/geometry/target`，只查询本地已授权服务。模型传入 SQL、URL、文件路径、坐标字符串或任意查询表达式均返回 `INVALID_ARGUMENT`。

### 具体动作

以下输入为 `params` 字段；引用均先在本地解析，浏览器可以收到真实数据，外部模型只能收到安全投影。每个动作输出均进入 `result`，共同错误码见下一节。

| 动作                                     | 输入                                                                                  | 输出与执行语义                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `chart.viewport.focus`                   | `{ "targetRef": "V1", "fit": "contain" }`，fit 为 contain/center                      | `{ "focused": true }`；独立检查视野版本与人工拖动锁                                    |
| `chart.layers.set_visibility`            | `{ "layer": "tracks", "visible": true }`，layer 为 ais/tracks/evidence/intelligence   | 返回当前可见性；只写会话覆盖态                                                         |
| `chart.selection.select`                 | `{ "targetRef": "V1" }`                                                               | 返回选中引用；移动视野另发 focus                                                       |
| `chart.presentation.show_vessel`         | `{ "vesselRef": "V1" }`                                                               | `{ "presentationRef": "P1", "featureCount": 1 }`；使用本地最新允许船位并标记观测时间   |
| `chart.presentation.show_track`          | `{ "trackRef": "T1" }`                                                                | 展示引用、分段数、点数；沿用本地轨迹分段，跨日期变更线保持分段                         |
| `chart.presentation.show_intelligence`   | `{ "intelligenceRefs": ["I1"] }`，最多 20 个                                          | 展示引用、逐项 featureCount 与缺位置原因；临时图层按会话隔离                           |
| `chart.presentation.show_geometry`       | `{ "geometryRef": "G1", "style": "analysis" }`                                        | 展示引用及要素数；style 仅 analysis/highlight，禁止外部资源地址                        |
| `chart.presentation.remove`              | `{ "presentationRefs": ["P1"] }`                                                      | 逐项移除结果；限定当前会话临时集合                                                     |
| `chart.presentation.clear`               | `{ "scope": "session" }`                                                              | `{ "removedCount": 2 }`；清理当前会话临时集合                                          |
| `workspace.panels.open`                  | `{ "panel": "intelligence" }`，panel 为 vessel/intelligence/chat/notifications/tasks  | 返回活动面板；人工偏好保持独立                                                         |
| `intelligence.draft.preview`             | `{ "geometryRef": "G1", "targetRef": "B1", "mode": "create" }`，mode 为 create/update | 返回 draftRef、draftVersion、targetVersion、字段差异摘要与确认需求；保存在候选草稿缓冲 |
| `intelligence.draft.apply`               | `{ "draftRef": "D1" }`                                                                | 返回已应用版本；检测人工草稿，存在覆盖则等待具体预览确认                               |
| `intelligence.draft.save`                | `{ "draftRef": "D1", "targetRef": "B1" }`                                             | 始终确认；后台返回业务对象引用与新版本，浏览器随后刷新详情                             |
| `agent.conversation.show_reply`          | `{ "messageId": "本地消息UUID" }`                                                     | 当前浮卡关联该已持久化消息；工具网关只接收匿名消息引用并解析                           |
| `agent.conversation.hide_reply`          | `{ "messageId": "本地消息UUID" }`                                                     | 隐藏浮卡；消息和操作记录保留                                                           |
| `agent.notifications.show_event`         | `{ "eventRef": "N1" }`                                                                | 读取已持久化事件投影并显示；不能由模型编造严重事件                                     |
| `agent.notifications.dismiss`            | `{ "eventRef": "N1" }`                                                                | 关闭当前提醒并保存关闭状态                                                             |
| `agent.notifications.details`            | `{ "eventRef": "N1" }`                                                                | 用户动作；返回已授权事件只读详情，不创建分析会话                                       |
| `agent.notifications.locate`             | `{ "eventRef": "N1" }`                                                                | 用户动作；解析本地几何并临时定位，返回 focused；无几何返回具体缺失原因                 |
| `agent.notifications.start_conversation` | `{ "eventRef": "N1" }`                                                                | 用户点击后创建或选择会话，绑定事件上下文，返回 sessionId                               |

`show_reply/hide_reply/start_conversation` 中需要用户手势的入口由本地交互触发，并按相同业务契约记账。注册描述符标记调用主体，模型工具目录过滤仅供用户操作的能力。事件转对话必须由用户显式点击或明确提出问答请求。

临时点、线、面由本地确定性构造器生成：首期支持显式坐标点、显式折线/闭合环、本地船位点、本地轨迹线和本地已有情报几何。用户输入先通过范围、坐标顺序、点数和拓扑检查，再生成 `geometryRef`。经纬度采用 WGS84 `[lon, lat]`；多边形闭环，拒绝自交和退化环，跨日期变更线按既有地理契约拆分。首期每次至多 20 个要素、每个 5000 个坐标、总 JSON 1 MiB，超限返回 `LIMIT_EXCEEDED`。

生成推测航线、推测禁航区或随意补全缺失位置进入补问流程。对象没有位置时明确回报缺失，不能用默认坐标绘图。候选草稿持久化目标限定已有情报事件下的关系，或明确选择的地理对象创建/修订流程；缺少业务归属返回 `TARGET_REQUIRED`，要求用户选择目标。

### 错误契约

HTTP 错误体统一为 `{ "error": { "code": "STATE_CONFLICT", "messageKey": "ui.state_changed", "retryable": false }, "requestId": "本地请求UUID" }`。模型只获得固定错误码、受控补问槽位和 retryable，不接收异常堆栈、数据库错误、原始参数或上游原文。

| 错误码                                                          | HTTP      | 处理                                   |
| --------------------------------------------------------------- | --------- | -------------------------------------- |
| `INVALID_ARGUMENT` / `LIMIT_EXCEEDED`                           | 400 / 413 | 修正指定槽位，服务端拒绝排队           |
| `UNAUTHENTICATED` / `FORBIDDEN`                                 | 401 / 403 | 停止执行；撤销未使用确认               |
| `NOT_FOUND` / `CAPABILITY_UNAVAILABLE`                          | 404 / 409 | 重查目录；其他用户实体统一 NOT_FOUND   |
| `NO_ACTIVE_CLIENT` / `CLIENT_EXPIRED`                           | 409       | 引导回到海图并绑定页面                 |
| `STATE_STALE` / `STATE_CONFLICT` / `DRAFT_CONFLICT`             | 409       | 读取新状态、展示差异，重新规划或确认   |
| `REFERENCE_EXPIRED` / `REFERENCE_AMBIGUOUS` / `TARGET_REQUIRED` | 409       | 本地补问；禁止猜测引用                 |
| `TASK_FENCED` / `PAGE_FENCED`                                   | 409       | 终止旧代次命令并停止依赖               |
| `IDEMPOTENCY_CONFLICT` / `DEPENDENCY_FAILED`                    | 409       | 返回原记录或停止依赖，禁止替换原命令   |
| `CONFIRMATION_EXPIRED` / `CONFIRMATION_CONSUMED`                | 409       | 重新预览，创建新命令或读取原结果       |
| `USER_BUSY` / `USER_INTERRUPTED`                                | 409       | 人工优先；释放交互锁，报告已完成项     |
| `EXECUTION_UNKNOWN`                                             | 202       | 查账核对，状态保持 unknown             |
| `RATE_LIMITED` / `SERVICE_UNAVAILABLE`                          | 429 / 503 | 遵循 Retry-After，仅重试查询或同键提交 |

## HTTP 与持久化通道

全部路径位于 `/api/v1/agent/ui`，复用现有认证 guard。状态与回执通道属于经认证的业务通道，采用同源凭据和仓库既有 CSRF 防护约定；实现前核验防护覆盖。模型供应商无权直接访问这些接口。

| 方法及子路径                                   | 请求要点                                                                             | 响应及职责                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `POST /clients`                                | protocolVersion、clientInstanceId、pageGeneration、sessionId（可 null）、descriptors | 201：clientId、leaseUntil、stateRequired；描述符只能是构建时白名单子集     |
| `PUT /clients/:id/heartbeat`                   | pageGeneration、sessionId、lastStateSequence                                         | 200：leaseUntil；每 10 秒，租约 30 秒                                      |
| `PUT /clients/:id/binding`                     | expectedPageGeneration、sessionId（可 null）                                         | 200：CAS 绑定新会话并推进 pageGeneration；撤销旧命令执行资格、清理旧临时态 |
| `DELETE /clients/:id`                          | 当前页面代次                                                                         | 204：撤销绑定；未送达关闭由租约补偿                                        |
| `PUT /clients/:id/state`                       | pageGeneration、stateSequence、components                                            | 200：acceptedSequence；完整组件投影、按组件比较版本，拒绝倒退              |
| `POST /actions`                                | actionKey、已有资源引用、clientInstanceId、pageGeneration、requestId                 | 202：普通用户界面动作的受控请求；哈希、身份和命令模板由后台生成            |
| `GET /clients/:id/commands?cursor=0&limit=100` | 页代次随认证客户端上下文校验                                                         | 200：items、nextCursor；仅发现命令元数据，历史记录不能触发执行             |
| `POST /commands/:id/claim`                     | clientInstanceId、pageGeneration                                                     | 200：claimToken、claimExpiresAt、完整命令；原子领取，有效期 30 秒          |
| `POST /commands/:id/receipts`                  | CommandReceipt                                                                       | 200：已接受序列与命令状态；同 receiptId 同内容幂等                         |
| `GET /commands/:id`                            | 命令 UUID                                                                            | 200：命令状态、逐项结果、确认摘要；按归属过滤                              |
| `POST /confirmations/:id/decision`             | decision 为 approve/reject，previewHash、draftVersion、targetVersion                 | 200：已记录决定及命令状态；认证 UI 用户提交，模型不可代替                  |
| `GET /sessions/:id/events?cursor=0&limit=100`  | 持久游标，limit 1～200                                                               | 200：UiEvent 列表、nextCursor；按游标稳定排序                              |
| `GET /sessions/:id/snapshot`                   | 会话 UUID                                                                            | 200：消息关联、命令/确认摘要、通知关联及 snapshotCursor                    |
| `GET /notifications?cursor=0&limit=100`        | 当前用户通知流                                                                       | 200：包含独立事件的持久通知列表与 nextCursor                               |
| `POST /notifications/:id/read`                 | revision、read、dismissed                                                            | 200：通知状态；关闭与已读分别记录                                          |

`ui.execute` 直接调用后台 `UiCommandService.create`，首期不公开通用 `POST /commands`。普通界面按钮通过 `POST /actions` 提交构建时枚举的 actionKey（reply.hide、notification.dismiss、notification.details、notification.locate、notification.start_conversation、presentation.redisplay）及资源引用，使用当前用户会话凭据；前端不持有服务凭据。服务端检查用户、资源归属及模板权限后，生成命令或完成通知关联。无会话事件转问答先创建/选择会话，再调用既有消息提交服务，按 requestId 去重并以事务保存事件关联。notification.details 和 notification.locate 由服务端鉴权解析事件引用，分别打开只读详情和当前实例临时定位；无需先建立 AI 会话，定位仍检查视野版本与人工交互锁。account scope 仅接受 notification 系列用户动作；回复隐藏和历史再次展示要求对应完整会话上下文。账号临时图层按 clientInstanceId+pageGeneration 隔离，绑定会话、退出或刷新时清除。后续建立或切换会话调用 binding，以 expectedPageGeneration 比较更新并推进代次，心跳只续租当前绑定，不能暗中切换会话。模型不能调用此用户动作入口。

每 2500 毫秒轮询命令发现与事件；同一路轮询串行，失败按 2.5/5/10/30 秒退避并加入抖动。恢复后先刷新状态和绑定，随后补取事件。后台分页有更多项时连续补取，空页保持游标；只有完成本地处理的持久记录才推进游标。客户端另维护未完成 commandId 集合，每轮用 `GET /commands/:id` 核对；快照包含未完成集合，防止发现游标推进后漏查。已失效、终止或 unknown 的记录只能核对，禁止通过补取重新执行。

快照响应与 snapshotCursor 来自一致读边界。客户端先恢复快照，再补取该游标之后事件；历史补取只更新记录和展示状态，禁止据此执行命令。命令发现另持游标，执行资格始终来自原子 claim。浏览器时钟仅用于展示，租约、到期和确认窗口以服务端时间判断。

推荐新增客户端、命令、回执、确认、UI 事件、数据引用和通知表。唯一键至少包括 `(user_id, command_id)`、`receipt_id`、`(command_id, sequence)`、`(user_id, event_id, revision)`；命令事件与状态变更同事务落库。命令、回执、确认及 UI 事件随所属会话长期保留，首期无自动清理；会话删除走后续统一保留策略。无会话通知按用户长期保留，接入保留策略前同样无自动清理。

## 命令、确认与恢复状态机

### 命令执行

普通临时命令走 `queued → claimed → executing → succeeded`。人工冲突、权限变更或代次失效进入 `rejected`；执行错误进入 `failed`；执行前到期进入 `expired`；用户取消进入 `cancelled`。复合操作包含独立 commandId，按 dependsOn 排序；前项 partial/failed/rejected/unknown 时停止后续依赖。

领取必须同时检查用户、作用域绑定、页面代次、能力及依赖；task scope 另检查任务与执行代次，account scope 检查仅用户动作白名单。客户端取得 claimToken 后，在副作用前持久提交 executing 回执，后台确认接受后才执行。领取 30 秒内未进入 executing 的命令可以由同一有效实例重新领取；已进入 executing 的超时命令标为 unknown，并进入核对流程，禁止自动盲重投。

执行窗口默认 30 秒；超时、断线或回执缺失不能推断未执行。对临时显示核对浏览器 commandId 执行账本及当前状态；页面已消失则保留 unknown 并说明显示结果无法确认。对持久保存通过 `GET /commands/:id` 驱动数据库 commandId 与业务写入版本核对，确定提交结果后再结束命令。晚到回执可用于核对，不能绕过被撤销页面的权限。

人工交互优先：拖动地图时 focus 返回 USER_BUSY；命令执行过程中发生人工选择或编辑，立即取消尚未产生副作用的后续步骤。已经完成的临时动作逐项记录；成功保存的业务数据保持提交结果，由用户使用业务修订流程处理。取消不是撤销事务。批次返回 partial 时列明每项 outcome，禁止把整体描述为成功。

### 确认与业务写入

草稿覆盖或保存走 `awaiting_confirmation → queued → executing → succeeded`。确认状态单独采用 pending/approved/consumed/rejected/expired；pending 有效期 5 分钟。后台保存 `confirmationId/userId/commandId/paramsHash/previewHash/targetVersion/draftVersion/expiresAt`，并绑定任务、会话和目标客户端。预览列出目标名称、变更字段、几何来源、创建/修订模式与影响范围。

用户点击确认后，decision 事务再次检查身份与权限、目标版本、草稿版本、页面绑定、任务有效性和到期时间，仅以 CAS 将 pending→approved 并排队续作，不消费业务写入资格。已有 approved/consumed 的重复 decision 返回当前决定与命令结果。批准时为同一 commandId 设置 approvedAt 和 30 秒领取截止时间；截止前未领取则确认与命令均 expired，需重新预览。领取后有独立 30 秒执行窗口：未进入 executing 即超时则 expired；已进入 executing 超时则 unknown 并查账，确认保持 approved 待核对，禁止重新排队写入。保存命令使用数据库执行器。首期从 `packages/infrastructure/intelligence-store.ts` 的 `writeRelation/writeGeoObject` 及 controller 中的鉴权、审核和 audit 逻辑提取统一事务服务；最终 save 事务重新鉴权并检查版本，将 approved→consumed、业务版本比较、幂等写入记录、业务写入与最终状态在同一事务提交；事务失败整体回滚，冲突使该命令 rejected 并终止旧批准资格。界面更新通过提交后的持久事件驱动。浏览器成功回执不得充当业务保存成功证据。

预览后人工修改草稿、目标被其他用户修订、参数变化或页面切换，旧确认失效并返回具体冲突。确认拒绝使确认与命令进入 rejected；pending 到期使两者 expired。save 事务已提交但响应丢失时，GET 命令结果返回原成功记录；重试决定不能再次写入。`apply` 的覆盖确认与 `save` 的业务确认分别对应各自命令和预览，不跨动作复用。

等待确认时持久化续作上下文，分析任务增加 `awaiting_confirmation` 状态并释放 worker 租约。确认后调度续作，重新校验任务代次和剩余预算，沿用同一 commandId。

命令 `scope.taskGeneration` 仅作为不可变的创建代次审计身份，`executionGeneration` 作为当前执行 fence。每次挂起时持久化本次 `pauseGeneration=current task.generation`。确认通过的事务以任务仍为 awaiting_confirmation 且 generation=pauseGeneration 为 CAS 条件，将任务置为 queued 并生成绑定本次挂起及待执行 commandId 集合的一次性 resume 授权。`claimAgentTask` 同事务锁定任务、resume 授权和相关命令，CAS pauseGeneration→pauseGeneration+1，设置新 worker，并只将尚未执行命令的当前 executionGeneration 从 pauseGeneration 迁移到 pauseGeneration+1，同时消费 resume 授权、记录代次迁移事件。下一次挂起重新捕获 pauseGeneration，禁止用固定的 scope.taskGeneration 判断续作资格。

确认摘要绑定初始 scope，参数与预览哈希排除可变 executionGeneration；有效预览保持成立。执行器与回写检查当前 executionGeneration、worker 和任务 generation，旧 worker 仍被隔离。已 executing/unknown 的命令只核对结果，不能通过代次迁移重启。取消或重跑会改变状态或代次，使上述 CAS 失败；后续 worker 再领取时也只能对未执行命令建立受审计的续作迁移。用户等待时间不计入现有 180 秒运行窗口，续作拥有独立运行窗口且累计模型/工具预算保持原账本。

## 临时展示与双通道反馈

智能体展示采用按 sessionId 隔离的 GeoJSON source/layer，覆盖船位、轨迹、已有情报和临时点线面。会话切换、刷新、离开页面时清除临时集合。历史记录保留说明和引用，用户主动“再次展示”才创建新命令；引用过期则重新查询并确认上下文。

临时展示与临时面板开关禁止写入 `plot-set` 或 `localStorage` 默认偏好。人工 TerraDraw 缓冲负责用户正在编辑的几何，智能体候选几何使用独立缓冲。数据展示默认保持当前视野，定位通过独立 focus 动作和独立版本检查完成。

回复浮卡与右侧完整问答共用 messageId，同一时间显示当前一条回复浮卡。新回复到达后替换当前浮卡；关闭仅隐藏，完整问答和操作记录继续保留。点击浮卡进入同一消息上下文，执行状态沿用命令账本，不能复制生成第二条回答。

事件提醒使用 `(eventId, revision)` 去重，按严重度 critical/warning/info 降序、同级 occurredAt 降序排列。事件标题、事实、来源与操作记录保存在通知中心。普通 info 默认 10 秒隐藏，warning/critical 持续至用户关闭；悬停或键盘聚焦暂停隐藏计时，移开后继续剩余时长。关闭不删除通知，恢复历史不重新弹出已关闭版本。

独立事件在 sessionId 为空时进入用户通知记录；用户发起问答后才建立会话关联，并形成可追溯的引用消息。事件更新保持同 eventId、递增 revision，新版本可以按严重度重新提醒。事件来源正文属于不可信业务数据，不能直接转为工具指令。

首期通知生产接入 `packages/infrastructure/topics.ts` 已有 `readAnalysisFeed/analysis_feed`，采用 `sourceType=analysis_result + resultId` 稳定映射事件 UUID，revision 沿用来源结果版本。当前分析结果没有严重等级，生产投影固定 severity=info；warning/critical 保留协议和测试能力，后续有受信严重度来源才接入，禁止交给模型判断。withdrawn 更新同 eventId 的新 revision 与撤回状态，保留既往记录，界面标明撤回。

通知读取 service 触发幂等读模型物化：按已鉴权用户及当前分析结果读取权限投影 feed，首次账号订阅以已提交稳定序列为起点，复用现有 feed 提交序列锁取得高水位，防止较小序列晚提交造成漏读。通知写入与该用户源游标推进同事务；通知展示游标独立于源游标。权限不足的条目受控跳过，读取记录时重新鉴权。离线重连补齐已有订阅游标之后的记录，历史补取标记 replay，只更新通知列表并保持已关闭状态。该投影器复用现有结果，不新增分析算法、外部凭据或模型调用。

## 本地意图绑定与数据外发

首期新增有限意图槽位：`show_vessel`、`show_track`、`show_intelligence`、`focus`、`set_layer_visibility`、`open_panel`、`preview_geometry`、`apply_draft`、`save_draft`。现有分析、解释和总结意图继续由本地分类器处理；无法唯一匹配时进入补问，不把整段用户原文交给外部模型猜测。

消息提交入口先在本地分类 `ui/analysis/mixed`，再判断步骤所需上下文。现有 `submitAgentMessage` 的“无 bbox 即 awaiting_input”以及 runtime 的统一区域前置条件需要拆到分析步骤；纯 UI 任务可在没有分析区域时定位已选情报、隐藏图层或展示已知对象。混合任务分别检查每步条件，已有条件的 UI 操作可完成，缺区域的分析步骤持久化补问及依赖状态。输入模糊时补问动作类型，禁止为通过分析入口伪造 bbox。

本地流程依次完成：解析动作与候选对象；用本地服务查到真实标识、时间范围和几何；核验权限与唯一性；把映射绑定 userId/sessionId/taskId/resultVersion；生成安全工具输入。模型只获得 V/T/I/E/G/B/D/P/N/M/R/C 等匿名引用、动作枚举、计数和固定覆盖状态。`DataReference` 的 expiresAt 首期为创建后 30 分钟，并受本地数据保留期和权限撤销的更早限制。

同名船舶、过期结果、跨会话引用、缺失保存目标和含糊时间范围均由本地界面补问。`V1` 在不同任务中的含义可以不同，因此禁止脱离完整作用域解析。引用映射持久化在本地后台，引用过期后历史记录仍可读，执行需要生成新引用。

每条模型请求、每次工具结果、异常、重试、日志转摘要和模型最终文本均经过严格外发白名单。真实 MMSI、船名、坐标、精确时间、原始情报、草稿正文、凭据、claimToken 与确认内容仅在本地业务通道使用。未知字段直接拒绝；模型响应必须验证动作枚举及引用归属，渲染时转义文本。用户明确给出的坐标同样只交本地构造器。

## 交互示例

以下均为虚构协议样例，展示有效 JSON，属于本地工具网关解析后的测试记录。网关已将 C1/C2 等 commandRef 解析为 commandId，并把 dependsOnRefs 解析为 dependsOn；模型实际接收匿名命令引用。为控制篇幅，Scope、executionGeneration、创建时间、过期时间和哈希由本地网关补齐；JSON 中 request/response 是测试记录容器。

### 展示船舶轨迹并定位

用户在已有结果中要求“显示 V1 最近已选时间段的轨迹并定位”。本地解析固定时间范围为 R1，查轨迹得到 T1；网关解析后的本地记录如下。

```json
[
  {
    "tool": "ui.get_state",
    "request": { "componentIds": ["chart.presentation", "chart.viewport"] },
    "response": { "versions": { "chart.presentation": 3, "chart.viewport": 8 }, "ready": true }
  },
  {
    "tool": "ui.query_data",
    "request": { "kind": "track", "refs": ["V1"], "timeRangeRef": "R1", "limit": 1 },
    "response": {
      "refs": ["T1"],
      "segments": 2,
      "points": 36,
      "coverage": "available",
      "limited": false
    }
  },
  {
    "tool": "ui.execute",
    "request": {
      "commandId": "3d742ed1-960f-4a1a-8d05-a57fa4790001",
      "componentId": "chart.presentation",
      "action": "show_track",
      "params": { "trackRef": "T1" },
      "expectedVersions": { "chart.presentation": 3 },
      "dependsOn": []
    },
    "response": { "commandId": "3d742ed1-960f-4a1a-8d05-a57fa4790001", "status": "queued" }
  },
  {
    "tool": "ui.get_command",
    "request": { "commandId": "3d742ed1-960f-4a1a-8d05-a57fa4790001" },
    "response": {
      "status": "succeeded",
      "result": { "presentationRef": "P1", "segments": 2, "points": 36 }
    }
  },
  {
    "tool": "ui.execute",
    "request": {
      "commandId": "3d742ed1-960f-4a1a-8d05-a57fa4790002",
      "componentId": "chart.viewport",
      "action": "focus",
      "params": { "targetRef": "T1", "fit": "contain" },
      "expectedVersions": { "chart.viewport": 8 },
      "dependsOn": ["3d742ed1-960f-4a1a-8d05-a57fa4790001"]
    },
    "response": { "status": "queued" }
  },
  {
    "tool": "ui.get_command",
    "request": { "commandId": "3d742ed1-960f-4a1a-8d05-a57fa4790002" },
    "response": { "status": "succeeded", "result": { "focused": true } }
  }
]
```

浏览器执行前提交 executing 回执，完成后提交 succeeded。回复“轨迹已展示并定位”须等两个成功回执；若定位期间发生人工拖动，第二条返回 USER_INTERRUPTED，回复改为“轨迹已展示，视野保持你当前的操作结果”。

### 独立事件进入通知并转为问答

以下为本地 HTTP 与 UI 事件记录，真实业务正文留在本地。事件出现时未建立分析会话；用户点击“就此提问”后才使用现有会话和消息接口，再绑定事件。

```json
{
  "receivedEvent": {
    "eventId": "728506ba-186b-45bb-b015-f81d4af50001",
    "revision": 2,
    "cursor": "1042",
    "sessionId": null,
    "taskId": null,
    "commandId": null,
    "messageId": null,
    "type": "notification.created",
    "severity": "info",
    "occurredAt": "2026-10-11T02:00:00.000Z",
    "payload": { "eventRef": "N1", "title": "关注区域出现新的规则匹配结果" }
  },
  "userAction": {
    "componentId": "agent.notifications",
    "action": "start_conversation",
    "params": { "eventRef": "N1" }
  },
  "result": {
    "sessionId": "8e3142e2-e615-4472-80a3-d6be1f1c0001",
    "messageId": "a19c43d4-6062-43bb-85c3-de262b700001"
  },
  "linkedEvent": {
    "eventId": "a1741d5e-d743-4a35-ae45-533789c90001",
    "revision": 1,
    "cursor": "1043",
    "sessionId": "8e3142e2-e615-4472-80a3-d6be1f1c0001",
    "taskId": null,
    "commandId": null,
    "messageId": "a19c43d4-6062-43bb-85c3-de262b700001",
    "type": "notification.conversation_linked",
    "severity": "info",
    "occurredAt": "2026-10-11T02:01:00.000Z",
    "payload": { "sourceEventRef": "N1", "sourceRevision": 2 }
  },
  "reply": {
    "messageId": "3ddf909e-269c-41da-a1fb-b6efb8fa0001",
    "floating": true,
    "historyVisible": true
  },
  "closeReply": {
    "messageId": "3ddf909e-269c-41da-a1fb-b6efb8fa0001",
    "floating": false,
    "historyVisible": true
  }
}
```

重复补取 cursor 1042 时按 eventId+revision 合并，原已关闭提醒保持关闭。随后更新到 revision 3 才视为新版本；关联事件由新 eventId 记录，保留原通知身份。

### 几何草稿预览、确认及保存

用户要求把已生成 G1 保存为选定情报事件的一条关系。本地已确认目标 B1、关系种类和依据，候选草稿 D1 与人工编辑缓冲独立。以下为本地事务记录，previewHash 是规范化预览内容的 SHA-256 示例值。

```json
{
  "preview": {
    "tool": "ui.execute",
    "request": {
      "commandId": "1281592d-b7a9-4d12-9e45-bec6137d0001",
      "componentId": "intelligence.draft",
      "action": "preview",
      "params": { "geometryRef": "G1", "targetRef": "B1", "mode": "create" },
      "expectedVersions": { "intelligence.draft": 4 },
      "dependsOn": []
    },
    "result": {
      "draftRef": "D1",
      "draftVersion": 5,
      "targetVersion": 12,
      "changedFields": ["geometry", "basis"],
      "status": "succeeded"
    }
  },
  "save": {
    "tool": "ui.execute",
    "request": {
      "commandId": "1281592d-b7a9-4d12-9e45-bec6137d0002",
      "componentId": "intelligence.draft",
      "action": "save",
      "params": { "draftRef": "D1", "targetRef": "B1" },
      "expectedVersions": { "intelligence.draft": 5, "B1": 12 },
      "dependsOn": ["1281592d-b7a9-4d12-9e45-bec6137d0001"]
    },
    "response": {
      "status": "awaiting_confirmation",
      "confirmationId": "bb2a7318-b7a6-4a98-ab1e-1c62b6c30001",
      "expiresAt": "2026-10-11T02:10:00.000Z"
    }
  },
  "decision": {
    "method": "POST",
    "path": "/api/v1/agent/ui/confirmations/bb2a7318-b7a6-4a98-ab1e-1c62b6c30001/decision",
    "body": {
      "decision": "approve",
      "previewHash": "f27ae57d7d22e3d5abc3d0bbab0196f62691598fa3a8187762cae23aed4af421",
      "draftVersion": 5,
      "targetVersion": 12
    }
  },
  "completion": {
    "commandId": "1281592d-b7a9-4d12-9e45-bec6137d0002",
    "status": "succeeded",
    "result": { "businessRef": "B2", "revision": 1, "targetVersion": 13, "draftVersion": 5 }
  },
  "duplicateDecision": { "status": "succeeded", "alreadyConsumed": true, "businessRef": "B2" }
}
```

用户看到实际目标与字段差异后点击确认。后台以同一事务验证目标版本 12 并写入；如果目标已经变为 13，返回 STATE_CONFLICT，保留 D1 并重新预览。如果用户还要求将 D1 覆盖到现有人工草稿，则额外执行 apply 覆盖确认，不能借用本次 save 确认。

## 安全、可靠性与验收

| 验收场景                                        | 必须观察到的结果                                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 首次无分析会话进入海图、通知详情与定位          | 账号客户端正常注册，用户操作可执行，后续 CAS 绑定会话并失效旧代次                            |
| feed 新增、修订、撤回及离线恢复                 | 同源事件 UUID 稳定、revision 正确，首期 info，通知与源游标原子推进，历史无重弹               |
| pending 到期、approved 领取过期、提交后回执丢失 | 各阶段状态准确；业务写入与 consumed 同事务，重复 decision 返回原结果                         |
| 未注册能力、未知参数或注入 JavaScript/URL       | 契约层拒绝，执行器零调用                                                                     |
| 跨用户/会话/任务结果版本的引用                  | 拒绝解析，模型结果无真实标识泄露                                                             |
| 相同 commandId 重试同参数                       | 同一账本结果，副作用一次；改参数返回 IDEMPOTENCY_CONFLICT                                    |
| 同一确认并发提交、重复回调                      | 一次性消费，一条业务写入记录                                                                 |
| 预览后人工编辑或其他用户修订                    | 旧确认失效，显示新差异，人工内容保持完整                                                     |
| 无 bbox 的纯 UI 与混合请求                      | 纯 UI 正常进入执行；分析步骤按条件补问，操作记录分项完整                                     |
| 连续两次挂起确认、批量顺序保存                  | 每次捕获新的 pauseGeneration，第二次批准和续作成功；每条保存仅提交一次，旧 worker 持续被隔离 |
| 确认后新 worker 领取与旧 worker 回写并发        | resume CAS 仅成功一次，未执行命令迁移 fence，原确认有效且旧回写被拒绝                        |
| 确认等待超过 180 秒且小于 5 分钟                | worker 已释放，确认后可恢复续作                                                              |
| 页面刷新、跨会话、过期租约或旧任务回调          | 旧命令失效，新实例零自动接管                                                                 |
| 命令领取后断网与 executing 后断网               | 前者按领取租约处理；后者 unknown 查账，无盲重投                                              |
| 快照恢复、重复事件、历史补取                    | 游标无缺口，通知去重，历史命令零执行                                                         |
| AIS 高频更新时切换图层                          | 仅相关操作版本参与检查，普通数据更新不造成冲突风暴                                           |
| 自动定位与人工拖拽相遇                          | 人工优先，已完成展示保留，依赖动作停止                                                       |
| 临时情报展示、面板打开及几何生成                | plot-set/localStorage 无写入，TerraDraw 人工草稿无变化                                       |
| 会话切换、退出、历史再次展示                    | 临时图层清除；主动再次展示走新命令与新引用检查                                               |
| 缺坐标、空轨迹、跨日期变更线                    | 分别显示缺失原因、空结果与正确分段，禁止默认位置                                             |
| 多条回复与事件同时到达                          | 回复当前一条且 messageId 一致；事件按严重度和时间排列                                        |
| 普通提醒计时、悬停、键盘聚焦                    | 10 秒隐藏，交互期间暂停，高级提醒持续至关闭                                                  |
| 外部模型请求、错误、重试与日志摘要扫描          | 仅白名单内容，原文、真实标识及令牌零外发                                                     |

验证分为契约测试、服务端事务与权限集成测试、浏览器适配器测试和端到端交互测试。端到端需覆盖一次临时展示、一条独立事件转会话、一次人工草稿覆盖冲突和一次确认保存断线核对。完成上述验证后再开放能力注册；当前文档通过排版与示例检查只证明设计文本可读，不代表协议已实现或业务流程已验证。

## 参考与演进

[MCP 工具概念](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)用于理解固定工具及输入输出边界，[AG-UI 事件概念](https://docs.ag-ui.com/concepts/events)用于理解交互事件流。本文定义项目内 HTTP 协议，不声明与这两种协议兼容。首期按持久游标轮询落地；后续可在相同命令、事件与确认语义上增加推送传输，并保持历史恢复和幂等规则。
