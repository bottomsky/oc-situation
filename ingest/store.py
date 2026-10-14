"""AIS 数据持久化（SQLite）。

设计取舍：
- 用时间戳主键 (mmsi, ts_utc) 去重，重复投递不会写重。
- 位置按时间累积成轨迹，静态资料按 MMSI 覆盖更新（船舶会改名、换目的港）。
- WAL 模式让写入与查询可并发，便于分析侧同时读。
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS vessel_position (
    mmsi        INTEGER NOT NULL,
    ts_utc      TEXT    NOT NULL,
    lat         REAL    NOT NULL,
    lon         REAL    NOT NULL,
    sog         REAL,
    cog         REAL,
    heading     REAL,
    nav_status  INTEGER,
    rot         REAL,
    ship_name   TEXT,
    region      TEXT,
    PRIMARY KEY (mmsi, ts_utc)
);

CREATE INDEX IF NOT EXISTS idx_position_ts ON vessel_position (ts_utc);
CREATE INDEX IF NOT EXISTS idx_position_region_ts ON vessel_position (region, ts_utc);

CREATE TABLE IF NOT EXISTS vessel_static (
    mmsi            INTEGER PRIMARY KEY,
    imo             INTEGER,
    call_sign       TEXT,
    ship_name       TEXT,
    ship_type       INTEGER,
    dim_to_bow      INTEGER,
    dim_to_stern    INTEGER,
    dim_to_port     INTEGER,
    dim_to_starboard INTEGER,
    destination     TEXT,
    eta             TEXT,
    draught         REAL,
    updated_utc     TEXT
);

-- 每条船最近一次位置，供地图/看板快速读取
CREATE VIEW IF NOT EXISTS vessel_latest AS
SELECT p.*, s.imo, s.call_sign, s.ship_type, s.destination, s.eta, s.draught
FROM vessel_position p
JOIN (
    SELECT mmsi, MAX(ts_utc) AS ts_utc FROM vessel_position GROUP BY mmsi
) latest ON latest.mmsi = p.mmsi AND latest.ts_utc = p.ts_utc
LEFT JOIN vessel_static s ON s.mmsi = p.mmsi;

CREATE TABLE IF NOT EXISTS collector_run (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    started_utc TEXT,
    regions     TEXT,
    message_count INTEGER DEFAULT 0,
    position_count INTEGER DEFAULT 0,
    static_count   INTEGER DEFAULT 0,
    ended_utc   TEXT,
    note        TEXT
);
"""


class AisStore:
    """AIS 数据落库封装。"""

    def __init__(self, db_path: str | Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.db_path, timeout=30.0)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.executescript(SCHEMA)
        self.conn.commit()
        self.run_id: int | None = None

    # ---- 采集会话 ----

    def start_run(self, started_utc: str, regions: list[str]) -> int:
        cur = self.conn.execute(
            "INSERT INTO collector_run (started_utc, regions) VALUES (?, ?)",
            (started_utc, ",".join(regions)),
        )
        self.conn.commit()
        self.run_id = int(cur.lastrowid)
        return self.run_id

    def finish_run(self, ended_utc: str, stats: dict[str, int], note: str = "") -> None:
        if self.run_id is None:
            return
        self.conn.execute(
            """UPDATE collector_run
               SET ended_utc = ?, message_count = ?, position_count = ?,
                   static_count = ?, note = ?
               WHERE id = ?""",
            (
                ended_utc,
                stats.get("messages", 0),
                stats.get("positions", 0),
                stats.get("static", 0),
                note,
                self.run_id,
            ),
        )
        self.conn.commit()

    # ---- 写入 ----

    def insert_position(self, row: tuple) -> None:
        self.conn.execute(
            """INSERT OR IGNORE INTO vessel_position
               (mmsi, ts_utc, lat, lon, sog, cog, heading, nav_status, rot, ship_name, region)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            row,
        )

    def upsert_static(self, row: tuple) -> None:
        self.conn.execute(
            """INSERT INTO vessel_static
               (mmsi, imo, call_sign, ship_name, ship_type, dim_to_bow, dim_to_stern,
                dim_to_port, dim_to_starboard, destination, eta, draught, updated_utc)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(mmsi) DO UPDATE SET
                   imo             = COALESCE(excluded.imo, imo),
                   call_sign       = COALESCE(excluded.call_sign, call_sign),
                   ship_name       = COALESCE(excluded.ship_name, ship_name),
                   ship_type       = COALESCE(excluded.ship_type, ship_type),
                   dim_to_bow      = COALESCE(excluded.dim_to_bow, dim_to_bow),
                   dim_to_stern    = COALESCE(excluded.dim_to_stern, dim_to_stern),
                   dim_to_port     = COALESCE(excluded.dim_to_port, dim_to_port),
                   dim_to_starboard= COALESCE(excluded.dim_to_starboard, dim_to_starboard),
                   destination     = COALESCE(excluded.destination, destination),
                   eta             = COALESCE(excluded.eta, eta),
                   draught         = COALESCE(excluded.draught, draught),
                   updated_utc     = excluded.updated_utc""",
            row,
        )

    def commit(self) -> None:
        self.conn.commit()

    def close(self) -> None:
        try:
            self.conn.commit()
        finally:
            self.conn.close()

    # ---- 统计 ----

    def summary(self) -> dict[str, int]:
        def scalar(sql: str) -> int:
            return int(self.conn.execute(sql).fetchone()[0])

        return {
            "positions": scalar("SELECT COUNT(*) FROM vessel_position"),
            "vessels": scalar("SELECT COUNT(DISTINCT mmsi) FROM vessel_position"),
            "static": scalar("SELECT COUNT(*) FROM vessel_static"),
        }
