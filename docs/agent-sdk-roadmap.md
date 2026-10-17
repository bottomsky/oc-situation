# 通用 Agent SDK 与系统重构开发路线图

本文是通用 SDK 后续代码工作的主计划，目标设计以[SDK 架构](agent-sdk-architecture.md)为准。AIS 应用已接入账号私有声明式技能、版本管理、按步骤保存多产物以及携带产物引用的界面命令，范围见[账号动态技能](agent-dynamic-skills.md)。下列通用 SDK 工作包仍按各自完成条件验收。现有能力和验证见[实施状态](implementation-status.md)，历史过程保留在报告目录及 Git 历史。

## 账号动态技能应用接入

本轮实现落在现有 `packages/contracts`、`packages/domain`、`packages/infrastructure`、`apps/agent`、`apps/api` 和 `apps/web`，由 `AGENT_DYNAMIC_SKILLS_ENABLED` 控制发布与执行，默认关闭。声明式程序引用宿主任务输入与前序产物，自动校验后形成私有不可变版本；任务固定绑定版本、摘要与工具上限，保存调用账本和步骤产物。`/skills` 提供当前账号目录与历史版本管理，功能关闭时继续读取历史。

该接入为 SERVER 的版本快照、调用恢复和产物引用提供应用样例。通用四包拆分、任意业务工具接入、远程 MCP、通用导航迁移和独立 SDK 发布继续由下列工作包实施。已有应用代码按对应任务逐步抽取，验收时同时覆盖本轮私有技能回归。

## 交付顺序与范围

先固定回归基线并修正执行阶段与采集租约风险，再建立共享应用用例与SDK协议。服务端、browser和Vue按冻结接口分工，先打通独立订单示例与AIS完整纵切，再扩展全站操作和远程工具。AIS采集、清洗、双写入、归档、专题和Agent进程保留，Pi继续作为模型执行适配。

| 任务标识 | 工作包                | 前置依赖                                    | 交付边界                                      |
| -------- | --------------------- | ------------------------------------------- | --------------------------------------------- |
| BASE     | 基线与已确认风险修复  | 当前代码                                    | 阶段权限、fencing、测试计数、兼容样例         |
| APP      | 共享应用用例与授权    | BASE                                        | application端口，HTTP/WS/Agent共用规则        |
| PROTOCOL | 四包契约与发布骨架    | BASE                                        | 通用协议、版本、目录与独立消费约束            |
| SERVER   | 统一执行宿主与技能    | APP、PROTOCOL                               | Pi、目录快照、journal、approval、恢复         |
| BROWSER  | 框架无关控制与Vue适配 | PROTOCOL；服务端接口冻结                    | 注册、队列、回执、取消、导航过渡              |
| VERTICAL | AIS完整业务纵切       | APP、SERVER、BROWSER                        | 查询、普通编辑、高风险确认、跨页导航          |
| COVERAGE | 全站能力覆盖与通知    | VERTICAL                                    | 页面/API操作目录、临时展示、通知与结果呈现    |
| REMOTE   | MCP与HTTP工具         | SERVER                                      | 读工具先验收，写工具按恢复能力准入            |
| PACKAGE  | 独立订单示例与发布    | PROTOCOL、SERVER、BROWSER、REMOTE的HTTP部分 | Node24 ESM+d.ts、四包tarball、vanilla/Vue示例 |
| RELEASE  | AIS迁移与发布回滚     | 已验收的纵切及PACKAGE                       | 旧表适配、历史读取、开关、对账和环境验证      |
| EVIDENCE | 外部来源与容量验收    | 对应环境授权和可用性                        | GDELT、生产容量、镜像/集群、备份恢复          |

任务标识用于需求和验收追踪，不能替代明确完成条件。PACKAGE中的发布消费检查从骨架建立时持续运行，最终通过后才认定SDK可独立交付。EVIDENCE按环境条件推进，其结果单独记录。

## 协作与共享文件所有权

主集成负责人独占公共契约变更、数据库迁移与迁移登记、根package/锁文件/tsconfig/ESLint、构建与工作区脚本、OpenAPI生成物及跨模块接线，审查diff并执行最终验证。公共协议草案可由子代理提出，落地与冻结由主负责人统一完成。

子代理按阶段独占application、server、browser、vue、AIS Agent适配、Web业务适配等目录。现有共享页面、controller、infrastructure文件由主负责人明确分配后再下放；同一文件同一阶段只有一个写入负责人。契约冻结后并行，接口变化先更新样例与消费者清单。

目标目录采用 `packages/agent-kit-protocol`、`agent-kit-server`、`agent-kit-browser`、`agent-kit-vue`，发布名依次为 `@agent-kit/protocol`、`@agent-kit/server`、`@agent-kit/browser`、`@agent-kit/vue`。AIS应用层使用 `packages/application`。这些目录是规划，随对应任务创建。

## 基线与执行可靠性

**任务：BASE。前置：**读取当前格式、工作区、测试与构建配置，固定待改文件和历史响应样例。

**写域与接口：**采集负责人修改collector/crawler运行管理及被明确分配的仓储方法；Agent负责人修执行阶段权限；测试负责人将 `runtime.test.ts` 的共享fixture移至非测试模块。公共参数、根脚本由主负责人整合。

**实现：**

- 修正阶段权限与调用参数的相容性，按真实运行阶段验证工具可用范围；收敛区域研判、UI与能力宿主的重复预算和审计入口。
- 工作进程状态、来源状态、checkpoint和计数写入强制携带lease；人工取消采用独立接口。
- 抽取SourceRunExecutor，管理认领、串行续租、控制状态、AbortSignal、终态与释放；协议执行保留分页、长连接和Crawlee差异。
- 失租返回明确fenced/retry结果，消息适配器按结果ACK/NAK；等待在途续租/checkpoint收尾后释放。数据库fencing与消息稳定ID共同支撑恢复。
- 清除测试文件互相导入导致的48项重复注册，保留原行为断言并重报测试计数。
- heatmap-build-smoke 的技能目录断言已随历史航线接入更新为五份内置技能；编译产物冒烟继续按实际执行记录验收，历史成功记录保留原版本边界。
- 固定当前HTTP、会话、输入修订、热图、专题、人工编辑及地图布局的回归样例。

**验证与完成：**覆盖旧owner晚到写入、新owner接管、取消与完成竞争、关闭与flush交错、重复投递；真实runner调用链通过，底层仓储测试不能单独代替。补充无模型密钥的本地查询/UI路径基线，模型按需初始化。重跑单元、lint、typecheck及相关隔离集成，单独记录格式存量问题。

**迁移与回滚：**优先沿用既有租约表和消息协议；变更接口在同一交付内完成调用方迁移。回滚先停新认领并等待在途工作，保持旧消息和数据，保留已验证的fencing保护。

## 共享应用用例与权限

**任务：APP。前置：**BASE的行为基线和调用链修复完成。

**写域与接口：**application负责人独占 `packages/application`；主负责人分配API/WS/Agent入口和infrastructure实现。application依赖contracts/domain，声明Actor、Authorization、Clock、VesselReader、ReplaySubmissionStore、IntelligenceStore及事务端口；infrastructure以type-only引用实现。

**实现：**

- 首先建立operation级授权表，覆盖viewer个人展示状态、operator业务操作与admin来源/用户管理。HTTP保留session/Origin/CSRF，应用用例与Agent执行前重查权限和资源归属。
- 先迁VesselQuery、ReplaySubmission、Intelligence归档/来源/对象/关系/审核；再按业务事务逐批迁Topics、Acquisition、Identity、AgentConversation。
- 将runRow等响应转换移出controller，WebSocket调用查询用例。共享网络policy、safeRequest与RequestBudget从crawler内部迁至明确公共模块。
- 船舶逻辑查询固定服务端asOf，候选区间采用 `[asOf-hours, asOf]`，count/rows同快照；接入保留五分钟时钟容差。该时间统一作为有行为变化的独立验收项。
- 保留地图聚合、Agent摘要和HTTP分页投影。固定asOf只固定时间条件，跨HTTP分页的严格快照另行设计。
- 共享真实查询与事务规则，保持既有领域算法、专题generation、不可变结果和双写就绪回执。

**验证与完成：**HTTP/WS/Agent同条件候选集合一致，覆盖未来点位、跨日期变更线、来源、船型和无近期位置；回放幂等/事务回滚、情报版本/审计与角色矩阵通过。新增导入规则能拒绝controller直连DB、service引用controller和apps内部跨应用引用。

**迁移与回滚：**HTTP响应和业务表兼容；按用例切换调用方，旧入口适配至同一实现。回滚以调用路由切换为单位，保持相同事务和历史读取规则。

## 通用契约与独立包骨架

**任务：PROTOCOL。前置：**BASE已固定现有接口与历史样例，四包边界已确认。

**写域与接口：**主负责人独占 `packages/agent-kit-protocol` 与共享配置；各包负责人建立最小导出。冻结任务、调用、事件、结果引用、补充输入、审批、组件描述/状态、命令、回执、导航transition和错误schema。

**实现：**

- 所有通用身份采用opaque string；由宿主注入actor/tenant、phase和执行代次。AIS枚举与UUID规则通过业务适配连接。
- 明确创建代次、当前执行代次、pauseGeneration、inputRevision、页面代次、目标版本和幂等范围，提供同参数重试与改参数冲突样例。
- 冻结协议版本协商和历史解码；可选能力协商后开放。四包JS、d.ts与exports分离，server/storage-postgres为可选子入口。
- 联动build-plan、workspace发现、tsconfig、ESLint、资产复制、根测试入口和发布文件清单；新增Web测试纳入当前实际执行清单。
- 提供等待确认、两轮续作、部分失败、unknown、过期、权限变化、导航完成/中断与旧协议映射fixtures。

**验证与完成：**严格schema拒绝未知必需字段、无身份/目标代次、越权引用、危险动作无确认；仅安装tarball的临时消费者能够加载ESM和类型，核心入口在无PG/NATS/Nest时通过。验证每个公开subpath和浏览器依赖图。

**迁移与回滚：**契约新增先由适配器读取；旧接口保持原格式。协议变更通过版本化decoder/adapter兼容，已发布记录保留版本信息。

## 统一服务端执行、技能与调用恢复

**任务：SERVER。前置：**APP的授权/事务端口、PROTOCOL样例冻结。

**写域与接口：**server负责人独占SDK服务端包，负责storage-postgres参考适配、transaction store及testing内存实现；AIS旧表桥接由指定infrastructure负责人完成。参考适配迁移由server负责人提出，所有迁移文件、登记与注册由主负责人统一落地。冻结TaskStore、Journal、Approval、Event、Result、SkillCatalogStore、Scheduler及Projection端口。

**实现：**

- 保留Pi执行能力并形成runtime/pi/skills/http/testing窄入口，统一本地查询、情报、区域研判与UI的工具治理。
- 工具声明effect/risk、schema、phase、授权与恢复策略；按字段diff和当前状态动态评估审核、撤回、专题启停/重预热、来源/任务状态计划及权限变更的风险。任务预算预留、调用唯一约束、执行代次CAS与journal准备在同事务完成。
- 模型适配器可选或惰性初始化，无模型密钥时本地查询和本地UI任务独立运行；缺少模型配置只影响需要模型的能力。
- 技能目录由可信配置加载，校验资源白名单/真实路径/大小、工具绑定与hash；原子刷新快照，新任务采用新快照，在途任务绑定原版本。撤权立即生效，版本缺失明确失败。
- 管理员添加可信技能目录并refresh后，通过通用executor组合现有授权工具、返回结构化结果；无需修改TypeScript或intent枚举。metadata与授权配置分离，持久snapshot和catalogRevision通过CAS发布，任务提交绑定确切版本，跨worker及重启使用同一快照。
- 交付storage-postgres的独立可配置表命名空间、显式版本迁移和transaction store，覆盖任务/租约/事件/结果/journal/approval/技能快照；模块导入与运行时创建不自动迁移。testing内存适配与PG适配共用端口契约测试，AIS旧表桥接保留历史读取。
- 建立prepared至终态/unknown调用账本；外部请求发出后结果丢失先对账。所有出站消息、错误、重试和历史压缩通过宿主投影。
- 预览绑定参数、对象、草稿、策略和初始scope；decision排队与正式业务事务分开。业务事务原子消费approval、校验版本、保存业务结果和成功journal。
- 等待确认释放worker，每轮记录pauseGeneration；resume一次消费并只迁移未执行调用fence。连续两轮挂起后旧worker、旧resume和已执行调用保持隔离。
- AIS确认pending五分钟、批准后30秒内领取、执行30秒、引用默认30分钟作为初始策略；SDK提供有界配置。等待时间独立于运行窗口和累计预算。

**验证与完成：**fake clock验证过期；同键并发只执行一次，重复decision/claim恢复原结果；提交后响应中断、审批超过运行窗口、连续两轮确认、权限变化、审计失败、工具schema漂移均有自动化证据。直接SDK实例不依赖AIS，AIS适配读取旧任务与结果通过。

技能验收使用新增目录的真实配置操作，证明无需重编译即可发现、选择、执行已有工具组合；覆盖非法授权、无效schema、并发refresh CAS冲突、多worker读取、重启恢复和在途旧快照。存储验收要求内存/PG共享契约测试通过，另测同事务回滚、唯一调用竞争、租约接管、事件游标、迁移升级和旧记录解码；PG参考实现通过后才进入PACKAGE。

**迁移与回滚：**追加journal、approval、能力快照与必要关联字段，保留旧表；先迁读能力再迁写能力。关闭能力后取消未执行项，executing/unknown保留查询和对账；禁止自动重放未知副作用。

## 浏览器基础与 Vue 接入

**任务：BROWSER。前置：**PROTOCOL冻结，服务端注册/领取/回执/transition接口样例可测试。

**写域与接口：**browser与vue负责人各自独占包；AIS页面适配由Web负责人另批接入。对外提供typed组件注册、状态读写、动作执行、取消、结果回执、路由transition和自定义UI状态。

**实现：**

- 一个实例管理合并状态、独立心跳、命令发现和按资源串行的执行队列；注入clock/idFactory，长操作保持心跳与取消响应，互不冲突资源有界并发；严格校验actor、页面、当前任务fence及相关componentVersion。
- 区分mounted/opened/visible、availability、dataVersion与人工操作版本；拒绝未登记能力、任意脚本、DOM操作和通用URL。
- 账号作用域可先注册，绑定会话使用CAS；刷新新实例、旧命令失效，历史恢复只还原记录。
- 导航先预检草稿和权限，持久transitionId，目标挂载快照、新binding与成功回执原子CAS提交后继续依赖步骤；普通路由上报不得抢先推进pageGeneration，导航中断与刷新有可查结果。
- vue提供composables和卸载清理；nuxt只做客户端安装/路由适配，宿主自定义聊天、审批及业务界面。
- 取消、卸载、会话切换清理计时器与迟到响应，executing后回执丢失进入unknown并阻止盲重投。

**验证与完成：**vanilla无Vue可运行；Vue/Nuxt覆盖SSR/client边界、反复挂载、同账号双标签、退出重登、断网、重复receipt、手动交互抢占及导航切换。状态过期、组件版本冲突和后置条件失败返回明确结果。

**迁移与回滚：**保留当前AIS UI transport适配；页面逐个切换，单页只启用一个控制实例。回退注销新实例、保留历史、清理临时效果，人工草稿继续由原页面管理。

## AIS 完整纵切

**任务：VERTICAL。前置：**APP、SERVER、BROWSER完成相关接口，SDK读取路径通过。

**写域与接口：**AIS Agent插件与Web页面各自独占分配目录；主负责人整合controller/OpenAPI、旧表适配与开关。纵切固定为一条查询、一个普通编辑、一次高风险确认和一次跨页导航。

**实现：**

- 查询使用真实共享服务；普通编辑选择具备明确资源版本的情报对象/关系，按宿主授权执行；高风险操作采用可核对预览与审批。
- 混合请求按步骤校验条件：无bbox的已有对象定位可运行，分析缺区域时补问，保留任务上下文与累计预算。
- 用户、模型、UI和后台执行以同一operation定义权限和副作用；保存由后台完成，页面回执用于展示结果。
- 检查已有方法的隐式副作用，拆开情报详情读取、add到plot-set、定位和偏好保存。
- 完成查询→临时呈现→导航→编辑预览→确认→业务提交→回执与历史读取的可追溯链路。

**验证与完成：**真实API/数据库/worker/浏览器贯通；模型替身与真实模型验收分别记录。覆盖普通查询不保存、目标歧义补问、并发人工修改、旧确认失效、提交响应丢失、结果查询确认、刷新和跨页迟到命令。只读、operator和admin账号分别验证。

**迁移与回滚：**隔离账号灰度，旧响应及历史结果兼容。先关闭新工具和新写入口，再处理在途journal；已提交业务保持实际状态，unknown人工核查。

## 全站能力、临时标绘与通知

**任务：COVERAGE。前置：**VERTICAL通过，逐页/API操作目录及风险矩阵已审查。

**写域与接口：**Web适配、AIS工具、通知投影服务分域执行；业务Schema、迁移、API生成和跨模块注册由主负责人整合。通知业务属于AIS，SDK提供通用事件与UI协议。

**实现：**

- 盘点每个现有页面/API的查询、筛选、编辑、审核、启停、删除和配置操作，登记operation、角色、effect/risk、确认、幂等与结果查询；全部既有业务范围逐批接入。
- 临时船位/轨迹/情报/点线面使用独立source/layer与缓冲；本地授权数据或用户明确参数形成DataReference，过期/撤权重新解析。展示与focus分别执行，保留人工TerraDraw草稿、plot-set、布局及localStorage偏好。
- 人工拖图、选择、绘制更新相关版本；切换/退出清理临时资源，历史再次展示产生新命令。缺坐标、空轨迹、跨日期变更线给出真实反馈。
- 正式草稿apply覆盖与save保存分别预览确认，批量逐项结果，连续多轮审批遵守SERVER的代次规则。
- 以analysis_feed生成用户通知：首次提交安全高水位、稳定sourceType+resultId、来源revision、首期info、权限过滤；通知与源游标同事务，展示游标独立，withdrawn留档，重连replay不重复弹出。
- 无AI会话可详情、定位和关闭通知，关联询问才创建会话。中央回复与右侧共享messageId，只展示当前一条，关闭保留历史。
- info提醒10秒后隐藏，warning/critical持续到关闭；悬停/聚焦暂停，键盘关闭与焦点恢复。关闭、已读、业务结果分别管理。关注/点赞在真实服务与权限接通后进入能力目录。
- 保留全高海图、悬浮输入、唯一会话实例、右侧默认对话、左侧筛选、Enter/Shift+Enter/中文输入法及窄屏交互。

**验证与完成：**页面/API目录每项有真实handler、权限和回执证据；临时操作用网络/Storage spy验证零业务写入和零偏好写入，允许明确控制通道请求。真实专题入口产生通知并验证高水位、revision、撤回、无会话定位与重连；浏览器验证提醒布局、计时、可访问性及人工操作回归。

**迁移与回滚：**页面和能力分别开关，通知read-model追加迁移。退出控制清理临时效果，保留通知、业务结果与人工数据；关闭新投影后历史仍可读。

## 远程工具接入

**任务：REMOTE。前置：**SERVER的授权、journal、投影、超时取消和unknown恢复通过。

**写域与接口：**server负责人实现mcp/http适配；主负责人修改依赖与配置契约。目标pi-mcp 1.1.0、MCP 2025-11-25兼容；实现时核实官方API并保存互操作证据。

**实现：**首期使用HTTPS Streamable HTTP，凭据通过secretRef绑定bearer/header；OAuth与stdio在后续独立验收。配置登记服务器、服务身份、工具白名单和schema版本；发现工具按本地策略绑定。较早协议版本逐项协商验收，2026-only服务需升级适配器后验证。先接只读工具，再接有稳定幂等键、结果查询、审批和对账的写工具。HTTP工具采用同样的声明与执行规则，可连接任意语言业务服务。

**验证与完成：**真实远端只读调用、schema变化、拒绝未登记工具、跨租户、超时/取消、断线、输出上限、投影与日志脱敏通过；远端写入响应丢失进入unknown并查回唯一结果，重复审批和重试无额外副作用。缺少写入恢复能力的工具保持只读准入。

**迁移与回滚：**配置快照版本化，关闭连接阻止新调用；保留远端调用键、结果和对账路径。凭据由部署环境注入，历史记录使用脱敏引用。

## 独立示例与包发布

**任务：PACKAGE。前置：**四包可构建，SERVER/BROWSER接口稳定，HTTP适配完成。

**写域与接口：**示例负责人独占规划的独立vanilla/Vue订单示例；构建发布与root配置由主负责人整合。示例仅安装发布tarball，以opaque订单/账号/租户ID接入宿主鉴权、业务工具和自定义UI。

**实现：**四包发布Node24 ESM+d.ts，明确exports/files/peerDependencies、技能资源和可选PG入口；构建时验证路径及资源清理边界。订单示例实际安装并使用server/storage-postgres，在独立命名空间显式执行迁移，覆盖会话、订单查询、编辑、确认、结果与导航；HTTP服务使用与SDK解耦的后端契约，提供至少一个非TypeScript宿主服务验证。

**验证与完成：**在AIS工作区外且无源码别名的临时项目安装tarball；Node加载所有公开入口，类型编译通过；浏览器无Node依赖，vanilla无需Vue，server核心无需PG/NATS/Nest。订单示例验证PG持久化、进程重启后的任务/审批/技能快照恢复、幂等、取消、unknown、跨租户和自定义审批UI；Vue与Nuxt薄适配分别验收。参考适配的运行证据与AIS旧表桥接回归分别记录。

**迁移与回滚：**发布批次记录包hash、协议/依赖版本和示例测试；保留前一兼容版本tarball。业务宿主可切回旧包及适配器，持久记录由版本decoder读取。

## 系统迁移、部署与最终验收

**任务：RELEASE。前置：**PACKAGE及拟上线AIS能力通过，迁移兼容矩阵完成。

**写域与接口：**主负责人独占迁移、生成物和发布配置；部署负责人负责infra及运维说明。部署操作唯一入口为[运行说明](../infra/OPERATIONS.md)。

**实现与验证：**

- AIS旧表适配逐类切换，保留任务/消息/结果版本、输入请求和UI历史；确认只有一个执行所有者。
- 每次公共HTTP契约变更补齐schema与文档，使用既有入口生成OpenAPI和前端类型；生成依赖数据库时使用明确隔离环境，检查无关diff与敏感内容。
- 单元、类型、lint、构建、包消费、隔离数据库集成和浏览器分别验收；模拟接口、真实服务＋模型替身、真实模型分别报告。
- 浏览器模拟和真实服务用例分配置，真实服务用例禁止拦截业务API；原分析smoke与新UI真实模型smoke分别记录。
- 当前Docker/K8s模板先验证配置和现有入口；镜像构建、容器启动、K8s实际部署、容量和备份恢复分别给证据。SDK部署接线在实现后追加。
- 发布记录包含协议/包/迁移版本、开关、指标、命令结果与未执行项。监测失败率、unknown、冲突、过期、执行延时及模型投影拒绝。

**完成与回滚：**关闭新能力仍可运行旧分析、人工地图和业务编辑；停止新调用，取消未执行及待批准工作，对账executing/unknown。浏览器注销实例并清理临时资源，业务历史继续可读。追加迁移保留，未知写入禁止盲重放；只有兼容和恢复证据齐备才发布。

## 外部条件与独立验收

**任务：EVIDENCE。前置：**来源授权、目标运行环境或容量预算满足。

**写域与接口：**来源负责人维护适配器及复现样本，部署/性能负责人执行专用环境验收；主负责人汇总报告和状态矩阵。

GDELT真实新闻接入仍需取得可解析报道、归档原文、核验来源和候选关系；既有429、超时与空对象按实际故障保留。AIS正式来源账号、覆盖/保留范围、卫星权限、断流补数分别验证。历史热图百万级多日窗口、生产并发、数据库总查询额度、外部S3权限/TLS、保留策略、生产硬件和备份恢复列入专项验收。

**完成与回滚：**每项给出带时间、环境和版本的真实结果；外部条件缺失时保留待验收，不影响已通过范围的准确交付。失败样本、原文哈希和报告保留。暂停来源或关闭实验能力时保持历史证据，清理按明确保留策略执行。

## 旧计划需求承接

以下三份旧计划退出当前文档入口，其原内容由Git历史保留，历史验证迁入报告。表中待实施项均由本路线图继续管理，完成项保留为回归要求。

| 原计划/章节                                                    | 当前归属与处理                                                                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 海图悬浮输入框：全高地图、唯一会话、右侧对话、键盘输入与窄屏   | 当前[工作台说明](chart-workbench.md)；BASE/COVERAGE持续回归                                                                     |
| 海图悬浮输入框：91项单元与24项浏览器等当时验证                 | [历史验收](reports/chart-agent-composer-2026-10-11.md)，按原模型替身和环境边界记录                                              |
| 情报标绘：契约、对象/关系/审核、版本、候选、地图图层与人工绘制 | 当前[intelligence-chart](intelligence-chart.md)、[intelligence-search](intelligence-search.md)；APP/VERTICAL/COVERAGE复用与回归 |
| 情报标绘：公开来源、原文回放、去重、坐标时间、许可参考         | 当前[intelligence-ingestion](intelligence-ingestion.md)、[osint-reference](osint-reference.md)；EVIDENCE继续GDELT真实新闻验收   |
| 情报标绘：历史集成、真实数据和工作区记录                       | [历史验收](reports/intelligence-2026-10-11.md)与报告索引；保留原时间条件                                                        |
| UI计划：契约冻结、身份/数据引用、五类语义工具及严格错误        | PROTOCOL/SERVER；数据查询作为注册业务工具与UI命令协作，保留能力查询、状态、数据引用、执行与结果查询职责                         |
| UI计划：客户端、会话绑定、租约、幂等、历史、unknown            | BROWSER/SERVER/RELEASE；以SDK版本协议和AIS兼容适配明确当前入口                                                                  |
| UI计划：审批、正式保存、草稿覆盖、两轮挂起、resume CAS         | SERVER/VERTICAL/COVERAGE，保留期限与版本绑定基线                                                                                |
| UI计划：只读详情、临时GeoJSON、人工优先、零隐式写入            | VERTICAL/COVERAGE，保留数据缺失、跨日期变更线与人工布局回归                                                                     |
| UI计划：真实analysis_feed通知、高水位、权限、revision、撤回    | COVERAGE，通知源游标与read-model原子提交、账号无会话操作                                                                        |
| UI计划：回复浮卡、提醒、10秒计时、焦点、详情/定位/关联询问     | COVERAGE，messageId同源、历史不重弹、可访问性；关注/点赞按真实服务准入                                                          |
| UI计划：纯UI/分析/混合任务、补问、匿名引用与出站安全           | SERVER/VERTICAL，按步骤校验条件，所有模型请求统一投影                                                                           |
| UI计划：OpenAPI、模拟/真实服务/真实模型、smoke与截图           | PROTOCOL/RELEASE，生成器与测试配置跟随实际入口更新                                                                              |
| UI计划：开关灰度、指标、取消、回滚、审计保留                   | RELEASE，继续对账已发调用，历史结果可读                                                                                         |

## 任务完成记录要求

每个交付单元记录代码基线、变更与写域、接口/迁移版本、实际命令及结果、模拟边界、未执行验证和回滚演练。测试数量按执行口径说明，重复注册修正后更新计数。格式治理独立处理既有问题，修改文件遵循仓库LF配置。

主负责人在接口、真实链路与回滚证据完整后更新实施状态并判断提交范围。SDK包发布、业务能力开放、生产容量验收分别形成完成记录。
