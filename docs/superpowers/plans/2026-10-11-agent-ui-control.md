# 智能体界面控制首期实施计划

> **执行要求：**后续实现使用 `superpowers:subagent-driven-development`；子智能体不可用时使用 `superpowers:executing-plans`。以下未勾选任务均为后续代码工作。

**目标：**让研判智能体通过可审计命令控制海图临时展示、呈现回复与事件提醒，并在用户确认后保存具备业务归属的几何对象。

**架构：**沿用现有 HTTP、持久事件游标与 2500ms 轮询。服务端负责身份、命令、确认、版本和业务事务，浏览器适配器负责当前页面的临时效果及执行回执，模型只接收脱敏语义和本地授权引用。

**技术栈：**Bun 工作区、TypeScript、Zod、NestJS、PostgreSQL、Nuxt 4、Vue 3、MapLibre GL、Vitest、Playwright。

**状态：**本次交付为文档设计，尚未实现或执行下文功能测试。协议字段、状态机、路由和错误码以 [智能体界面控制协议](../../agent-ui-protocol.md) 为唯一依据；现有分析链路参见 [智能体分析说明](../../agent-analysis.md)。

## 交付边界与已核实基础

首期包含已有船位、轨迹、情报的查询与临时展示，基于本地数据或用户明确参数的临时点线面，中央回复浮卡、顶部事件提醒、右侧记录及确认保存。关注、点赞待后续接入实际业务接口。

| 已存在入口                                             | 已核实行为                                                       | 本期落点                                        |
| ------------------------------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------- |
| `apps/agent/gateway.ts`                                | 有限意图分类，目前识别分析、解释证据和总结                       | 增加界面语义路由、补问和安全投影                |
| `apps/agent/runtime.ts`                                | 工具顺序执行，默认分析执行时限 180 秒                            | 接入命令工具并持久化挂起点                      |
| `apps/web/app/composables/useAgentConversation.ts`     | 会话恢复、消息读取、2500ms 事件轮询                              | 保留历史消息读取，新增控制通道生命周期          |
| `apps/web/app/composables/useIntelligenceWorkspace.ts` | `select` 默认调用 `add`；`add/hide/remove/clear` 写入 `plot-set` | 提供明确的只读详情和临时图层路径                |
| `apps/web/app/pages/index.vue`                         | 情报定位先 `add`；左右面板 watcher 写入 localStorage             | 分离智能体临时展示与人工偏好写入                |
| `apps/web/app/components/SeaMap.client.vue`            | 证据、轨迹 watcher 自动定位；TerraDraw 管理人工绘制              | 提供显式定位入口和独立临时 GeoJSON source/layer |
| `apps/api/src/intelligence/controller.ts`              | 调用 `writeRelation/writeGeoObject` 并分别记录审计               | 提取复用业务事务能力，接入服务端正式保存        |
| `apps/web/app/components/ChartAgentPanel.vue`          | 右侧展示消息、任务、证据与调用记录                               | 同源呈现回复、确认和逐项回执                    |

当前功能开关来自 `AGENT_ENABLED`。本期拟新增 `AGENT_UI_ENABLED=false`，有效状态由两者共同决定；协议中的逻辑开关与运行环境变量保持明确映射。

所有新文件采用 UTF-8、LF 和末尾换行。修改已有文件先读取 `.editorconfig`、`.gitattributes`、`.prettierrc.json`，将格式变更限制在本次范围。

## 实施顺序与写入归属

契约负责人先冻结协议和测试样例，再启动服务端、前端适配器、展示组件三个实现分支。智能体语义工具接入依赖契约与服务端端口；主集成负责人统一接线并验收。

| 负责人           | 独占写入范围                                                                                                                     | 交付后依赖                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 契约负责人       | `packages/contracts/agent-ui.ts`、`packages/contracts/agent-ui.test.ts`、`docs/agent-ui-protocol.md`                             | 服务端、前端、智能体共同引用 |
| 服务端负责人     | `packages/infrastructure/agent-ui*.ts`、新增迁移、`apps/api/src/agent/ui/`、`apps/api/src/intelligence/service.ts`、对应集成测试 | 前端领取与确认、智能体发命令 |
| 前端适配器负责人 | `apps/web/app/agent-ui/`、`apps/web/app/composables/useAgentUi.ts`、对应单元测试                                                 | 地图与页面接线               |
| 展示组件负责人   | `ChartAgentReplyCard.vue`、`ChartEventToast.vue`、`useAgentNotifications.ts`、通知与组件测试                                     | 页面及右侧面板接线           |
| 智能体负责人     | `apps/agent/ui-tools.ts`、`apps/agent/ui-intent.ts`、对应单元测试                                                                | 运行时接线与端到端验收       |
| 主集成负责人     | 现有共享文件、包导出、开关、生成产物、浏览器测试和文档更新                                                                       | 完整交付                     |

共享文件包括 `packages/contracts/index.ts`、`packages/infrastructure/index.ts`、`apps/api/src/app.ts`、现有 intelligence controller/store、`apps/agent/gateway.ts`、`runtime.ts`、`index.ts`，以及现有 web 页面、地图、面板和 composable。各负责人通过接口约定提交修改建议，由主集成负责人串行修改；需要下放时先明确转移该文件所有权。

每个任务按“行为测试 → 最小实现 → 目标测试 → diff 审查”推进。可独立验收的逻辑单元再提交，提交采用仓库现有风格与 `git-commit` 指南。

## 契约冻结与样例

**新增：**`packages/contracts/agent-ui.ts`、`packages/contracts/agent-ui.test.ts`。
**集成修改：**`packages/contracts/index.ts`；同步 `docs/agent-ui-protocol.md`。

- [ ] 定义协议版本 `1.0` 及 `ComponentDescriptor`、`ComponentState`、`DataReference`、`UiCommand`、`CommandReceipt`、`UiEvent` 的严格 Zod schema 和 TypeScript 导出。
- [ ] 固定五个工具：`ui.list_capabilities`、`ui.get_state`、`ui.query_data`、`ui.execute`、`ui.get_command`；对参数、回执、错误和模型可见字段建立白名单。模型使用 commandRef/dependsOnRefs；网关按持久工具调用标识生成和映射 commandId，相同调用重试复用 UUID。
- [ ] 描述符逐动作声明 allowedActors agent/user，状态显式包含 mounted/opened/visible；DataReference 支持 task 或 notification 作用域及 presentation/event/message/time-range 类型，模型投影与本地解析后记录分别验证。
- [ ] 采用协议的 `/api/v1/agent/ui` 路由表；请求、响应和状态码复用契约，前端与模型工具保持不同鉴权入口。
- [ ] 固定身份维度：认证用户拥有会话；`sessionId=null` 表示账号作用域；会话命令的 `Scope.taskGeneration` 记录创建代次，`executionGeneration` 隔离执行写回；`clientInstanceId/pageGeneration` 标识页面实例与当前代际。
- [ ] 固定时序：HTTP 事件轮询 2500ms，心跳 10 秒，实例租约 30 秒，待确认 pending 5 分钟到期；批准后同一命令 30 秒内领取，执行窗口 30 秒；过期及 unknown 按所在阶段处理。
- [ ] 固定按目标对象递增的状态版本、参数规范化哈希和幂等范围；人工操作改变目标版本，旧命令按协议返回冲突。
- [ ] 提供成功、确认等待、部分失败、`unknown`、过期和权限变化样例；批量逐项回执必须明确哪些项已完成、失败和未执行。
- [ ] 增加无效版本、未知字段、非法数据引用、目标代际缺失、批量上限及危险动作缺少确认绑定的拒绝测试。
- [ ] 明确前端状态与本地授权数据投影；模型接收能力和语义状态，实际船舶标识、坐标及原文由本地引用解析。

**交付判据：**契约测试通过，协议样例可直接被 schema 解析；三条实现分支无需自定义同名字段和枚举。

## 持久化、鉴权与实例生命周期

**新增：**`packages/infrastructure/agent-ui.ts`、`packages/infrastructure/agent-ui.integration.test.ts`、`packages/infrastructure/migrations/014_postgres.sql`；若实施时编号已占用，选择下一可用编号并同步测试。
**新增：**`apps/api/src/agent/ui/controller.ts`、`apps/api/src/agent/ui/service.ts`、`apps/api/src/agent/ui/controller.integration.test.ts`。
**集成修改：**`apps/api/src/app.ts`、`packages/infrastructure/index.ts`、`packages/infrastructure/agent.ts`。

- [ ] 建立客户端实例、命令、逐项回执、确认、持久事件、游标恢复及独立通知记录；业务关联和拥有者建立索引与约束。
- [ ] 客户端可用 sessionId=null 注册账号作用域；心跳、状态上报、领取、回执和注销验证用户、实例所有权、租约及 pageGeneration。通知详情、定位和关闭无需先创建 AI 会话。
- [ ] 通过 `PUT /clients/:id/binding` 按 expectedPageGeneration 做 CAS，绑定或切换 sessionId 时原子推进 pageGeneration，并失效旧命令与临时态；账号命令的 taskId/taskGeneration/resultVersion/executionGeneration 均为 null，仅来自 POST /actions 用户模板。
- [ ] 命令列表只返回发现元数据；原子领取时再次验证拥有者、页面代际、目标版本、期限及执行资格；会话命令另外验证当前 executionGeneration，账号动作按用户、实例、页面及租约鉴权。
- [ ] `ui.execute` 仅调用服务端内部 `UiCommandService.create`；普通按钮通过 `POST /actions` 提交协议固定 actionKey，使用普通用户会话凭据。`reply.hide/notification.dismiss/notification.locate/notification.details/notification.start_conversation/presentation.redisplay` 由服务端重算权限与绑定；确认使用独立 decision 路由。
- [ ] 事务内写入命令状态与事件，保证提交后才可被轮询；重复领取或回执返回同一结论，重试携带相同幂等标识。
- [ ] 为历史读取与当前领取建立独立代码路径；打开历史只还原记录，新窗口和刷新后的实例只能接收新命令。
- [ ] 会话切换、退出、租约过期时隔离旧实例；在“实例失联、领取已完成、回执未送达”场景保留 `unknown` 并启动对账。
- [ ] `unknown` 先通过 `ui.get_command` 和服务端状态查询核对；状态未收敛时停止依赖步骤，禁止创建替代命令重做副作用。
- [ ] 对游标过期按协议提供快照恢复；快照还原记录与待确认状态，历史命令保持原有终态及原实例归属。
- [ ] 权限撤销、任务取消及未经协议续跑授权的代次变化使未执行命令失效；保存前再次核验用户身份、业务权限和目标版本。
- [ ] 加入跨用户读取/确认拒绝、双窗口抢领、30 秒期限、乱序回执、重连补读、旧任务晚回包和事件重复投递的集成测试。

**交付判据：**两实例并发时只有目标实例获得执行权；重连可核对结果；服务端审计可串起用户、会话、任务、命令、确认和业务结果。

## 人工确认与业务保存事务

**新增：**`apps/api/src/intelligence/service.ts`、`packages/infrastructure/agent-ui-save.integration.test.ts`。
**集成修改：**`apps/api/src/intelligence/controller.ts`、`packages/infrastructure/intelligence-store.ts`、`apps/agent/index.ts`、`packages/contracts/agent.ts`、`packages/infrastructure/agent.ts`。

- [ ] 将现有情报关系和地理对象写入封装为可复用业务服务，使人工 API 与智能体保存共享校验、版本、审计和事务能力。
- [ ] decision 事务只将确认 pending→approved 并排入续作，重复决定返回原结果；正式保存事务再次检查 approved 并执行 approved→consumed、目标版本校验、几何保存、业务结果及命令成功状态，以上原子提交。浏览器回执仅证明预览或其他 UI 动作完成。
- [ ] 为正式保存提供包含差异、对象归属、目标版本和待覆盖草稿的预览；明确缺少关系或对象目标时进入补问。
- [ ] 确认记录绑定认证用户、命令、规范化参数哈希、预览哈希、目标对象版本及人工草稿版本，并设置 pending 5 分钟期限；确认摘要保留初始 scope，参数和预览哈希排除可变 executionGeneration。
- [ ] 收到确认时重新计算绑定和权限；预览后人工修改、参数变化、权限撤销、跨用户确认或已过期均返回协议冲突/拒绝结果。
- [ ] 等待确认写入持久状态并释放 worker；180 秒分析时限只约束运行段，审批等待通过持久挂起与续跑衔接。
- [ ] 按协议“确认与业务写入”的执行租约 CAS 续跑规则改造 `claimAgentTask`：`Scope.taskGeneration` 仅保留初始创建代次用于审计，`UiCommand.executionGeneration` 承担当前执行隔离；每次挂起持久保存 pauseGeneration=current task.generation，有效 decision 比较该 pauseGeneration，将等待中的任务 CAS 转为 queued，并生成一次性 resume 授权。
- [ ] claim 事务锁定 task、resume 及待执行命令，以 CAS 将本次 pauseGeneration 更新为 pauseGeneration+1，同时迁移未执行命令的当前 executionGeneration、消费 resume 并记录审计；保留 commandId、初始 scope、参数哈希和确认摘要，executing/unknown 命令仅进入对账。
- [ ] 恢复执行时读取同一命令与已完成步骤；续跑写回必须验证当前执行租约和授权代次，旧 worker 在迁移后全部失效。人工确认被拒绝、过期或撤销后给出真实回执，保留已有分析结果。
- [ ] 批量保存逐项记录事务结果，任一失败即停止依赖该项的后续动作；右侧清楚呈现已保存对象与未执行项。
- [ ] 验证 pending 超过 5 分钟后决定失效、approved 后超过 30 秒仍未领取则过期，进入 executing 后超过 30 秒转 unknown 并对账；重复 decision、重复 resume 和最终事务重试均只形成一条业务写入。
- [ ] 增加同一批预创建保存命令连续两轮挂起、确认和领取的集成验收：第二轮 pauseGeneration 使用已迁移的任务当前代次，各轮仅迁移未执行命令，最终逐项保存一次；第一轮旧 worker 和旧 resume 在第二轮均失效，初始 scope 保持不变。
- [ ] 集成测试覆盖确认超过 180 秒但未超过 5 分钟、重复确认、进程重启、并发草稿修改及业务提交后响应中断；并发领取续跑须仅一方 CAS 成功，同一确认和 commandId 恢复成功且旧 worker 晚到写回被拒绝。

**交付判据：**保存仅由服务端执行器完成；确认与实际入库内容一致；等待审批期间 worker 能处理其他任务。

## 前端适配器与独立临时图层

**新增：**`apps/web/app/agent-ui/registry.ts`、`executor.ts`、`temporary-map.ts`、`apps/web/app/composables/useAgentUi.ts`。
**新增测试：**`apps/web/agent-ui-executor.test.ts`、`apps/web/agent-ui-temporary-map.test.ts`、`apps/web/agent-ui-state.test.ts`。
**集成修改：**`SeaMap.client.vue`、`app/types/chart.ts`、`app/pages/index.vue`、`useIntelligenceWorkspace.ts`、`useChartWorkspace.ts`、`useAgentConversation.ts`；路径均位于 `apps/web/` 的现有目录。

- [ ] 按协议注册能力、allowedActors 权限以及 mounted/opened/visible 状态，页面就绪后先以账号作用域注册实例；唯一轮询器负责命令发现、领取、执行及回执，防止重复计时器。
- [ ] 执行器校验命令、目标对象版本和当前实例；会话命令追加 executionGeneration 执行授权检查，账号命令验证用户模板来源，再将业务动作映射到 typed adapter；组件只暴露明确动作入口。
- [ ] 将详情读取与加入人工标绘集合拆开；临时选择使用只读详情，临时定位读取授权几何后直接调用显式地图方法。
- [ ] 为船位、轨迹、情报和点线面创建独立临时 GeoJSON source/layer；会话展示按实例与会话管理，账号通知定位按实例与页面代次隔离，绑定切换时统一清理。
- [ ] 临时几何来源限制为本地授权数据或用户明确给出的参数；字段不足时返回可补问的结构化状态。
- [ ] 临时点线面使用独立缓冲，TerraDraw 人工草稿维持独立所有权；正式覆盖人工草稿之前执行版本绑定的预览确认。
- [ ] 将轨迹与证据数据刷新和自动镜头变化拆开；人工拖图、缩放、选择或编辑后递增对应目标版本并暂停过期自动动作。
- [ ] 分离临时面板展开状态与人工偏好；人工事件明确调用偏好持久化入口，智能体展开和关闭保持临时状态。
- [ ] 保持 `useChartLayout` 的人工尺寸保存语义；临时展示触发布局重算时只更新测量值。
- [ ] 会话切换、刷新、退出或实例失效时清理临时 source/layer、选中状态、旧绑定轮询器和待回包，账号通知轮询按新绑定恢复；异步完成前再次校验页面代际与当前执行授权。
- [ ] 历史消息和快照只还原记录；用户主动“再次展示”经桥接生成新命令并绑定当前页面实例。
- [ ] 使用网络与 Storage spy 验证临时选择、显示、隐藏、定位、清空、面板展开全程零业务写接口及零偏好写入。
- [ ] 独立验证协议控制写入属于预期行为；测试断言只允许状态上报、领取、回执、通知已读等明确控制请求。
- [ ] 回归人工 `add/hide/remove/clear`、关系编辑和布局偏好保存，确保现有人工操作仍按原权限持久化。

**交付判据：**临时展示结束后业务标绘集合、人工草稿和持久偏好与执行前一致；人工操作能立即阻止旧版本命令覆盖。

## 真实事件来源与通知投影

**新增：**`packages/infrastructure/agent-ui-notifications.ts`、`packages/infrastructure/agent-ui-notifications.integration.test.ts`、`apps/api/src/agent/ui/notifications.service.ts`，由服务端负责人独占实现。
**复用：**`packages/infrastructure/topics.ts` 的 `readAnalysisFeed` 与 `analysis_feed`；读取权限沿用 `apps/api/src/topics/controller.ts` 的现有 analysis 读取规则。

- [ ] 以已提交 analysis_feed 为首期真实来源，GET notifications 的服务端通知 service 调用幂等投影器，形成每用户通知 read-model。
- [ ] 首次账号订阅记录已提交 feed 高水位；后续按每用户 cursor 增量投影，将通知写入与 cursor 推进放在同一事务，重试保持一致。
- [ ] 以 sourceType+resultId 生成稳定 eventUUID，revision 使用来源版本；权限过滤后生成通知，原结果缺少严重等级时首期固定 info，withdrawn 更新状态并留档。
- [ ] 为通知内容、位置与关联引用应用同一权限规则；账号作用域允许详情、定位、关闭，发起关联询问后才建立会话绑定。
- [ ] 区分新实时事件与重连补历史；后者更新通知记录但不重新弹出。使用 source revision 去重，更新和撤销记录保留来源关联。
- [ ] 投影集成测试覆盖首次高水位、增量事件、重复读取、事务中断、用户权限过滤、revision 更新、withdrawn 留档及游标恢复。
- [ ] 在真实服务 E2E 中通过专题业务入口生产并提交 analysis_feed 事件，验证通知实际出现、无会话定位与详情、关联询问绑定；fixtures 仅用于独立 UI 场景。

**交付判据：**真实专题结果能够进入用户通知记录，重连后无重复弹出；通知记录及游标具备同事务提交和权限隔离证据。

## 中央回复浮卡与顶部事件提醒

**新增：**`apps/web/app/components/ChartAgentReplyCard.vue`、`ChartEventToast.vue`、`apps/web/app/composables/useAgentNotifications.ts`。
**新增测试：**`apps/web/agent-notifications.test.ts`、`apps/web/agent-reply-card.test.ts`。
**集成修改：**`apps/web/app/pages/index.vue`、`ChartAgentComposer.vue`、`ChartAgentPanel.vue`、`ChartRightPanel.vue`、`apps/web/app/assets/workbench.css`。

- [ ] 将 AI 回复浮卡放在中央输入框上方，同一时刻显示当前一条；复用右侧同一条 `messageId` 和内容数据。
- [ ] 关闭浮卡仅改变展示状态，右侧历史消息保持可见；新回复替换当前浮卡，恢复历史会话时按协议控制新消息展示资格。
- [ ] 为任务运行、等待补充、等待确认、失败和完成提供明确状态；逐项回执与确认内容可从右侧追溯。
- [ ] 顶部事件提醒按 `eventId + revision` 去重，同一事件新版本更新内容；通知列表独立持久化，与 AI 回复分别管理。
- [ ] 普通提醒展示 10 秒后隐藏，高级提醒持续到关闭；悬停或键盘聚焦时暂停倒计时，离开后从剩余时长继续。
- [ ] 分开处理提醒关闭、记录已读与业务结果；关闭和自动隐藏保留通知记录，重连重复事件保持稳定展示状态。
- [ ] “详情”打开授权详情；“定位”发起真实临时定位命令；“关联询问”提交事件引用并链接返回的会话。
- [ ] 关注、点赞按后续接入状态呈现，首期验收仅覆盖已有真实动作；待接入操作不得呈现虚假的成功状态。
- [ ] 对通知已读、关联会话及当前消息建立一致更新路径；会话切换时保留账号范围通知并清理当前浮卡。
- [ ] 增加键盘关闭、可访问名称、焦点恢复与播报策略；中小屏下浮卡和顶部提醒保持地图、输入框及确认按钮可操作。
- [ ] 测试去重、版本更新、10 秒计时、悬停/聚焦暂停、高级提醒、关闭留档和 `messageId` 同源；用浏览器验证真实布局。

**交付判据：**浮卡与右侧消息内容一致；提醒与通知记录可恢复；用户点击详情和定位得到实际页面变化及可查回执。

## 智能体语义工具与出站隔离

**新增：**`apps/agent/ui-tools.ts`、`apps/agent/ui-intent.ts`、`apps/agent/ui-tools.test.ts`、`apps/agent/ui-intent.test.ts`。
**集成修改：**`apps/agent/gateway.ts`、`runtime.ts`、`index.ts`、`gateway.test.ts`、`runtime.test.ts`。

- [ ] 在入队前先区分 UI、分析及混合任务，再校验各自必需参数；调整 `packages/infrastructure/agent.ts` 当前按 bbox 决定 queued/awaiting_input 及自动补问的分支，并调整 `runtime.ts` 对缺少 bbox 的全局拦截。
- [ ] UI 任务在具备动作目标与授权实例时允许无分析区域执行，例如隐藏临时图层、定位已有情报；分析任务保留区域和算法校验，混合任务按阶段检查依赖，缺少分析区域只阻塞对应分析步骤。
- [ ] 扩展现有有限意图分类，识别查询、显示、隐藏、定位、绘制、保存与补充条件；保留原分析、解释和总结入口。
- [ ] 将多步语义拆为有依赖的动作计划，例如查询本地目标、临时显示、定位；混合分析与 UI 动作通过明确路由衔接。
- [ ] 使用本地引用绑定对象、时间和几何参数；未知目标、模糊区域、缺少保存归属或多候选时补问，并保留等待上下文。
- [ ] 实现五个 `ui.*` 工具，通过服务端端口读取能力、状态和本地数据引用，提交命令并查询结果。
- [ ] 根据实际能力决定工具可用性；开关关闭、无在线实例、页面能力不足或权限变化时返回固定结构化状态。
- [ ] 对工具结果、回执、引用解析失败、schema 错误和异常统一白名单投影；原始错误、参数、正文及坐标保持本地。
- [ ] 在每次模型请求前校验完整出站消息；重试、续跑和历史压缩采用同一投影，测试错误对象嵌入敏感字段的泄漏场景。
- [ ] 依赖步骤等待明确回执；部分失败停止受影响步骤，`unknown` 进入对账；“已显示”“已保存”等结论由最终回执生成。
- [ ] 临时展示在权限和状态允许时自动执行；业务保存与人工草稿覆盖等待预览确认，等待记录和续跑状态持久化。
- [ ] 为“显示这艘船轨迹”“定位这条情报”“按明确坐标画区域”“保存到当前关系”等输入添加语义到工具的行为测试。
- [ ] 测试普通查询不会触发保存，模糊请求会补问，恢复任务不会重放成功命令，模型工具描述与协议动作一致。

**交付判据：**自然语言请求可到达真实命令链路；模型外发请求仅含允许的语义字段与引用；工具终态与用户可见结论一致。

## 接线、接口生成与分层验收

**新增：**`tests/integration/agent-ui-pipeline.integration.test.ts`、`tests/e2e/agent-ui-control.spec.ts`、`tests/e2e/agent-ui-real.spec.ts`、`tests/e2e/agent-ui.config.ts`、`apps/agent/ui-smoke.ts`。
**集成修改：**`playwright.config.ts`、`package.json`、`tests/e2e/fixtures/chart-fixture.ts`、`apps/web/package.json`、`apps/api/openapi.json`、`apps/web/app/types/api.generated.ts`、`docs/agent-analysis.md`。

- [ ] 主集成负责人接入各分支交付，审查共享文件 diff，并把新增 web 单元测试加入当前显式测试列表。
- [ ] 为新增 API 与正式保存契约补齐 `DocumentRoute/DocumentQuery` 和响应 schema；通过现有生成脚本更新 OpenAPI 与前端类型。
- [ ] 生成前连接隔离测试基础设施；`scripts/generate-api.ts` 会创建基础设施连接，生成结果必须检查敏感信息和无关 diff。
- [ ] 新建 UI Playwright 配置，沿用 `apps/web/playwright.agent.config.ts` 的本地 Nuxt、浏览器路径和软件渲染设置，将 `testMatch` 固定为 `agent-ui-control.spec.ts`；根 `playwright.config.ts` 的 `testIgnore` 新增该模拟用例，真实服务配置只执行 `agent-ui-real.spec.ts`。
- [ ] 浏览器 fixture 模拟持久事件、实例领取、回执和确认，并显式标注模拟；所有网络模拟限定在 `agent-ui-control.spec.ts`；`agent-ui-real.spec.ts` 通过根目录 Playwright 配置访问真实服务且禁止网络 mock。
- [ ] 浏览器验收覆盖中央回复、顶部提醒、右侧留档、地图点线面、会话切换、刷新、双窗口、断网恢复及人工操作竞态。
- [ ] 在全新会话且未确认分析区域时，端到端验证“定位已有情报”和“隐藏临时图层”可以入队、执行并收到回执；同条件提交分析请求仍补问区域，混合请求按阶段依赖处理；补充账号未建立任何 AI 会话时收到真实通知并打开详情、定位、关闭的验收。
- [ ] 对临时命令执行前后比较业务数据库、plot-set 和 localStorage 偏好；协议自身的审计及回执写入单独校验。
- [ ] 真实服务集成覆盖权限、事务、worker 挂起续跑及幂等；真实模型验收单列，模拟模型通过不代表真实模型链路通过。

以下命令在仓库根目录执行，使用已安装依赖、Node.js 24 与 Bun。新增路径须在对应实现任务完成后再运行。

| 验证层         | 命令                                                                                                                                                                                                                                                                                                                                             | 预期证据                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| 契约           | `bun --no-env-file run test packages/contracts/agent-ui.test.ts`                                                                                                                                                                                                                                                                                 | schema 与样例断言通过                |
| 前端逻辑       | `bun --no-env-file run test apps/web/agent-ui-executor.test.ts apps/web/agent-ui-temporary-map.test.ts apps/web/agent-ui-state.test.ts apps/web/agent-notifications.test.ts apps/web/agent-reply-card.test.ts`                                                                                                                                   | 生命周期、版本、计时与零隐式写入通过 |
| 智能体         | `bun --no-env-file run test apps/agent/ui-tools.test.ts apps/agent/ui-intent.test.ts apps/agent/gateway.test.ts apps/agent/runtime.test.ts`                                                                                                                                                                                                      | 语义、回执驱动与出站白名单通过       |
| 服务端集成     | `bun --no-env-file run test:integration:isolated packages/infrastructure/agent-ui.integration.test.ts packages/infrastructure/agent-ui-save.integration.test.ts packages/infrastructure/agent-ui-notifications.integration.test.ts apps/api/src/agent/ui/controller.integration.test.ts tests/integration/agent-ui-pipeline.integration.test.ts` | 隔离 Docker 基础设施中事务与并发通过 |
| 浏览器模拟     | `bun --no-env-file run test:e2e --config tests/e2e/agent-ui.config.ts`                                                                                                                                                                                                                                                                           | 新配置中的 fixture 行为和布局通过    |
| 真实服务浏览器 | `bun --no-env-file run test:e2e:isolated tests/e2e/agent-ui-real.spec.ts`                                                                                                                                                                                                                                                                        | 根配置启动真实后端的独立用例通过     |
| 接口生成       | `bun --no-env-file run api:generate`                                                                                                                                                                                                                                                                                                             | OpenAPI 与前端生成类型一致           |
| 工程回归       | `bun --no-env-file run lint`、`bun --no-env-file run typecheck`、`bun --no-env-file run test`、`bun --no-env-file run build`                                                                                                                                                                                                                     | 修改范围和既有流程通过               |
| 文档与格式     | `bunx --no-install prettier --check docs/agent-ui-protocol.md docs/superpowers/plans/2026-10-11-agent-ui-control.md`、`git diff --check`                                                                                                                                                                                                         | 格式与补丁检查通过                   |

真实服务浏览器用例可以在服务端采用明确标识的模型替身，以验证接口、持久化和 UI；报告须标注“真实服务＋模型替身”。真实模型验收由独立入口执行，原 `agent-workbench.spec.ts` 拦截 Agent API，只能作为模拟 UI 验证。

- [ ] 新增 `apps/agent/ui-smoke.ts` 与根脚本 `agent:ui-smoke`，脚本值为 `node --import tsx apps/agent/ui-smoke.ts`；入口访问隔离真实 API，使用真实模型、已授权测试账号及在线浏览器实例，验证自然语言到命令回执，并输出脱敏审计标识。
- [ ] 使用 `bun --no-env-file run agent:ui-smoke` 执行真实模型验收；明确注入模型凭据和测试连接参数，覆盖临时展示、补问、确认保存及结果对账。现有 `agent:smoke` 只验证原分析链路，缺少真实 UI 验收条件时报告未执行。

隔离测试会创建并清理独立 Docker 项目与测试卷，浏览器测试会产生截图、trace 和报告；运行前核对端口及输出目录。验收报告分别列出命令、结果、模拟边界、未执行项及复现步骤。

## 开关、灰度与回滚

**集成修改：**`.env.example`、`apps/api/src/agent/controller.ts`、`apps/agent/index.ts`、`apps/api/src/agent/ui/service.ts`、`useAgentConversation.ts`、`useAgentUi.ts`、`docs/agent-analysis.md`。

- [ ] 增加默认关闭的 `AGENT_UI_ENABLED`，API 配置返回实际生效状态；服务端桥接和前端注册共同校验现有 `AGENT_ENABLED`。
- [ ] 先对隔离测试账号开放临时显示，再验收确认保存；每阶段记录失败率、未知结果、冲突、过期、执行延时与模型出站拒绝。
- [ ] 验证开关关闭时原有分析、人工地图操作、情报编辑和权限判断继续正常运行。
- [ ] 停用时拒绝新控制命令，终止未领取及等待确认命令，保留回执查询和对账能力；对已提交业务事务展示真实结果。
- [ ] 前端获知停用后注销控制实例、清理临时图层和计时器；历史消息与通知记录保留可读，人工偏好与草稿由原流程管理。
- [ ] 回滚应用版本前核对数据库迁移兼容性；新增持久记录保持可审计，清理按独立保留策略执行。
- [ ] 发布记录附上开关值、契约版本、测试报告、生成产物检查及回滚步骤；由主集成负责人确认逻辑单元完整后提交。

**最终交付判据：**从自然语言请求到权限校验、临时展示、确认保存和可追溯回执完整贯通；历史恢复、人工优先及多实例隔离有自动化证据，真实模型验收状态有明确记录。
