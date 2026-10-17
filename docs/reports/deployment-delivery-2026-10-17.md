# 架构文档、资料整理与部署配置交付核验

核验日期：2026-10-17。交付范围为当前系统架构说明、Agent SDK 目标设计与任务路线、资料整理、Docker Compose 与 Kubernetes 部署模板。应用业务源码和数据库迁移保持原有实现；SDK 抽包、动态 Skill/MCP 与全站业务操控由后续路线图推进。

## 交付入口

- [当前架构](../architecture.md)、[SDK 架构设计](../agent-sdk-architecture.md)、[开发路线图](../agent-sdk-roadmap.md)分别描述现状、目标与后续任务。
- [资料整理记录](cleanup-2026-10-17.md)记录原位置、内容去向、删除依据、草稿承接和资产校验。
- [部署运维说明](../../infra/OPERATIONS.md)统一维护生产 Compose、分阶段 Kustomize、配置注入、发布及恢复步骤。
- [部署检查脚本](../../scripts/check-deployment.ts)及[CI](../../.github/workflows/ci.yml)提供持续静态检查。

## 已执行验证

| 检查                                                        | 实际结果与边界                                                                                                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bun --no-env-file run deployment:check`                    | 4 种 Compose 组合及 6 个生产 Kustomize 阶段渲染通过；检查资源引用、端口、探针、Secret key、凭据分离及应用/init 镜像版本一致性；使用合成参数，未连接 Docker daemon 或集群 |
| `node --import tsx --test scripts/check-deployment.test.ts` | 6 项通过，覆盖有效资源、缺失 Secret key、Service 端口错误、把依赖就绪用作存活探针、运行服务引用初始化凭据及镜像版本不一致                                                |
| `bun --no-env-file run lint`                                | 全工作区通过                                                                                                                                                             |
| `bun --no-env-file run typecheck`                           | 根项目及全部工作区通过，包含 Nuxt 与新增部署检查脚本                                                                                                                     |
| 产品生成与导出路径检查                                      | Python `--check-paths`、Windows PowerShell 5.1 `-CheckPaths`分别在仓库根和产品目录执行通过；未启动 Word 或覆盖正式交付件                                                 |
| 正式产品文件完整性                                          | 主会话对迁移前 HEAD 与迁移后文件逐字节比较，Markdown 和 DOCX 完全一致；图像保留与草稿语义承接见资料整理记录                                                              |

本轮修改与新增文件的定向 Prettier、LF 行尾及 `git diff --check` 通过。31 份 Markdown 中的 130 个本地文件链接和锚点核验通过，旧路径只在迁移依据与历史说明中保留。

全仓 `format:check` 仍报告 31 个未修改文件的既有格式问题，涉及应用源码、生成契约和 fixture；本轮只格式化修改与新增文件。既有格式治理保留为独立任务，CI 中原有全仓格式门禁仍会报告这些问题。

本轮只对资料路径和部署检查代码执行相关验证。既有应用单测、业务集成、浏览器和构建的历史证据保留原日期，当前能力和待验证范围由[实施状态](../implementation-status.md)汇总。

审查还发现 `scripts/heatmap-build-smoke.ts` 保留三个技能的断言，与当前四份技能目录不一致。这是源码静态核对得到的现有烟测入口问题，本轮未运行该烟测；修正和重新验收已进入路线图 BASE，既有历史通过记录继续保留其原日期。

## 环境验证边界

本机 Docker Compose 为 v5.1.4，kubectl 为 v1.34.1，内置 Kustomize 为 v5.7.1。`docker version` 的服务端检查报告 `dockerDesktopLinuxEngine` 管道不存在，当前 Docker 引擎未运行。

以下验证留待具备对应运行环境时执行，并形成单独记录：生产镜像构建与 Node/Chromium 运行、Caddy 配置实际加载、容器健康与终止行为、Kubernetes server dry-run、真实集群部署、Ingress/TLS/WebSocket 与客户端 IP、PVC 权限、外部 S3 权限和生命周期、备份恢复及生产容量。静态检查通过仅证明模板解析及仓库约定的一致性；目标集群的 API schema、准入策略、CNI、存储和负载能力仍由环境验收确认。

## 发布与复核

生产配置中的镜像、域名、IngressClass、TLS Secret、可信 Ingress 来源、存储类与密钥均由部署人员按运维说明填写。发布按基础组件就绪、同版本初始化成功、应用上线的顺序执行。初始化会配置专用 S3 桶的生命周期，使用独立初始化凭据；当前单实例存储和单副本应用的可用性边界随模板保留。

三个子智能体分别承担文档、资料整理与部署，主会话完成共享配置、独立运行验证和交叉审查。清理前建立内容去向，旧计划在新文档承接后收口；独有素材及成功、失败历史证据继续保留。
