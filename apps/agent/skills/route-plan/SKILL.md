---
name: route-plan
description: 查询计划航线并从真实起终点进行航线规划。
metadata:
  version: '1.0.0'
allowed-tools: query_routes read_route plan_route
---

# 查询计划航线并从真实起终点进行航线规划

用户坐标和引用由宿主绑定。规划任务等待真实后台作业完成，取消时关闭作业；普通规划只保存规划产物。
