"""MarineTraffic 官方 API 客户端，数据直接写入与 AIS 采集器共用的同一张表。

前置：你需要一个 MarineTraffic API 密钥（付费订阅，或高校学术计划）。
  - 学术计划（在校学生适用）：官网搜索 "MarineTraffic academic program"，
    用学校邮箱提交申请，可获免费或大幅折扣的 API 访问。
  - 商业订阅：https://www.marinetraffic.com/en/p/api

密钥写入项目根目录 .env.local：
    MARINETRAFFIC_API_KEY=你的密钥

用法：
    # 矩形海域（黄海中部）
    python ingest/marinetraffic_api.py --bbox 31.5 122.0 35.5 127.5 --timespan 30

    # 圆形海域：以某点为中心 100km
    python ingest/marinetraffic_api.py --lat 33.3 --lon 124.9 --radius 100

    # 先 dump 原始响应，核对字段名与单位
    python ingest/marinetraffic_api.py --bbox 31.5 122.0 35.5 127.5 --dump raw.json

    # 查看已入库数据
    python ingest/marinetraffic_api.py --summary

字段与单位说明：
    MarineTraffic 各服务的字段名与单位随服务版本而变，本模块用
    SPEED_DIVISOR / COURSE_DIVISOR / HEADING_DIVISOR 做归一化。
    先用 --dump 取一条你认识的船核对：若数值恰为应有值的 10 倍，
    把对应 divisor 改成 10.0 即可。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))

from envload import load_dotenv
from regions import REGIONS, match_region
from store import AisStore

API_BASE = "https://services.marinetraffic.com/api"
API_VERSION = "8"

# 归一化开关：若 --dump 显示数值是应有值的 10 倍，改成 10.0
SPEED_DIVISOR = 1.0
COURSE_DIVISOR = 1.0
HEADING_DIVISOR = 1.0

# 位置类服务：服务名 -> 是否支持矩形范围
SERVICES = {
    "vesselsinradius": "圆形范围实时船舶",
    "exportvessels": "矩形范围实时船舶",
    "expectedarrivals": "预计到港",
    "portcalls": "靠港记录",
    "track": "单船历史轨迹",
}


class MarineTrafficError(RuntimeError):
    pass


# ---------------------------------------------------------------- 取值辅助

def _pick(row: dict, *names: str) -> Any:
    """按候选名取字段，兼容大小写与下划线差异。"""
    lowered = {str(k).lower().replace("_", ""): v for k, v in row.items()}
    for name in names:
        key = name.lower().replace("_", "")
        if key in lowered and lowered[key] not in ("", None):
            return lowered[key]
    return None


def _f(value) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _i(value) -> int | None:
    num = _f(value)
    return int(num) if num is not None else None


def _clean_text(value) -> str | None:
    if value is None:
        return None
    text = str(value).strip().rstrip("@").strip()
    return text or None


def parse_ts(raw) -> str:
    """把 MarineTraffic 的时间字段归一化为 ISO8601 UTC。"""
    if raw is None:
        return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    num = _f(raw)
    if num is not None and num > 1e8:  # Unix 秒或毫秒
        if num > 1e11:
            num /= 1000.0
        dt = datetime.fromtimestamp(num, tz=timezone.utc)
        return dt.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    text = str(raw).strip()
    for fmt in (
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d",
        "%d/%m/%Y %H:%M:%S",
    ):
        try:
            dt = datetime.strptime(text, fmt).replace(tzinfo=timezone.utc)
            return dt.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        except ValueError:
            continue
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _bbox_contains(box: list[list[float]], lat: float, lon: float) -> bool:
    (lat_min, lon_min), (lat_max, lon_max) = box
    return lat_min <= lat <= lat_max and lon_min <= lon <= lon_max


# ---------------------------------------------------------------- 客户端

class MarineTrafficClient:
    """MarineTraffic 官方 REST API 客户端。

    transport 可注入，便于离线测试：
        transport(url) -> (status, body_text)
    """

    def __init__(
        self,
        api_key: str,
        version: str = API_VERSION,
        protocol: str = "jsono",
        timeout: int = 30,
        transport: Callable[[str, int], tuple[int, str]] | None = None,
    ) -> None:
        if not api_key or not api_key.strip():
            raise MarineTrafficError("缺少 MarineTraffic API 密钥")
        self.api_key = api_key.strip()
        self.version = version
        self.protocol = protocol
        self.timeout = timeout
        self._transport = transport or self._http_get

    # ---- 传输层 ----

    @staticmethod
    def _http_get(url: str, timeout: int) -> tuple[int, str]:
        request = urllib.request.Request(url, headers={"User-Agent": "ais-research/1.0"})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as resp:
                return resp.status, resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read().decode("utf-8", errors="replace")
        except urllib.error.URLError as exc:
            raise MarineTrafficError(f"网络错误: {exc.reason}") from exc

    # ---- 请求构造 ----

    def build_url(self, service: str, params: dict[str, Any]) -> str:
        """按 MarineTraffic 文档形式构造 URL：service/v:N/KEY/protocol:jsono/参数…"""
        parts = [API_BASE, service, f"v:{self.version}", self.api_key,
                 f"protocol:{self.protocol}"]
        query: dict[str, str] = {}
        for key, value in params.items():
            if value is None:
                continue
            if isinstance(value, bool):
                value = "true" if value else "false"
            if isinstance(value, (list, tuple)):
                value = ",".join(str(v) for v in value)
            query[key] = str(value)
        url = "/".join(parts)
        if query:
            url += "?" + urllib.parse.urlencode(query)
        return url

    def call(self, service: str, **params: Any) -> list[dict]:
        if service not in SERVICES:
            known = ", ".join(SERVICES)
            raise MarineTrafficError(f"未知服务: {service}\n可用: {known}")
        url = self.build_url(service, params)
        status, body = self._transport(url, self.timeout)
        if status != 200:
            raise MarineTrafficError(
                f"HTTP {status} 调用 {service} 失败\n"
                f"URL: {url.replace(self.api_key, '***')}\n响应: {body[:500]}"
            )
        try:
            payload = json.loads(body)
        except json.JSONDecodeError as exc:
            raise MarineTrafficError(f"{service} 返回非 JSON: {body[:300]}") from exc

        if isinstance(payload, list):
            return payload
        if isinstance(payload, dict):
            for key in ("data", "DATA", "result", "results"):
                if isinstance(payload.get(key), list):
                    return payload[key]
            # 单条记录或错误对象
            if payload.get("errors") or payload.get("error"):
                raise MarineTrafficError(f"{service} 返回错误: {payload}")
            return [payload]
        return []

    # ---- 便捷方法 ----

    def vessels_in_radius(
        self, lat: float, lon: float, radius_km: int = 100,
        timespan: int = 30, minspeed: int = 0, msgtype: str = "extended",
    ) -> list[dict]:
        return self.call(
            "vesselsinradius", lat=lat, lon=lon, radius=radius_km,
            timespan=timespan, minspeed=minspeed, msgtype=msgtype,
        )

    def vessels_in_box(
        self, box: list[list[float]], timespan: int = 30,
        minspeed: int = 0, msgtype: str = "extended",
    ) -> list[dict]:
        (lat_min, lon_min), (lat_max, lon_max) = box
        return self.call(
            "exportvessels", minlat=lat_min, maxlat=lat_max,
            minlon=lon_min, maxlon=lon_max, timespan=timespan,
            minspeed=minspeed, msgtype=msgtype,
        )

    def expected_arrivals(self, port_id: int, timespan: int = 240) -> list[dict]:
        return self.call("expectedarrivals", portid=port_id, timespan=timespan)

    def port_calls(self, port_id: int, timespan: int = 240) -> list[dict]:
        return self.call("portcalls", portid=port_id, timespan=timespan)

    def vessel_track(self, mmsi: int, days: int = 10) -> list[dict]:
        return self.call("track", mmsi=mmsi, days=days)


# ---------------------------------------------------------------- 入库映射

def row_to_position(row: dict, regions: list[str],
                    boxes: list[list[list[float]]] | None = None) -> tuple | None:
    """把一条 MarineTraffic 记录转成 vessel_position 元组。

    boxes 非空时按订阅范围再过一遍，避免服务端近似匹配带回范围外目标。
    """
    mmsi = _i(_pick(row, "MMSI", "mmsi_number", "userid"))
    lat = _f(_pick(row, "LAT", "LATITUDE"))
    lon = _f(_pick(row, "LON", "LONGITUDE", "LNG"))
    if not mmsi or lat is None or lon is None:
        return None
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        return None

    if boxes and not any(_bbox_contains(b, lat, lon) for b in boxes):
        return None

    speed = _f(_pick(row, "SPEED", "SOG"))
    course = _f(_pick(row, "COURSE", "COG"))
    heading = _f(_pick(row, "HEADING", "HDG"))

    if speed is not None:
        speed = speed / SPEED_DIVISOR
    if course is not None:
        course = course / COURSE_DIVISOR
    if heading is not None:
        heading = heading / HEADING_DIVISOR

    ts = parse_ts(_pick(row, "TIMESTAMP", "LAST_POS", "LASTPOS", "TIME", "LASTMOV"))
    status = _i(_pick(row, "NAVSTAT", "STATUS", "NAVIGATIONALSTATUS"))
    name = _clean_text(_pick(row, "SHIPNAME", "NAME", "VESSELNAME"))

    return (
        int(mmsi),
        ts,
        lat,
        lon,
        speed,
        course,
        heading,
        status,
        None,  # MarineTraffic 不返回转向率
        name,
        match_region(lat, lon, regions),
    )


def row_to_static(row: dict) -> tuple | None:
    """把一条记录里的静态资料转成 vessel_static 元组。"""
    mmsi = _i(_pick(row, "MMSI", "mmsi_number", "userid"))
    if not mmsi:
        return None
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    return (
        int(mmsi),
        _i(_pick(row, "IMO")),
        _clean_text(_pick(row, "CALLSIGN")),
        _clean_text(_pick(row, "SHIPNAME", "NAME", "VESSELNAME")),
        _i(_pick(row, "SHIPTYPE", "TYPE")),
        None, None, None, None,  # 尺寸分项在矩形/圆形服务里不返回
        _clean_text(_pick(row, "DESTINATION")),
        _clean_text(_pick(row, "ETA")),
        _f(_pick(row, "DRAUGHT")),
        now,
    )


# ---------------------------------------------------------------- CLI

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
    store.close()
    return 0


def get_api_key() -> str:
    key = os.environ.get("MARINETRAFFIC_API_KEY", "").strip()
    if not key:
        sys.exit(
            "缺少 MARINETRAFFIC_API_KEY。\n"
            "1) 学术计划（在校学生）：官网搜索 \"MarineTraffic academic program\" 申请\n"
            "2) 商业订阅：https://www.marinetraffic.com/en/p/api\n"
            "3) 拿到密钥后写入项目根目录 .env.local：\n"
            "   MARINETRAFFIC_API_KEY=你的密钥"
        )
    return key


def main() -> int:
    parser = argparse.ArgumentParser(
        description="MarineTraffic 官方 API 采集器（写入与 AIS 采集器共用的数据库）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="可用服务: " + "; ".join(f"{k}（{v}）" for k, v in SERVICES.items()),
    )
    area = parser.add_mutually_exclusive_group()
    area.add_argument("--bbox", nargs=4, type=float,
                      metavar=("LAT_MIN", "LON_MIN", "LAT_MAX", "LON_MAX"),
                      help="矩形海域")
    area.add_argument("--regions", nargs="+", help="预置海域名")
    parser.add_argument("--lat", type=float, help="圆形海域中心纬度")
    parser.add_argument("--lon", type=float, help="圆形海域中心经度")
    parser.add_argument("--radius", type=int, default=100, help="圆形海域半径(km)")
    parser.add_argument("--timespan", type=int, default=30, help="回看分钟数")
    parser.add_argument("--minspeed", type=int, default=0, help="最低航速(节)")
    parser.add_argument("--msgtype", default="extended", help="返回字段集")
    parser.add_argument("--mmsi", type=int, help="单船轨迹查询")
    parser.add_argument("--days", type=int, default=10, help="轨迹回看天数")
    parser.add_argument("--portid", type=int, help="港口 id（靠港/预计到港）")
    parser.add_argument("--db", default="data/ais.sqlite", help="SQLite 路径")
    parser.add_argument("--dump", metavar="FILE", help="保存原始 JSON 响应以便核对字段")
    parser.add_argument("--summary", action="store_true", help="只打印数据库概况")
    args = parser.parse_args()

    if args.summary:
        return print_summary(args.db)

    load_dotenv()
    client = MarineTrafficClient(get_api_key())

    # 组装订阅范围与标签
    boxes: list[list[list[float]]] = []
    regions: list[str] = []
    label = "custom"
    if args.bbox:
        boxes = [[[args.bbox[0], args.bbox[1]], [args.bbox[2], args.bbox[3]]]]
        regions = ["custom"]
        REGIONS["custom"] = {"name": "自定义", "bounding_box": boxes[0]}
    elif args.regions:
        from regions import resolve_regions
        boxes, regions = resolve_regions(args.regions)

    print(f"[启动] 数据库: {args.db}")

    if args.mmsi:
        print(f"[请求] 单船轨迹 MMSI={args.mmsi} 回看 {args.days} 天")
        records = client.vessel_track(args.mmsi, days=args.days)
    elif args.portid:
        print(f"[请求] 港口 {args.portid} 靠港记录")
        records = client.port_calls(args.portid, timespan=args.timespan * 8)
    elif args.lat is not None and args.lon is not None:
        print(f"[请求] 圆形范围 ({args.lat}, {args.lon}) 半径 {args.radius}km")
        records = client.vessels_in_radius(
            args.lat, args.lon, args.radius, args.timespan, args.minspeed, args.msgtype
        )
    elif boxes:
        print(f"[请求] 矩形范围 {boxes[0]}")
        records = client.vessels_in_box(
            boxes[0], args.timespan, args.minspeed, args.msgtype
        )
    else:
        parser.error("请指定 --bbox / --regions / --lat+--lon / --mmsi / --portid 之一")

    print(f"[响应] 收到记录 {len(records)} 条")

    if args.dump:
        Path(args.dump).write_text(
            json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"[导出] 原始响应已写入 {args.dump}")

    if not records:
        print("[提示] 无数据。可能是范围/时段内无船，或密钥权限不含该服务。")
        return 0

    store = AisStore(args.db)
    started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    store.start_run(started, regions or [label])

    positions = static = 0
    for record in records:
        if not isinstance(record, dict):
            continue
        pos = row_to_position(record, regions, boxes or None)
        if pos:
            store.insert_position(pos)
            positions += 1
        stat = row_to_static(record)
        if stat and stat[3]:  # 至少要有船名才值得写
            store.upsert_static(stat)
            static += 1
    store.commit()

    ended = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    store.finish_run(
        ended,
        {"messages": len(records), "positions": positions, "static": static},
        "MarineTraffic API 单次拉取",
    )
    totals = store.summary()
    store.close()

    print(f"[入库] 本次轨迹点 {positions}，静态资料 {static}")
    print(f"[累计] 轨迹点 {totals['positions']}，船舶 {totals['vessels']}，"
          f"静态资料 {totals['static']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
