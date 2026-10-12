CREATE TABLE IF NOT EXISTS static_history_v2 (
 eventId String, captureId String, mmsi String, sourceId String, sourceKind LowCardinality(String), sourcePriority Int32,
 observedAt Nullable(DateTime64(3,'UTC')), receivedAt DateTime64(3,'UTC'), cleaningVersion UInt32, observation String
) ENGINE=ReplacingMergeTree(cleaningVersion) PARTITION BY cityHash64(eventId)%64 ORDER BY (sourceId,eventId) TTL receivedAt + INTERVAL 30 DAY DELETE SETTINGS non_replicated_deduplication_window=10000;
CREATE TABLE IF NOT EXISTS quarantine_v2 (
 eventId String, captureId String, sourceId String, receivedAt DateTime64(3,'UTC'), cleaningVersion UInt32,
 reasons Array(String), observation String
) ENGINE=ReplacingMergeTree(cleaningVersion) PARTITION BY cityHash64(eventId)%64 ORDER BY (sourceId,eventId) TTL receivedAt + INTERVAL 30 DAY DELETE SETTINGS non_replicated_deduplication_window=10000;
CREATE TABLE IF NOT EXISTS quality_events_v2 (
 eventId String, sourceId String, observedAt Nullable(DateTime64(3,'UTC')), receivedAt DateTime64(3,'UTC'), cleaningVersion UInt32, flags Array(String)
) ENGINE=ReplacingMergeTree(cleaningVersion) PARTITION BY cityHash64(eventId)%64 ORDER BY (sourceId,eventId) TTL receivedAt + INTERVAL 30 DAY DELETE SETTINGS non_replicated_deduplication_window=10000;
