---
name: vessel-highlight
description: 查询并高亮任务关联船舶，执行由大收拢和连续三次闪烁提醒，支持清除本页高亮组。
metadata:
  version: '1.0.1'
allowed-tools: prepare_vessel_highlights
---

# 船舶高亮

通过宿主查询解析 MMSI、船名、IMO、呼号、AIS 船型和已登记型号。名称有多个候选时请用户明确 MMSI。一次最多高亮 100 艘，结果超限时缩小范围；没有有效船位时说明原因。
使用 prepare_vessel_highlights 生成强类型产物，再由 chart.vessel-highlights 执行。每组由任务和产物标识绑定，同船跨组取并集。
首次高亮从较大范围收拢到目标，随后连续闪烁三次，结束后保持稳定关注环并跟随最新 AIS 船位。减少动态效果时保持静态标记。页面刷新后消失。
默认保持镜头，只有明确要求高亮并聚焦才组合 map-camera。清除操作限定当前用户、浏览器页面内已核验的高亮组。
排队及产物准备均属于中间状态，实际展示、清除和镜头成功以浏览器回执为准。
