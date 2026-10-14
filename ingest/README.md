# AIS 实时数据采集

两种数据源，**写入同一张数据库**，可混合使用：

| 数据源 | 费用 | 形态 | 覆盖 | 适用 |
|---|---|---|---|---|
| [aisstream.io](#数据源一aisstreamio) | 免费 | WebSocket 实时流 | 全球 | 持续采集、自建数据集 |
| [MarineTraffic 官方 API](#数据源二marinetraffic-官方-api) | 付费/学术计划 | REST 按需查询 | 全球（最全） | 历史轨迹、靠港、预计到港 |

两个采集器推送的字段同源——都是 AIS 报文解析结果：MMSI、船名、船型、经纬度、航速、航向、艏向、航行状态、目的港、预计到达时间。

---

## 数据源一：aisstream.io

官方免费开放的全球 AIS 流。

### 快速开始

**1. 注册免费密钥**

打开 <https://aisstream.io/authenticate>，用邮箱注册，拿到 API Key（免费）。

**2. 填入密钥**

编辑项目根目录 `.env.local`：

```
AISSTREAM_API_KEY=你的密钥
```

**3. 开始采集**

```powershell
# 采集黄海中部，运行 1 小时后自动停止
python ingest/ais_collector.py --regions yellow_sea --duration 3600

# 一直采集，Ctrl+C 停止，并实时打印每条报文
python ingest/ais_collector.py --regions yellow_sea --verbose

# 同时观测多个海域
python ingest/ais_collector.py --regions yellow_sea east_china_sea

# 自定义矩形海域（纬度最小 经度最小 纬度最大 经度最大）
python ingest/ais_collector.py --bbox 31.5 122.0 35.5 127.5
```

**4. 查看采集结果**

```powershell
python ingest/ais_collector.py --summary
```

### 预置海域

| 名称 | 范围 |
|---|---|
| `yellow_sea` | 黄海中部（31.5–35.5°N, 122–127.5°E） |
| `east_china_sea` | 东海北部（28–32°N, 121–127°E） |
| `north_atlantic` | 北大西洋（33–41°N, 49–40°W） |
| `global` | 全球（数据量大，建议短时观测） |

---

## 数据源二：MarineTraffic 官方 API

覆盖最全的一档，包含地图页看不到的历史轨迹、靠港记录、预计到港。

**前置：需要 API 密钥。** 在校学生走学术计划：

- 学术计划：官网搜索 "MarineTraffic academic program"，用学校邮箱提交申请，可获免费或大幅折扣的 API 访问
- 商业订阅：<https://www.marinetraffic.com/en/p/api>

密钥写入项目根目录 `.env.local`：

```
MARINETRAFFIC_API_KEY=你的密钥
```

### 用法

```powershell
# 矩形海域（黄海中部）
python ingest/marinetraffic_api.py --bbox 31.5 122.0 35.5 127.5 --timespan 30

# 圆形海域：以某点为中心 100km
python ingest/marinetraffic_api.py --lat 33.3 --lon 124.9 --radius 100

# 预置海域
python ingest/marinetraffic_api.py --regions yellow_sea

# 单船历史轨迹，回看 10 天
python ingest/marinetraffic_api.py --mmsi 413793000 --days 10

# 港口靠港记录 / 预计到港
python ingest/marinetraffic_api.py --portid 12345

# 查看已入库数据
python ingest/marinetraffic_api.py --summary
```

### 校准字段与单位 ⚠️

MarineTraffic 各服务的字段名与单位随服务版本而变。**接入前务必先用 `--dump` 核对一次**：

```powershell
python ingest/marinetraffic_api.py --bbox 31.5 122.0 35.5 127.5 --dump raw.json
```

打开 `raw.json`，找一条你认识的船，检查：

- **字段名**——本模块已兼容 `MMSI`/`mmsi`、`LON`/`lng`、`SPEED`/`sog` 等常见写法，如遇新写法加到 `row_to_position` 的候选名里即可
- **航速/航向单位**——若数值恰为应有值的 10 倍（如航速 `123` 表示 12.3 节），把 `marinetraffic_api.py` 顶部的 `SPEED_DIVISOR` / `COURSE_DIVISOR` / `HEADING_DIVISOR` 改成 `10.0`

### 支持的服务

`vesselsinradius`（圆形范围）、`exportvessels`（矩形范围）、`expectedarrivals`（预计到港）、`portcalls`（靠港记录）、`track`（单船轨迹）。

---

## 入库字段

**vessel_position**（轨迹点，按 `(mmsi, ts_utc)` 去重）

| 字段 | 含义 |
|---|---|
| `mmsi` | 船舶海上移动业务标识 |
| `ts_utc` | 报文时间（ISO8601 UTC） |
| `lat` / `lon` | 纬度 / 经度 |
| `sog` | 对地航速（节） |
| `cog` | 对地航向（度） |
| `heading` | 船艏向（度） |
| `nav_status` | 航行状态（0=在航, 1=锚泊, 5=靠泊…） |
| `rot` | 转向率 |
| `ship_name` | 船名 |
| `region` | 命中的观测海域 |

**vessel_static**（船舶资料，按 MMSI 覆盖更新）

`imo`、`call_sign`、`ship_name`、`ship_type`、`destination`（目的港）、`eta`（预计到达）、`draught`（吃水）、四向尺寸。

**vessel_latest**（视图）—— 每条船最近一次位置，含静态资料，适合直接画地图或做看板：

```sql
SELECT mmsi, ship_name, lat, lon, sog, cog, destination
FROM vessel_latest
WHERE region = 'yellow_sea';
```

**collector_run**（采集会话日志）—— 每次运行的起止时间、海域、报文计数，便于回溯数据完整性。

## 目录结构

```
ingest/
├── ais_collector.py            # aisstream.io 实时流采集器
├── marinetraffic_api.py        # MarineTraffic 官方 API 客户端
├── regions.py                  # 预置海域定义与区域匹配
├── store.py                    # SQLite 持久化层与表结构（两个采集器共用）
├── envload.py                  # .env 读取
├── test_offline.py             # 离线自检：aisstream 解析 + 落库
├── test_marinetraffic_offline.py  # 离线自检：API 客户端 + 落库
└── README.md
data/ais.sqlite        # 采集产生的数据库（已 gitignore）
```

## 自检

不联网、不消耗任何 API 额度即可验证解析与落库逻辑：

```powershell
python ingest/test_offline.py
python ingest/test_marinetraffic_offline.py
```

## 依赖

采集器仅需 `websockets`；MarineTraffic 客户端只用标准库。Python 3.10+：

```powershell
pip install websockets
```

## 说明

- 断线自动重连，退避从 1s 递增至 60s 封顶。
- 每 200 条报文落一次盘，异常退出最多丢 200 条。
- 未设置的值（AIS 哨兵值 91/181/511 等）统一存为 `NULL`，避免污染统计。
