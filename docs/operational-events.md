# 独立业务事件

事件中心把情报和专题分析转为可维护的业务事件。事件生命周期由用户管理，来源审核、撤回和修订独立保存在来源记录中。空间未知时 `geometry` 为 `null`，可靠级别缺失时 `severity` 为 `unknown`。

## 接口

接口前缀为 `/api/v1/operational-events`，沿用登录会话、Origin 和 CSRF 检查。读取面向 viewer 及以上角色；创建、更新、合并要求 operator；历史回填要求 admin。

| 方法与路径                        | 功能                                                                  |
| --------------------------------- | --------------------------------------------------------------------- |
| `GET /`                           | `keyword`、`status`、`limit`、`offset` 查询，返回 `items` 和 `total`  |
| `POST /`                          | 创建事件，正文包含 `operationId` 和事件字段                           |
| `GET /:id`                        | 获取当前事件，旧合并 ID 自动解析到目标                                |
| `PATCH /:id`                      | 使用 `expectedRevision` 修改 `fields`、`releaseOverrides` 或 `status` |
| `POST /:id/merge`                 | 指定 `targetId`、双方修订号和 `primarySourceKey` 合并                 |
| `GET /:id/history`                | 当前 ID 的不可变业务修订                                              |
| `GET /:id/sources`                | 来源建议值、版本、审核和撤回状态                                      |
| `GET /:id/source-history?key=...` | 指定附属来源的不可变修订                                              |
| `POST /backfill`                  | 将既有来源重新纳入幂等同步并消费首批待处理记录                        |

圆形查询使用 URL 编码后的 JSON `circle={"kind":"circle","center":[120,30],"radiusMeters":1000}`。PostGIS `ST_DWithin` 在分页和总数统计之前执行，点、线、面均按与精确公里范围的最短测地距离匹配。分页及总数来自同一 SQL 快照。

`PATCH.fields` 只包含用户明确提交的字段。人工修改形成字段覆盖；`releaseOverrides` 恢复对应来源建议值。一个字段同次提交修改和解除覆盖会返回验证错误；解除覆盖要求存在来源建议值。归档与恢复分别提交 `status: archived` 和 `status: active`。

## 来源同步

情报稳定键为 JSON 数组 `["intelligence", sourceId, externalId]`；专题稳定键为 `["analysis", analysisResultId]`。来源生产端在原业务事务中保存完整快照、单调修订和独立 `event_sync_outbox`。相同快照通过规范化指纹去重；旧业务版本无法覆盖新版本；同版本审核和空间关系变化会产生新来源修订。

消费者使用 `FOR UPDATE SKIP LOCKED` 领取记录、来源 advisory lock 串行应用，并比较已应用修订抵御乱序投递。业务事件更新和消费回执同事务提交。来源修订始终保留，自动刷新主来源建议值，人工覆盖和业务状态持续保留。合并要求双方当前修订匹配，锁按 UUID 排序，指定来源必须属于任一参与事件；来源归属随合并移动，迟到更新进入目标事件。

情报空间投影采用已确认关系中最高维度的全部几何组合；原始关系及其他维度仍在来源情报中保留。专题范围来自结果自身的业务范围，跨日期变更线拆成两个多边形。来源撤回保留位置、历史和撤回标记。

API 启动 `startOperationalEventSync` 后先进行可重入历史回填，再每秒消费最多 100 条；`stop()` 返回 Promise 并等待在途工作完成。关闭 `EVENT_SYNC_ENABLED` 时生产事务继续保存 outbox，重新开启后补齐投影。worker 暴露 `metrics.applied`、`metrics.failures`、`metrics.lagSeconds`，并记录失败日志，失败事务保留待处理项及错误信息。

## 写入恢复

`createOperationalEvent`、`updateOperationalEvent`、`mergeOperationalEvents` 接收真实 `{id, role}` actor，并在事务内重新读取账号角色和禁用状态。`options.beforeWrite(client)` 在实际写入前及业务变更完成、审计与操作回执写入前各执行一次，用于检查任务代次、输入修订、取消和时限栅栏；调用者应在该事务中锁定相应任务状态。

用户 ID 与 `operationId` 构成幂等键；同键同输入返回持久回执，同键异输入返回冲突。业务记录、不可变修订、审计和操作回执在同一事务提交。恢复时先返回已提交回执，再考虑新的写入栅栏；后续任务取消保留此前已提交结果。地图展示确认由地图链路单独管理。

## 验证

`operational-event.test.ts` 覆盖字段覆盖、PATCH 缺省值及规范化去重。`operational-event.integration.test.ts` 在 PostgreSQL/PostGIS 实际验证重复与并发消费、旧版本、覆盖解除、合并后迟到更新、写入回执、取消回滚、账号权限、圆形分页，以及原文不可变条件下的审核与关系修订传播。

## 运行指标

API 每次抓取时从持久表聚合业务指标，`GET /api/v1/system/metrics` 要求 admin 会话，独立 operations 服务的 `GET /metrics` 通过受控监听地址供 Prometheus 抓取。指标标签仅使用固定状态与业务类型枚举。

- `ais_event_sync_pending`：待应用来源快照数量。
- `ais_event_sync_lag_seconds`：最早待应用快照的等待秒数；队列为空时为 0。
- `ais_event_sync_failed_attempts`：outbox 保留记录中的失败尝试累计数，成功消费的一次尝试从 attempts 中扣除。
- `ais_business_operation_receipts{kind="event"}`：当前保留的持久幂等回执数量；`kind="route"` 对应航线写入。
- `ais_focus_ui_failures`：状态为 failed/rejected 的空间关注 UI 命令数量，按最终命令状态统计。

以上指标为数据库当前状态的 gauge，清理对应历史记录后数值会变化。聚合读取失败时独立 scrape 接口返回 503。航线与事件的持久回执恢复路径记录固定 `kind` 和 `idempotent_hit=true` 结构化日志；规划失败日志使用有限 `reason` 枚举，未知原因归入 `planning_failed`。HTTP scrape 单测及真实 PostgreSQL 聚合查询均纳入回归，标签包含业务 ID、坐标或用户标识属于禁止项。
