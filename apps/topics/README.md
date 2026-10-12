# 专题计算进程

`bun run --cwd apps/topics dev` 启动专题消费者与调度器。部署通过 `TOPIC_DEFINITION_ID=port-restriction` 或 `area-low-speed-notice` 启动独立专题进程；同一基础设施中的每个实例拥有自己的 JetStream durable consumer。`INTERNAL_METRICS_PORT` 默认 `13108`，多进程部署分别配置端口。

专题定义登记算法版本与所需能力，实例保存配置、启停代次和检查点，运行保存输入时间范围、输入快照、配置快照、租约及尝试次数。启用后执行历史预热；恢复启用保留检查点并按历史窗口分块追赶。修改配置建立新代次并重新预热。当前在线 AIS 历史保留 30 天，超出范围会明确失败，需恢复归档后再计算。

数据就绪消息先事务写入收件记录和待复算时间范围，提交后 ACK。重复事件通过实例、代次、事件标识去重，高频事件合并为待处理时间范围；调度器分块创建运行。每个实例同一时间执行一个运行，失效租约可回收，最多尝试五次。输入快照、结果修订和持久通知形成可回放证据。结果通知重试十次，失败详情留在 `analysis_feed.last_error`。系统通过 `GET /analysis/feed` 提供持久历史补取，实时网关使用带代次过滤的读取函数。

港口限制规则在公告有效时间、专题区域、公告边界框及船舶条件的交集内匹配；MMSI 和船型均为空表示适用于全部船舶。船型取对应时刻的静态观测，并保留该观测快照。区域低速专题报告首次达到配置点数的低速观测窗口，属于时空共现，需结合完整轨迹和原文人工核验。结果使用稳定船舶对象、专题实例及公告逻辑标识生成身份，原始 MMSI 保留用于展示与追溯。

## 跨语言协议

部署环境可设置 `TOPIC_EXECUTOR_COMMAND` 为 JSON 参数数组，例如：

```powershell
$env:TOPIC_DEFINITION_ID = 'port-restriction'
$env:TOPIC_EXECUTOR_COMMAND = @('python', (Resolve-Path apps/topics/examples/port_restriction.py).Path) | ConvertTo-Json -Compress
bun run --cwd apps/topics dev
```

实际脚本路径应相对于工作目录，生产建议使用绝对路径。命令通过 `spawn` 直接执行，配置只来自进程环境。执行器只接收业务输入，进程环境只传入运行所需的 PATH、SystemRoot、TEMP 和 Python 编码设置。

标准输入为单个 JSON 文档：

```json
{
  "protocolVersion": 1,
  "instance": { "id": "...", "definitionId": "port-restriction", "config": {} },
  "dataset": { "from": "...", "to": "...", "queriedAt": "...", "ais": [], "intelligence": [] }
}
```

完整字段定义见 `packages/contracts/topics.ts` 中 `TopicInstance`、`TopicDataset`。标准输出为 `{"protocolVersion":1,"results":[...]}`，结果遵守 `AnalysisResultSchema`。诊断信息写 stderr。执行超时为 60 秒，输入和输出各限制 32 MiB，结果证据必须与输入快照深度一致，身份必须按 JSON 元组 `[instanceId,definitionId,sourceId,externalId,vesselId]` 的 UTF-8 SHA-256 计算（未关联稳定对象的旧记录使用 MMSI）。执行器返回 `status: "active"`，最终修订号和撤回状态由持久化层维护。

`examples/port_restriction.py` 是仅依赖 Python 标准库的可执行示例，其真实非空输出由协议测试覆盖。新增专题时，在契约的定义标识、领域 `TOPIC_DEFINITIONS` 清单和计算入口中登记算法；计算语言可独立选择，持久化、消息订阅、权限和结果补取共用相同协议。算法行为变化时同步升级定义版本。`graph.query` 当前能力为不可用，依赖它的定义会在运行前拒绝启用。

## 管理接口

- `GET /topics`：定义、实例和能力。
- `POST /topics/instances`：创建实例，管理员权限。
- `PUT /topics/instances/:id/state`：启停，管理员权限。
- `PUT /topics/instances/:id/config`：配置更新，管理员权限。
- `POST /topics/instances/:id/run`：手动运行，操作员权限，要求 `Idempotency-Key` UUID。
- `GET /topics/instances/:id/runs` 和 `GET /topics/runs/:id`：运行与输入快照。
- `GET /analysis/results`、`GET /analysis/results/:id`、`GET /analysis/results/:id/revisions`：结果与原始证据。
- `GET /analysis/feed?cursor=0`：持久通知；空页保留原游标。

上述路径均位于 `/api/v1` 下，沿用平台登录、角色和 CSRF 校验。
