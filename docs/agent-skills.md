# Agent 技能与能力扩展

Agent 使用随应用发布的内置技能与账号私有的声明式技能，以代码注册的工具完成业务操作。`apps/agent/skills` 保存内置说明与参考文档，`apps/agent/capabilities` 负责目录校验、权限收窄、工具执行和恢复记录，`apps/agent/business-capabilities.ts` 将框架接入现有运行时端口。私有技能通过数据库保存不可变版本，配置入口位于“智能研判 → 我的技能”。

本文记录内置 AIS 技能接入方式。账号技能的自动创建、校验发布、动态加载与多步骤产物见[账号动态技能](agent-dynamic-skills.md)。通用文件目录刷新、独立工具宿主与远程 MCP 继续按[SDK 目标架构](agent-sdk-architecture.md)和[路线图](agent-sdk-roadmap.md)推进。

## 当前能力目录

下表列出内置能力。账号私有技能统一采用 `skill` 意图与 `skillRef={skillId,version?}`，版本绑定、工具授权和任务产物独立保存。

| 能力                  | 意图                           | 基础必填输入                   | 运行方式                                   |
| --------------------- | ------------------------------ | ------------------------------ | ------------------------------------------ |
| `ais-heatmap`         | `ais_heatmap`                  | 区域、时间范围                 | 本地查询与聚合，以每格去重船舶数形成热力图 |
| `vessel-query`        | `vessel_list`、`vessel_detail` | 列表需要区域；详情需要船舶     | 本地查询                                   |
| `vessel-tracks`       | `vessel_tracks`                | 船舶筛选条件、区域、时间范围   | 本地查询历史轨迹、持久快照与受控展示       |
| `intelligence-search` | `intelligence_search`          | 公开情报主题                   | 模型编排受控工具                           |
| `ui-control`          | `ui_control`                   | 已绑定且在线的页面与支持的动作 | 本地有限语义解析、界面命令与执行回执       |
| `vessel-highlight`    | `vessel_highlights`            | 船舶目标或明确的清除范围       | 查询船位、任务组高亮及绘制回执             |
| `map-camera`          | `map_camera`                   | 船舶、坐标、区域或缩放参数     | 受控镜头移动、人工接管及实际位置回执       |
| `region-analysis`     | `analysis`                     | 分析目标、区域、时间范围       | 现有区域研判流程                           |

`CapabilityDefinition` 和目录项包含 `intents`、按意图分组的 `requiredInputs`、`executionMode` 与 `available`。`available` 表示能力已安装并启用；远程数据源是否健康由来源状态工具报告。基础输入之外的条件追问，例如情报时间范围不明确，继续由 `requiredAgentInputFields` 判断。

技能能力的 `description` 统一来自 `SKILL.md`。`buildCapabilityDirectory(catalog)` 将这些描述与代码持有的路由元数据合并，区域研判保留独立的兼容流程说明。

## 新增技能

在 `apps/agent/skills/<skill-id>/SKILL.md` 中编写 YAML frontmatter 和 Markdown 正文。格式遵循 [Agent Skills 规范](https://agentskills.io/specification)，本项目对可加载资源采用更小的可信范围。

```yaml
---
name: sample-query
description: 查询指定范围的业务记录；适用于用户请求该类记录的清单或摘要。
metadata:
  version: '1.0.0'
allowed-tools: query_sample
---
```

名称须与目录一致，长度为 1～64 个字符，使用小写字母、数字及单个连接符。描述长度为 1～1024 个字符。正文写经过审查的使用说明，引用使用 `references/<文件名>.md`。

随后按以下顺序接入：

1. 在 `BUILTIN_SKILL_BINDINGS` 中登记技能版本、适配器版本、工具标识和参考文件白名单，在路由元数据中登记意图、输入与运行方式。
2. 使用 `defineTool` 编写输入 schema、输出 schema、允许阶段、业务 handler 和模型投影 `project`。handler 返回本地完整结果，投影只返回该能力允许提供给模型的字段。
3. 通过 `bindBusinessCapability` 绑定技能，将工具传给返回的 `executor`。能力所需的新宿主端口由运行时提供，并沿用任务所有权、输入修订和执行代次的写入检查。
4. 补充目录加载、授权范围、阶段校验、预算拒绝、执行失效、恢复与模型投影测试。新意图还需在领域输入校验、契约、接口和前端结果展示中完成对应接入。

当前随应用打包七份内置技能：`ais-heatmap`、`vessel-query`、`vessel-tracks`、`intelligence-search`、`ui-control`、`vessel-highlight`、`map-camera`。区域研判保留兼容能力目录项。新增技能时同步更新绑定、`check-skills.ts`、内置目录测试和业务路由的预期。

高亮与镜头可分别调用，也可组合执行。目标查询、前端接口、回执和迁移见[船舶高亮与镜头技能](agent-map-skills.md)。

历史航线技能接受 AIS 船型、具体型号和船舶相关信息，由后端查询已有档案与历史观测。型号字段、查询限制和绘制回执见[船舶历史航线](vessel-tracks.md)。

## 绑定与权限来源

工具可执行范围由代码中的 `SkillToolBinding.toolIds` 授予。`SKILL.md` 的 `allowed-tools` 可声明其非空子集；省略该字段时使用代码绑定全集。重复声明及绑定范围外的工具会导致加载失败。运行时根据加载后的 `metadata.toolIds` 筛选工具，因此技能说明只能收窄权限。

`ToolExecutionIdentity` 由宿主从任务记录注入，包含 `ownerId`、`taskId`、`inputRevision` 和 `generation`。工具阶段也由宿主指定。模型参数通过工具输入 schema 校验，任务身份与阶段不交由模型覆盖。

加载器使用 YAML 库解析 frontmatter，检查目录名称、重复项、工具绑定、文件大小及真实路径边界。默认单文件上限为 64 KiB，总内容上限为 512 KiB。技能目录只接受 `SKILL.md` 和代码白名单内的 `references/*.md`；脚本、任意附件与其他路径会被拒绝。技能正文禁止混入用户原文、逐点 AIS 或外部页面指令，也不提供任意路径读取或代码执行入口。

内置目录加载后形成不可变快照。`contentHash` 覆盖完整技能文档、引用正文、代码绑定工具集合、技能版本与适配器版本。内置目录由工作进程缓存；更新随应用发布并重启进程加载。账号私有目录按数据库修订读取，新任务绑定具体版本与摘要，在途任务保存自身绑定。通用文件目录的原子刷新由 SDK 的 SERVER 任务推进。

## 预算、审计与恢复

以下执行顺序适用于已接入 `CapabilityExecutor` 的路径。当前 UI 运行时使用 `SkillSession` 激活技能，并单独调用预算、状态读取和命令端口；区域研判保留独立封装。全路径统一阶段、授权、预算、journal 与模型投影由 SERVER 任务推进。

`CapabilityExecutor` 按顺序执行能力与工具查询、阶段检查、输入校验、`active` 检查、一次 `reserve('tool', maximum)`、handler、输出校验、模型投影、再次 `active` 检查及审计写入。预算拒绝时返回 `budget`；任务失效、取消或审计写入失败时返回 `fenced`。业务结果持久化由宿主端口负责。

工具成功审计以稳定的 `tool.id` 保存步骤名称，展示文案保存在 `output.displayName`。步骤键包含输入修订、执行代次和独立 UUID，保留每次调用记录。审计元数据记录工具、能力、身份和阶段；完整业务结果通过对应结果存储保存。

`SkillSession.activate` 与每个 `readReference` 首次成功执行时各占一次工具预算。读取参考前须在当前会话激活对应技能。AIS 热力图和船舶查询通常各包含激活、参考读取、业务查询三次工具调用；模型调用由运行时单独计费。

技能回执记录 `SkillBinding` 和任务身份。同一任务、所有者与输入修订下，已保存的激活或引用步骤可在新的执行代次恢复，验证绑定与当前执行状态后复用，免于重复计费。同一会话中的并发重复读取会合并为一次操作。新的输入修订使用新的步骤键。

恢复时如技能版本、适配器版本或内容摘要发生变化，返回 `skill_changed`。步骤记录损坏或身份不匹配返回配置错误。预算预留与回执保存是两个端口调用；预留后中断且尚未形成已保存回执的尝试，后续重试仍可能再次计费。

## 构建与生产检查

以下命令在仓库根目录运行：

```powershell
bunx vitest run apps/agent/capabilities scripts/build-skill-assets.test.ts
bunx tsc --noEmit -p apps/agent/tsconfig.json
node --import tsx scripts/build.ts --workspace agent
bun run agent:skills:check
```

构建先验证仓库、Agent、`dist` 和已有 `dist/skills` 的真实路径，再仅替换技能资源目录，保留其他产物。增量构建会清除源目录已删除的技能与参考文件。输出目录被符号链接重定向时构建拒绝清理。

源码加载路径相对 `capabilities` 解析；构建通过 `__AGENT_SKILLS_BUNDLED__` 切换为产物旁的 `skills` 目录。`dist/check-skills.mjs` 使用与服务相同的加载器，打印七个内置技能的版本和摘要，无需模型密钥。该检查验证打包资源和加载配置；业务接口、数据库及模型执行分别由对应测试验证。

## 目标扩展入口

通用 SDK 将配置化技能、进程内工具、HTTP 与 MCP 工具接入同一注册表及执行宿主。具体接口、授权交集、模型投影、未知结果对账和 Pi 适配版本以[SDK 目标架构](agent-sdk-architecture.md)为准，实施与验收以路线图 SERVER、REMOTE 和 PACKAGE 任务为准。
