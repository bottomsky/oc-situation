CREATE EXTENSION IF NOT EXISTS postgis;
CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY, username text NOT NULL UNIQUE, password_hash text NOT NULL,
 role text NOT NULL CHECK (role IN ('admin','operator','viewer')), disabled boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
 id text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS audit (
 id uuid PRIMARY KEY, user_id uuid REFERENCES users(id), action text NOT NULL, resource_type text NOT NULL,
 resource_id text, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sources (
 id text PRIMARY KEY, name text NOT NULL, kind text NOT NULL, enabled boolean NOT NULL DEFAULT false,
 priority integer NOT NULL DEFAULT 100, config jsonb NOT NULL DEFAULT '{}', secret_ref text,
 status text NOT NULL DEFAULT 'disabled', last_error text, last_received_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS jobs (
 id uuid PRIMARY KEY, source_id text NOT NULL REFERENCES sources(id), name text NOT NULL,
 enabled boolean NOT NULL DEFAULT false, status text NOT NULL DEFAULT 'paused', mode text NOT NULL DEFAULT 'collect', schedule_seconds integer, schedule text, config jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS runs (
 id uuid PRIMARY KEY, job_id uuid REFERENCES jobs(id), source_id text NOT NULL REFERENCES sources(id),
 status text NOT NULL DEFAULT 'queued', mode text NOT NULL DEFAULT 'collect', requested_at timestamptz NOT NULL DEFAULT now(), checkpoint jsonb NOT NULL DEFAULT '{}', counters jsonb NOT NULL DEFAULT '{}',
 started_at timestamptz, finished_at timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS outbox (
 id uuid PRIMARY KEY, subject text NOT NULL, payload jsonb NOT NULL, published_at timestamptz,
 attempts integer NOT NULL DEFAULT 0, last_error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(created_at) WHERE published_at IS NULL;
CREATE TABLE IF NOT EXISTS replays (
 id uuid PRIMARY KEY, source_id text REFERENCES sources(id), from_time timestamptz NOT NULL, to_time timestamptz NOT NULL,
 cleaning_version integer NOT NULL, target_dataset text NOT NULL DEFAULT 'current', status text NOT NULL DEFAULT 'pending',
 checkpoint jsonb NOT NULL DEFAULT '{}', counters jsonb NOT NULL DEFAULT '{}', last_error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), CHECK(from_time < to_time)
);
CREATE TABLE IF NOT EXISTS vessels (
 mmsi text PRIMARY KEY CHECK (mmsi ~ '^[0-9]{9}$'), name text, imo text, callsign text, ship_type integer,
 destination text, dimensions jsonb, static_data jsonb NOT NULL DEFAULT '{}',
 observed_at timestamptz, source_priority integer NOT NULL DEFAULT 0, source_id text, event_id text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS positions_latest (
 mmsi text PRIMARY KEY REFERENCES vessels(mmsi), event_id text NOT NULL, capture_id text NOT NULL,
 source_id text NOT NULL, source_kind text NOT NULL, source_priority integer NOT NULL,
 observed_at timestamptz NOT NULL, received_at timestamptz NOT NULL, cleaning_version integer NOT NULL,
 latitude double precision NOT NULL CHECK(latitude BETWEEN -90 AND 90), longitude double precision NOT NULL CHECK(longitude BETWEEN -180 AND 180),
 location geography(Point,4326) NOT NULL, sog double precision, cog double precision, heading double precision, nav_status integer,
 quality jsonb NOT NULL DEFAULT '[]', observation jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS positions_latest_location ON positions_latest USING gist(location);
CREATE INDEX IF NOT EXISTS positions_latest_time ON positions_latest(observed_at);
CREATE TABLE IF NOT EXISTS field_provenance (
 mmsi text NOT NULL REFERENCES vessels(mmsi), field text NOT NULL, source_id text NOT NULL, event_id text NOT NULL,
 observed_at timestamptz, received_at timestamptz NOT NULL, source_kind text NOT NULL, source_priority integer NOT NULL, value jsonb,
 PRIMARY KEY(mmsi,field)
);
CREATE TABLE IF NOT EXISTS archive_batches (
 id text PRIMARY KEY, bucket text NOT NULL, object_key text NOT NULL UNIQUE, source_id text NOT NULL,
 time_bucket timestamptz NOT NULL, first_sequence bigint NOT NULL, last_sequence bigint NOT NULL, sequence_ranges jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('prepared','committed','expired','pending_delete','deleted')),
 raw_records jsonb NOT NULL DEFAULT '[]', capture_ids jsonb NOT NULL DEFAULT '[]', artifact_keys jsonb NOT NULL DEFAULT '[]',
 count integer NOT NULL DEFAULT 0, checksum text, bytes bigint,
 min_received_at timestamptz NOT NULL, max_received_at timestamptz NOT NULL, expire_at timestamptz NOT NULL,
 committed_at timestamptz, delete_after timestamptz, last_error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS archive_batches_expiry ON archive_batches(expire_at) WHERE status='committed';
CREATE TABLE IF NOT EXISTS artifacts (
 id text PRIMARY KEY, bucket text NOT NULL, object_key text NOT NULL UNIQUE, checksum text NOT NULL,
 bytes bigint NOT NULL, content_type text NOT NULL, received_at timestamptz NOT NULL,
 expire_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'available', last_error text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS leases (
 name text PRIMARY KEY, owner text NOT NULL, expires_at timestamptz NOT NULL, fencing_token bigint NOT NULL DEFAULT 1
);
