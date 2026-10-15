"""预置观测海域。

bounding_box 格式与 aisstream.io 订阅一致：
[[lat_min, lon_min], [lat_max, lon_max]]
"""

REGIONS: dict[str, dict] = {
    # 黄海中部（之前查看的 124.9E / 33.3N 一带）
    "yellow_sea": {
        "name": "黄海中部",
        "bounding_box": [[31.5, 122.0], [35.5, 127.5]],
    },
    # 北大西洋（-44.5E / 37.0N 一带）
    "north_atlantic": {
        "name": "北大西洋",
        "bounding_box": [[33.0, -49.0], [41.0, -40.0]],
    },
    # 东海北部
    "east_china_sea": {
        "name": "东海北部",
        "bounding_box": [[28.0, 121.0], [32.0, 127.0]],
    },
    # 全球（数据量大，仅建议短时观测）
    "global": {
        "name": "全球",
        "bounding_box": [[-90.0, -180.0], [90.0, 180.0]],
    },
}


def resolve_regions(names: list[str]) -> tuple[list[list[list[float]]], list[str]]:
    """把区域名解析成 bounding box 列表与规范化名称列表。"""
    boxes: list[list[list[float]]] = []
    labels: list[str] = []
    for raw in names:
        key = raw.strip().lower()
        if key not in REGIONS:
            known = ", ".join(sorted(REGIONS))
            raise SystemExit(f"未知海域: {raw}\n可选: {known}")
        boxes.append(REGIONS[key]["bounding_box"])
        labels.append(key)
    return boxes, labels


def match_region(lat: float, lon: float, regions: list[str]) -> str:
    """判断坐标落在哪个已订阅海域内，用于给记录打标签。"""
    for key in regions:
        (lat_min, lon_min), (lat_max, lon_max) = REGIONS[key]["bounding_box"]
        if lat_min <= lat <= lat_max and lon_min <= lon <= lon_max:
            return key
    return "unknown"
