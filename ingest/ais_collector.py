"""基于 aisstream.io 的实时 AIS 采集器。

数据来源：https://aisstream.io （免费注册，官方开放的全球 AIS 流）
推送字段与 MarineTraffic 地图上展示的船舶信息同源——都是 AIS 报文解析结果：
MMSI、船名、船型、经纬度、航速、航向、艏向、航行状态、目的港、预计到达时间等。

用法：
    # 先设置密钥（二选一）
    setx AISSTREAM_API_KEY "你的key"          # Windows 永久
    # 或在项目根目录 .env.local 写 AISSTREAM_API_KEY=你的key

    python ingest/ais_collector.py --regions yellow_sea --duration 3600
    python ingest/ais_collector.py --bbox 31.5 122.0 35.5 127.5 --verbose
    python ingest/ais_collector.py --summary

获取密钥：https://aisstream.io/authenticate （邮箱注册，免费）
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import sys
from datetime import datetime, timezone
from pathlib import Path

import websockets

# 允许以 `python ingest/ais_collector.py` 或 `python -m ingest.ais_collector` 两种方式运行
sys.path.insert(0, str(Path(__file__).resolve().parent))

from regions import REGIONS, match_region, resolve_regions
from store import AisStore
from envload import load_dotenv

STREAM_URL = "wss://stream.aisstream.io/v0/stream"

# 需要订阅的报文类型：位置类 + 静态资料类
SUBSCRIBE_TYPES = [
    "PositionReport",
    "StandardClassBPositionReport",
    "ExtendedClassBPositionReport",
    "ShipStaticData",
    "StaticDataReport",
]

POSITION_TYPES = {
    "PositionReport": "PositionReport",
    "StandardClassBPositionReport": "StandardClassBPositionReport",
    "ExtendedClassBPositionReport": "ExtendedClassBPositionReport",
}


# ---------------------------------------------------------------- 配置读取

def get_api_key() -> str:
    key = os.environ.get("AISSTREAM_API_KEY", "").strip()
    if not key:
        sys.exit(
            "缺少 AISSTREAM_API_KEY。\n"
            "1) 到 https://aisstream.io/authenticate 用邮箱免费注册拿 key\n"
            "2) 写入项目根目录 .env.local：AISSTREAM_API_KEY=你的key\n"
            "   或设置环境变量：setx AISSTREAM_API_KEY \"你的key\""
        )
    return key


# ---------------------------------------------------------------- 报文解析

def parse_meta_time(raw: str | None) -> str:
    """把 aisstream 的 time_utc 归一化为 ISO8601（UTC, 毫秒）。"""
    if raw:
        text = raw.strip()
        if text.endswith("UTC"):
            text = text[:-3].strip()
        for fmt in ("%Y-%m-%d %H:%M:%S.%f %z", "%Y-%m-%d %H:%M:%S %z"):
            try:
                dt = datetime.strptime(text, fmt).astimezone(timezone.utc)
                return dt.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
            except ValueError:
                continue
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _f(value) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# 各字段的合法区间不同，超出即视为 AIS 的“未设置”哨兵值
def _sog(value) -> float | None:  # 对地航速，节；1023 = 不可用
    num = _f(value)
    return num if num is not None and 0.0 <= num <= 102.2 else None


def _cog(value) -> float | None:  # 对地航向，度；3600 = 不可用
    num = _f(value)
    return num if num is not None and 0.0 <= num < 360.0 else None


def _heading(value) -> float | None:  # 船艏向，度；511 = 不可用
    num = _f(value)
    return num if num is not None and 0.0 <= num < 360.0 else None


def _rot(value) -> float | None:  # 转向率；-128 = 不可用
    num = _f(value)
    return num if num is not None and -127.0 <= num <= 127.0 else None


def _dim(value) -> int | None:  # 船舶尺寸分量
    num = _f(value)
    return int(num) if num is not None and num >= 0 else None


def parse_position(msg: dict, regions: list[str]) -> tuple | None:
    """解析位置报文，返回落库元组。"""
    mmsi = msg.get("MetaData", {}).get("MMSI") or msg.get("Message", {}).get(
        "PositionReport", {}
    ).get("UserID")
    if not mmsi:
        return None

    body = None
    for key in POSITION_TYPES.values():
        if key in msg.get("Message", {}):
            body = msg["Message"][key]
            break
    if not body:
        return None

    lat = _f(body.get("Latitude"))
    lon = _f(body.get("Longitude"))
    if lat is None or lon is None:
        return None
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        return None

    meta = msg.get("MetaData", {})
    ship_name = (meta.get("ShipName") or "").strip().rstrip("@") or None
    ts = parse_meta_time(meta.get("time_utc"))

    return (
        int(mmsi),
        ts,
        lat,
        lon,
        _sog(body.get("Sog")),
        _cog(body.get("Cog")),
        _heading(body.get("TrueHeading")),
        body.get("NavigationalStatus"),
        _rot(body.get("RateOfTurn")),
        ship_name,
        match_region(lat, lon, regions),
    )


def _eta_str(eta: dict | None) -> str | None:
    if not isinstance(eta, dict):
        return None
    month = eta.get("Month") or 0
    day = eta.get("Day") or 0
    hour = eta.get("Hour")
    minute = eta.get("Minute")
    if not month or not day:
        return None
    return f"{month:02d}-{day:02d} {(hour or 0):02d}:{(minute or 0):02d}"


def parse_static(msg: dict) -> tuple | None:
    """解析静态资料报文（ShipStaticData / StaticDataReport）。"""
    meta = msg.get("MetaData", {})
    mmsi = meta.get("MMSI")
    if not mmsi:
        return None
    message = msg.get("Message", {})
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

    if "ShipStaticData" in message:
        body = message["ShipStaticData"]
        dim = body.get("Dimension") or {}
        return (
            int(mmsi),
            body.get("ImoNumber") or None,
            (body.get("CallSign") or "").strip().rstrip("@") or None,
            (body.get("Name") or meta.get("ShipName") or "").strip().rstrip("@") or None,
            body.get("Type"),
            _dim(dim.get("A")),
            _dim(dim.get("B")),
            _dim(dim.get("C")),
            _dim(dim.get("D")),
            (body.get("Destination") or "").strip().rstrip("@") or None,
            _eta_str(body.get("Eta")),
            _f(body.get("MaximumStaticDraught")),
            now,
        )

    if "StaticDataReport" in message:
        body = message["StaticDataReport"]
        report_a = body.get("ReportA") or {}
        report_b = body.get("ReportB") or {}
        dim = report_b.get("Dimension") or {}
        return (
            int(mmsi),
            None,  # Class B 不提供 IMO
            (report_b.get("CallSign") or "").strip().rstrip("@") or None,
            (report_a.get("Name") or meta.get("ShipName") or "").strip().rstrip("@")
            or None,
            report_b.get("ShipType"),
            _dim(dim.get("A")),
            _dim(dim.get("B")),
            _dim(dim.get("C")),
            _dim(dim.get("D")),
            None,
            None,
            None,
            now,
        )
    return None


# ---------------------------------------------------------------- 采集主循环

class Collector:
    def __init__(self, api_key: str, boxes, regions, store: AisStore, verbose: bool):
        self.api_key = api_key
        self.boxes = boxes
        self.regions = regions
        self.store = store
        self.verbose = verbose
        self.stats = {"messages": 0, "positions": 0, "static": 0, "skipped": 0}
        self._stop = asyncio.Event()

    def request_stop(self) -> None:
        self._stop.set()

    def subscription(self) -> str:
        return json.dumps(
            {
                "APIKey": self.api_key,
                "BoundingBoxes": self.boxes,
                "FilterMessageTypes": SUBSCRIBE_TYPES,
            }
        )

    async def run(self) -> None:
        backoff = 1.0
        while not self._stop.is_set():
            try:
                async with websockets.connect(
                    STREAM_URL, ping_interval=20, ping_timeout=20, max_size=2**22
                ) as ws:
                    await ws.send(self.subscription())
                    print(f"[连接] 已订阅 {len(self.boxes)} 个海域，等待数据…")
                    backoff = 1.0
                    await self.consume(ws)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # 网络抖动 / 服务端断开
                if self._stop.is_set():
                    break
                print(f"[重连] {type(exc).__name__}: {exc} — {backoff:.0f}s 后重试")
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=backoff)
                    break
                except asyncio.TimeoutError:
                    backoff = min(backoff * 2, 60.0)

    async def consume(self, ws) -> None:
        async for raw in ws:
            if self._stop.is_set():
                break
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                self.stats["skipped"] += 1
                continue
            self.handle(msg)

    def handle(self, msg: dict) -> None:
        self.stats["messages"] += 1
        mtype = msg.get("MessageType", "")

        if mtype in POSITION_TYPES:
            row = parse_position(msg, self.regions)
            if row:
                self.store.insert_position(row)
                self.stats["positions"] += 1
                if self.verbose:
                    _, ts, lat, lon, sog, cog, hdg, nav, _, name, region = row
                    print(
                        f"[位置] {region:<16} MMSI={row[0]:<10} "
                        f"{name or '-':<20} {lat:8.4f},{lon:9.4f} "
                        f"SOG={sog if sog is not None else '-':>5} "
                        f"COG={cog if cog is not None else '-':>5} {ts}"
                    )
            else:
                self.stats["skipped"] += 1
        elif mtype in ("ShipStaticData", "StaticDataReport"):
            row = parse_static(msg)
            if row:
                self.store.upsert_static(row)
                self.stats["static"] += 1
                if self.verbose:
                    print(
                        f"[资料] MMSI={row[0]:<10} {row[3] or '-':<24} "
                        f"类型={row[4] or '-':<5} 目的港={row[9] or '-'}"
                    )
            else:
                self.stats["skipped"] += 1
        else:
            self.stats["skipped"] += 1

        # 每 200 条落一次盘，兼顾吞吐与可查询性
        if self.stats["messages"] % 200 == 0:
            self.store.commit()


async def async_main(args) -> int:
    load_dotenv()
    api_key = get_api_key()

    if args.bbox:
        boxes = [[[args.bbox[0], args.bbox[1]], [args.bbox[2], args.bbox[3]]]]
        regions = ["custom"]
        REGIONS["custom"] = {
            "name": "自定义",
            "bounding_box": boxes[0],
        }
    else:
        boxes, regions = resolve_regions(args.regions)

    db_path = Path(args.db)
    store = AisStore(db_path)
    started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    store.start_run(started, regions)

    print(f"[启动] 数据库: {db_path}")
    print(f"[启动] 海域: {', '.join(REGIONS[r]['name'] for r in regions)}")

    collector = Collector(api_key, boxes, regions, store, args.verbose)
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, collector.request_stop)
        except NotImplementedError:  # Windows 上 ProactorEventLoop 不支持
            pass

    task = asyncio.create_task(collector.run())
    note = "正常结束"
    try:
        if args.duration:
            print(f"[运行] 将持续 {args.duration} 秒")
            # 用 asyncio.wait 而非 wait_for：超时不会取消内部 task，
            # 才能让采集器把在途数据落盘后再退出
            done, _ = await asyncio.wait({task}, timeout=args.duration)
            if not done:
                collector.request_stop()
                note = f"达到运行时长 {args.duration}s"
                done, pending = await asyncio.wait({task}, timeout=20)
                if pending:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
        else:
            print("[运行] 按 Ctrl+C 停止采集")
            await task
    except (KeyboardInterrupt, asyncio.CancelledError):
        note = "用户中断"
        collector.request_stop()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    finally:
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    ended = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    store.finish_run(ended, collector.stats, note)
    totals = store.summary()
    store.close()

    print("\n[完成] " + note)
    print(f"[统计] 收到报文 {collector.stats['messages']}，"
          f"位置 {collector.stats['positions']}，静态 {collector.stats['static']}")
    print(f"[累计] 轨迹点 {totals['positions']}，船舶 {totals['vessels']}，"
          f"静态资料 {totals['static']}")
    return 0


def print_summary(db: str) -> int:
    path = Path(db)
    if not path.is_file():
        print(f"数据库不存在: {path}")
        return 1
    store = AisStore(path)
    totals = store.summary()
    print(f"数据库: {path}")
    print(f"轨迹点: {totals['positions']}")
    print(f"船舶数: {totals['vessels']}")
    print(f"静态资料: {totals['static']}")
    rows = store.conn.execute(
        """SELECT region, COUNT(*) AS n, COUNT(DISTINCT mmsi) AS vessels
           FROM vessel_position GROUP BY region ORDER BY n DESC"""
    ).fetchall()
    if rows:
        print("\n按海域：")
        for region, n, vessels in rows:
            print(f"  {region:<18} 轨迹点 {n:<8} 船舶 {vessels}")
    top = store.conn.execute(
        """SELECT mmsi, ship_name, sog, ts_utc FROM vessel_latest
           WHERE sog IS NOT NULL ORDER BY sog DESC LIMIT 10"""
    ).fetchall()
    if top:
        print("\n最新航速 Top10：")
        for mmsi, name, sog, ts in top:
            print(f"  MMSI={mmsi:<10} {name or '-':<22} SOG={sog:<6} {ts}")
    store.close()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="aisstream.io 实时 AIS 采集器",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="可用海域: " + ", ".join(sorted(REGIONS)),
    )
    parser.add_argument(
        "--regions",
        nargs="+",
        default=["yellow_sea"],
        help=f"预置海域，可多个。可选: {', '.join(sorted(REGIONS))}",
    )
    parser.add_argument(
        "--bbox",
        nargs=4,
        type=float,
        metavar=("LAT_MIN", "LON_MIN", "LAT_MAX", "LON_MAX"),
        help="自定义矩形海域，与 --regions 二选一",
    )
    parser.add_argument("--db", default="data/ais.sqlite", help="SQLite 路径")
    parser.add_argument("--duration", type=int, help="运行秒数，缺省则一直采到 Ctrl+C")
    parser.add_argument("--verbose", action="store_true", help="逐条打印收到的报文")
    parser.add_argument("--summary", action="store_true", help="只打印数据库概况后退出")
    args = parser.parse_args()

    if args.summary:
        return print_summary(args.db)

    load_dotenv()
    if not os.environ.get("AISSTREAM_API_KEY", "").strip():
        get_api_key()  # 触发友好报错

    try:
        return asyncio.run(async_main(args))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
