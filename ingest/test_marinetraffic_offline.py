"""离线验证 MarineTraffic API 客户端：URL 构造、字段映射、入库。

不联网、不需要密钥：python ingest/test_marinetraffic_offline.py
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from marinetraffic_api import (  # noqa: E402
    MarineTrafficClient,
    MarineTrafficError,
    parse_ts,
    row_to_position,
    row_to_static,
)
from store import AisStore  # noqa: E402

# MarineTraffic 返回记录的结构示意（字段名做了多写法覆盖测试）
RECORD_FULL = {
    "MMSI": "413793000",
    "IMO": "9601234",
    "SHIPNAME": "XIN HAI TONG 23",
    "CALLSIGN": "BQAB2",
    "SHIPTYPE": "70",
    "LAT": "33.31234",
    "LON": "124.91234",
    "SPEED": "12.3",
    "COURSE": "87.5",
    "HEADING": "91",
    "NAVSTAT": "0",
    "DESTINATION": "SHANGHAI",
    "ETA": "09-30 08:30",
    "DRAUGHT": "8.5",
    "TIMESTAMP": "2026-09-29 06:42:13",
    "STATUS": "0",
}

# 字段名大小写/下划线变体 + Unix 时间戳
RECORD_VARIANT = {
    "mmsi": "412345678",
    "shipname": "CLASS B BOAT",
    "lat": "33.9",
    "lng": "126.5",
    "sog": "6.0",
    "cog": "180.0",
    "timestamp": 1791000000,
}

# 缺经纬度，应被丢弃
RECORD_INCOMPLETE = {"MMSI": "999000111", "SHIPNAME": "NO POS"}

# 区域外坐标，应被 bbox 过滤
RECORD_OUTSIDE = {
    "MMSI": "222000333",
    "SHIPNAME": "OUTSIDE",
    "LAT": "10.0",
    "LON": "10.0",
    "TIMESTAMP": "2026-09-29 07:00:00",
}

YELLOW_SEA_BOX = [[31.5, 122.0], [35.5, 127.5]]
REGIONS = ["yellow_sea"]

failures: list[str] = []


def check(label: str, actual, expected) -> None:
    if actual != expected:
        failures.append(f"{label}: 期望 {expected!r}，实际 {actual!r}")
        print(f"  [FAIL] {label}: 期望 {expected!r}，实际 {actual!r}")
    else:
        print(f"  [ok]   {label} = {actual!r}")


def main() -> int:
    print("1) URL 构造")
    client = MarineTrafficClient("TESTKEY", transport=lambda url, timeout: (200, "[]"))
    url = client.build_url(
        "exportvessels",
        {"minlat": 31.5, "maxlat": 35.5, "minlon": 122.0, "maxlon": 127.5,
         "timespan": 30, "minspeed": 0, "msgtype": "extended"},
    )
    check("路径含服务与版本", "exportvessels/v:8/TESTKEY/protocol:jsono" in url, True)
    check("路径为 https", url.startswith("https://services.marinetraffic.com/api/"), True)
    check("参数在查询串", "minlat=31.5" in url and "maxlon=127.5" in url, True)
    check("None 参数被忽略", "None" not in url, True)

    print("\n2) 时间字段归一化")
    check("空格分隔时间", parse_ts("2026-09-29 06:42:13"), "2026-09-29T06:42:13.000Z")
    check("Unix 秒", parse_ts(1791000000), "2026-10-03T04:00:00.000Z")
    check("Unix 毫秒", parse_ts(1791000000000), "2026-10-03T04:00:00.000Z")
    check("ISO 输入", parse_ts("2026-09-29T06:42:13"), "2026-09-29T06:42:13.000Z")

    print("\n3) 记录映射为轨迹点")
    row = row_to_position(RECORD_FULL, REGIONS, [YELLOW_SEA_BOX])
    check("mmsi 为 int", row[0], 413793000)
    check("时间", row[1], "2026-09-29T06:42:13.000Z")
    check("纬度", row[2], 33.31234)
    check("经度", row[3], 124.91234)
    check("航速", row[4], 12.3)
    check("航向", row[5], 87.5)
    check("艏向 91", row[6], 91.0)
    check("航行状态", row[7], 0)
    check("航速航向为 None", row[8], None)
    check("船名", row[9], "XIN HAI TONG 23")
    check("海域命中", row[10], "yellow_sea")

    print("\n4) 字段名变体与 lng 别名")
    row = row_to_position(RECORD_VARIANT, REGIONS, [YELLOW_SEA_BOX])
    check("经度取 lng", row[3], 126.5)
    check("航速取 sog", row[4], 6.0)
    check("船名", row[9], "CLASS B BOAT")

    print("\n5) 过滤规则")
    check("缺经纬度被丢弃", row_to_position(RECORD_INCOMPLETE, REGIONS, None), None)
    check("范围外被 bbox 过滤", row_to_position(RECORD_OUTSIDE, REGIONS, [YELLOW_SEA_BOX]), None)
    check("不传 bbox 时保留",
          row_to_position(RECORD_OUTSIDE, REGIONS, None)[10], "unknown")

    print("\n6) 记录映射为静态资料")
    stat = row_to_static(RECORD_FULL)
    check("mmsi", stat[0], 413793000)
    check("imo", stat[1], 9601234)
    check("呼号", stat[2], "BQAB2")
    check("船名", stat[3], "XIN HAI TONG 23")
    check("船型", stat[4], 70)
    check("目的港", stat[9], "SHANGHAI")
    check("吃水", stat[11], 8.5)

    print("\n7) 响应形态兼容")
    for label, body, expect in (
        ("裸数组", json.dumps([RECORD_FULL]), 1),
        ("data 包裹", json.dumps({"data": [RECORD_FULL, RECORD_VARIANT]}), 2),
        ("单对象", json.dumps(RECORD_FULL), 1),
    ):
        c = MarineTrafficClient("K", transport=lambda u, t, b=body: (200, b))
        check(label, len(c.call("exportvessels", minlat=1)), expect)

    print("\n8) 错误处理")
    c = MarineTrafficClient("K", transport=lambda u, t: (401, "Unauthorized"))
    try:
        c.call("exportvessels", minlat=1)
        failures.append("401 未抛异常")
        print("  [FAIL] 401 未抛异常")
    except MarineTrafficError as exc:
        check("401 抛出可读错误", "401" in str(exc), True)
        check("错误信息不外泄密钥", "K" not in str(exc).replace("KEY", ""), True)

    c = MarineTrafficClient("K", transport=lambda u, t: (200, "<html>not json"))
    try:
        c.call("exportvessels", minlat=1)
        failures.append("非 JSON 未抛异常")
        print("  [FAIL] 非 JSON 未抛异常")
    except MarineTrafficError as exc:
        check("非 JSON 抛出可读错误", "非 JSON" in str(exc), True)

    try:
        MarineTrafficClient("K", transport=lambda u, t: (200, "[]")).call("nosuchservice")
        failures.append("未知服务未抛异常")
        print("  [FAIL] 未知服务未抛异常")
    except MarineTrafficError:
        check("未知服务被拒绝", True, True)

    try:
        MarineTrafficClient("")
        failures.append("空密钥未抛异常")
        print("  [FAIL] 空密钥未抛异常")
    except MarineTrafficError:
        check("空密钥被拒绝", True, True)

    print("\n9) 入库（与 AIS 采集器共用表结构）")
    with tempfile.TemporaryDirectory() as tmp:
        store = AisStore(Path(tmp) / "mt.sqlite")
        store.start_run("2026-09-29T07:00:00.000Z", REGIONS)
        records = [RECORD_FULL, RECORD_VARIANT, RECORD_INCOMPLETE, RECORD_OUTSIDE]
        positions = 0
        for rec in records:
            pos = row_to_position(rec, REGIONS, [YELLOW_SEA_BOX])
            if pos:
                store.insert_position(pos)
                positions += 1
            stat = row_to_static(rec)
            if stat and stat[3]:
                store.upsert_static(stat)
        store.commit()

        check("入库轨迹点数", positions, 2)
        totals = store.summary()
        check("去重后轨迹点", totals["positions"], 2)
        check("船舶数", totals["vessels"], 2)
        check("静态资料数", totals["static"], 4)

        joined = store.conn.execute(
            """SELECT p.ship_name, s.destination, s.imo
               FROM vessel_latest p LEFT JOIN vessel_static s ON s.mmsi = p.mmsi
               WHERE p.mmsi = 413793000"""
        ).fetchone()
        check("视图关联静态资料", joined, ("XIN HAI TONG 23", "SHANGHAI", 9601234))

        by_region = dict(
            store.conn.execute(
                "SELECT region, COUNT(*) FROM vessel_position GROUP BY region"
            ).fetchall()
        )
        check("海域分布", by_region, {"yellow_sea": 2})
        store.close()

    print()
    if failures:
        print(f"失败 {len(failures)} 项：")
        for item in failures:
            print(f"  - {item}")
        return 1
    print("全部通过 ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())
