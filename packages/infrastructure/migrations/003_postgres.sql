CREATE TABLE IF NOT EXISTS processor_position_state (
 mmsi text PRIMARY KEY, observation jsonb NOT NULL, expire_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS processor_position_state_expiry ON processor_position_state(expire_at);
CREATE TABLE IF NOT EXISTS position_quality_decisions (
 cleaning_version integer NOT NULL, event_id text NOT NULL, quality jsonb NOT NULL, expire_at timestamptz NOT NULL,
 PRIMARY KEY(cleaning_version,event_id)
);
CREATE INDEX IF NOT EXISTS position_quality_decisions_expiry ON position_quality_decisions(expire_at);
CREATE TABLE IF NOT EXISTS processor_progress (
 id text PRIMARY KEY, ranges jsonb NOT NULL DEFAULT '[]', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS replay_processed_manifests (
 run_id uuid NOT NULL REFERENCES runs(id), manifest_id text NOT NULL, counters jsonb NOT NULL,
 expire_at timestamptz NOT NULL, PRIMARY KEY(run_id,manifest_id)
);
CREATE INDEX IF NOT EXISTS replay_processed_manifests_expiry ON replay_processed_manifests(expire_at);
CREATE INDEX IF NOT EXISTS positions_latest_geometry ON positions_latest USING gist ((location::geometry));
