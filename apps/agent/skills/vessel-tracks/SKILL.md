---
name: vessel-tracks
description: 按船型、船名、MMSI、IMO或已记录型号查询历史航线。
metadata:
  version: '1.0.0'
allowed-tools: query_vessel_tracks
---

# 历史航线

读取 references/tracks.md，调用 query_vessel_tracks；在本地返回结构化航线及计数摘要。查询需要区域、明确时间和船舶目标。型号仅匹配已记录档案。原始船位、标识及用户原文仅供本地处理。
