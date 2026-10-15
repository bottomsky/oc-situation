"""离线验证：用 aisstream.io 的真实报文样例跑通解析 + 落库全链路。

不依赖 API Key，可直接运行：python ingest/test_offline.py
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ais_collector import parse_position, parse_static  # noqa: E402
from store import AisStore  # noqa: E402

# aisstream.io 真实报文结构（黄海中部坐标）
POSITION_REPORT = {
    "MessageType": "PositionReport",
    "MetaData": {
        "MMSI": 413793000,
        "MMSI_String": 413793000,
        "ShipName": "XIN HAI TONG 23 ",
        "latitude": 33.31234,
        "longitude": 124.91234,
        "time_utc": "2026-09-29 06:42:13.123456 +0000 UTC",
    },
    "Message": {
        "PositionReport": {
            "Cog": 87.5,
            "Latitude": 33.31234,
            "Longitude": 124.91234,
            "MessageID": 1,
            "NavigationalStatus": 0,
            "RateOfTurn": -2,
            "RepeatIndicator": 0,
            "Sog": 12.3,
            "Spare": 0,
            "Timestamp": 42,
            "TrueHeading": 91,
            "UserID": 413793000,
            "Valid": True,
        }
    },
}

# 哨兵值场景：航速 1023、航向 3600、艏向 511 均表示“不可用”
POSITION_SENTINEL = {
    "MessageType": "PositionReport",
    "MetaData": {
        "MMSI": 999000111,
        "ShipName": "TEST SENTINEL@@@@@@@@@@@@",
        "latitude": 33.5,
        "longitude": 126.0,
        "time_utc": "2026-09-29 06:43:00.000000 +0000 UTC",
    },
    "Message": {
        "PositionReport": {
            "Cog": 3600,
            "Latitude": 33.5,
            "Longitude": 126.0,
            "NavigationalStatus": 1,
            "RateOfTurn": -128,
            "Sog": 1023,
            "TrueHeading": 511,
            "UserID": 999000111,
            "Valid": True,
        }
    },
}

# 区域外坐标，应打上 unknown 标签
POSITION_OUTSIDE = {
    "MessageType": "PositionReport",
    "MetaData": {
        "MMSI": 222000333,
        "ShipName": "OUTSIDE",
        "latitude": 10.0,
        "longitude": 10.0,
        "time_utc": "2026-09-29 06:44:00.000000 +0000 UTC",
    },
    "Message": {
        "PositionReport": {
            "Cog": 180.0,
            "Latitude": 10.0,
            "Longitude": 10.0,
            "NavigationalStatus": 5,
            "RateOfTurn": 0,
            "Sog": 0.1,
            "TrueHeading": 180,
            "UserID": 222000333,
            "Valid": True,
        }
    },
}

SHIP_STATIC = {
    "MessageType": "ShipStaticData",
    "MetaData": {
        "MMSI": 413793000,
        "ShipName": "XIN HAI TONG 23 ",
        "latitude": 33.31234,
        "longitude": 124.91234,
        "time_utc": "2026-09-29 06:42:20.000000 +0000 UTC",
    },
    "Message": {
        "ShipStaticData": {
            "AisVersion": 0,
            "CallSign": "BQAB2",
            "Destination": "SHANGHAI@@@@@@@@@@@@",
            "Dimension": {"A": 120, "B": 25, "C": 12, "D": 13},
            "Dte": 0,
            "Eta": {"Day": 30, "Hour": 8, "Minute": 30, "Month": 9},
            "FixType": 1,
            "ImoNumber": 9601234,
            "MaximumStaticDraught": 8.5,
            "MessageID": 5,
            "Name": "XIN HAI TONG 23 ",
            "Type": 70,
            "UserID": 413793000,
            "Valid": True,
        }
    },
}

STATIC_REPORT_B = {
    "MessageType": "StaticDataReport",
    "MetaData": {"MMSI": 412345678, "ShipName": "", "time_utc": "2026-09-29 06:45:00.000000 +0000 UTC"},
    "Message": {
        "StaticDataReport": {
            "MessageID": 24,
            "PartNumber": 0,
            "ReportA": {"Name": "CLASS B BOAT@@@@@@@@@@"},
            "ReportB": {
                "CallSign": "XY1234",
                "Dimension": {"A": 10, "B": 3, "C": 2, "D": 2},
                "ShipType": 36,
            },
            "UserID": 412345678,
        }
    },
}

failures: list[str] = []


def check(label: str, actual, expected) -> None:
    if actual != expected:
        failures.append(f"{label}: 期望 {expected!r}，实际 {actual!r}")
        print(f"  [FAIL] {label}: 期望 {expected!r}，实际 {actual!r}")
    else:
        print(f"  [ok]   {label} = {actual!r}")


def main() -> int:
    regions = ["yellow_sea"]

    print("1) 位置报文解析")
    row = parse_position(POSITION_REPORT, regions)
    check("mmsi", row[0], 413793000)
    check("ts 归一化", row[1], "2026-09-29T06:42:13.123Z")
    check("lat", row[2], 33.31234)
    check("lon", row[3], 124.91234)
    check("sog", row[4], 12.3)
    check("cog", row[5], 87.5)
    check("heading(91 是合法值)", row[6], 91.0)
    check("nav_status", row[7], 0)
    check("rot", row[8], -2.0)
    check("ship_name 去尾 @", row[9], "XIN HAI TONG 23")
    check("region", row[10], "yellow_sea")

    print("\n2) 哨兵值应转为 None")
    row = parse_position(POSITION_SENTINEL, regions)
    check("sog=1023 -> None", row[4], None)
    check("cog=3600 -> None", row[5], None)
    check("heading=511 -> None", row[6], None)
    check("rot=-128 -> None", row[8], None)
    check("船名去尾 @", row[9], "TEST SENTINEL")
    check("region 仍能命中", row[10], "yellow_sea")

    print("\n3) 区域外坐标")
    row = parse_position(POSITION_OUTSIDE, regions)
    check("region=unknown", row[10], "unknown")

    print("\n4) 静态资料解析（ShipStaticData）")
    row = parse_static(SHIP_STATIC)
    check("imo", row[1], 9601234)
    check("call_sign", row[2], "BQAB2")
    check("ship_type", row[4], 70)
    check("dim_to_bow", row[5], 120)
    check("destination 去尾 @", row[9], "SHANGHAI")
    check("eta", row[10], "09-30 08:30")
    check("draught", row[11], 8.5)

    print("\n5) Class B 静态资料解析（StaticDataReport）")
    row = parse_static(STATIC_REPORT_B)
    check("imo 无", row[1], None)
    check("船名", row[3], "CLASS B BOAT")
    check("ship_type", row[4], 36)

    print("\n6) 落库与视图")
    with tempfile.TemporaryDirectory() as tmp:
        store = AisStore(Path(tmp) / "test.sqlite")
        store.start_run("2026-09-29T06:00:00.000Z", regions)
        for msg in (POSITION_REPORT, POSITION_SENTINEL, POSITION_OUTSIDE):
            store.insert_position(parse_position(msg, regions))
        store.insert_position(parse_position(POSITION_REPORT, regions))  # 重复投递
        store.upsert_static(parse_static(SHIP_STATIC))
        # 同一 MMSI 的后续资料更新，应覆盖而变化
        store.upsert_static(parse_static(STATIC_REPORT_B))
        store.commit()

        totals = store.summary()
        check("去重后轨迹点", totals["positions"], 3)
        check("船舶数", totals["vessels"], 3)
        check("静态资料数", totals["static"], 2)

        latest = store.conn.execute(
            "SELECT mmsi, ship_name, destination FROM vessel_latest WHERE mmsi = 413793000"
        ).fetchone()
        check("视图关联静态资料", latest[2], "SHANGHAI")

        by_region = dict(
            store.conn.execute(
                "SELECT region, COUNT(*) FROM vessel_position GROUP BY region"
            ).fetchall()
        )
        check("海域分布", by_region, {"yellow_sea": 2, "unknown": 1})

        store.finish_run("2026-09-29T07:00:00.000Z", {"messages": 5, "positions": 3, "static": 2})
        run = store.conn.execute(
            "SELECT started_utc, regions, position_count FROM collector_run"
        ).fetchone()
        check("采集会话记录", run, ("2026-09-29T06:00:00.000Z", "yellow_sea", 3))
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
