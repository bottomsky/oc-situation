CREATE TABLE IF NOT EXISTS positions (
 eventId String, captureId String, mmsi String, sourceId String, sourceKind LowCardinality(String), sourcePriority Int32,
 observedAt DateTime64(3,'UTC'), receivedAt DateTime64(3,'UTC'), cleaningVersion UInt32,
 latitude Float64, longitude Float64, sog Nullable(Float64), cog Nullable(Float64), heading Nullable(Float64), navStatus Nullable(UInt8),
 quality Array(String), observation String
) ENGINE=ReplacingMergeTree(cleaningVersion) PARTITION BY toDate(observedAt) ORDER BY (mmsi,observedAt,sourceId,eventId) TTL observedAt + INTERVAL 30 DAY DELETE SETTINGS non_replicated_deduplication_window=10000;
CREATE TABLE IF NOT EXISTS static_history (
 eventId String, captureId String, mmsi String, sourceId String, sourceKind LowCardinality(String), sourcePriority Int32,
 observedAt DateTime64(3,'UTC'), receivedAt DateTime64(3,'UTC'), cleaningVersion UInt32, observation String
) ENGINE=ReplacingMergeTree(cleaningVersion) PARTITION BY toDate(observedAt) ORDER BY (mmsi,observedAt,sourceId,eventId) SETTINGS non_replicated_deduplication_window=10000;
CREATE TABLE IF NOT EXISTS quarantine (
 eventId String, captureId String, sourceId String, receivedAt DateTime64(3,'UTC'), cleaningVersion UInt32,
 reasons Array(String), observation String
) ENGINE=ReplacingMergeTree(cleaningVersion) PARTITION BY toDate(receivedAt) ORDER BY (sourceId,receivedAt,eventId) SETTINGS non_replicated_deduplication_window=10000;
CREATE TABLE IF NOT EXISTS quality_events (
 eventId String, sourceId String, observedAt DateTime64(3,'UTC'), cleaningVersion UInt32, flags Array(String)
) ENGINE=ReplacingMergeTree(cleaningVersion) PARTITION BY toDate(observedAt) ORDER BY (sourceId,observedAt,eventId) SETTINGS non_replicated_deduplication_window=10000;
