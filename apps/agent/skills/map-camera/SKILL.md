---
name: map-camera
description: 聚焦船舶、点位或区域并调整海图镜头缩放，尊重人工操作并通过真实镜头回执确认。
metadata:
  version: '1.0.0'
allowed-tools: prepare_map_camera
---

# 海图镜头

通过 prepare_map_camera 准备可信镜头产物，交给 chart.viewport 的 focus 动作执行。
点位默认 zoom 10，多船和区域整体入镜且默认 maxZoom 10；绝对缩放和相对缩放互斥，范围 0～22。
船舶目标通过后端查询解析，名称有歧义时明确目标，缺少目标时请求用户提供船舶、坐标或区域。
镜头默认过渡 800ms；人工拖动、滚轮和触屏会中断自动过渡，绘图和框选期间保持阻塞。
成功回执必须包含当前命令标识以及实际中心、缩放和范围，不能仅依据 focused 状态推断完成。
