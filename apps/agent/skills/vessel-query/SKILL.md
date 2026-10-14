---
name: vessel-query
description: 查询当前地图区域中的船舶清单或指定船舶的最新船位与基础信息；适用于船舶列表、单船详情和最新快照请求。
metadata:
  version: '1.0.0'
allowed-tools: query_vessels
---

# 船舶查询

确认用户请求为区域船舶清单或单船详情，并使用宿主已验证的选区与船舶筛选条件。

阅读 [船舶快照说明](references/vessels.md)，再调用 `query_vessels`。由宿主保存本地结果并向界面呈现船舶字段。模型使用受控计数与覆盖摘要组织说明。

说明查询时间、返回数量、截断情况及缺少最新船位的船舶数量。对信息缺失保留明确状态。
