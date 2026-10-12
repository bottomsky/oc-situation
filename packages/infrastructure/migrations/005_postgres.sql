CREATE TABLE IF NOT EXISTS intelligence_sources (
  id text PRIMARY KEY, config jsonb NOT NULL, last_polled_at timestamptz,
  last_error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS intelligence_archives (
  id text PRIMARY KEY, source_id text NOT NULL REFERENCES intelligence_sources(id),
  object_key text NOT NULL UNIQUE, checksum text NOT NULL, bytes integer NOT NULL,
  content_type text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS intelligence_events (
  id text PRIMARY KEY, source_id text NOT NULL REFERENCES intelligence_sources(id),
  external_id text NOT NULL, version integer NOT NULL CHECK(version>0),
  published_at timestamptz NOT NULL, effective_from timestamptz NOT NULL,
  effective_to timestamptz, event jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(source_id, external_id, version)
);
CREATE INDEX IF NOT EXISTS intelligence_events_window ON intelligence_events(effective_from,effective_to);
CREATE TABLE IF NOT EXISTS vessel_objects (id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS vessel_identifiers (
  id bigserial PRIMARY KEY, vessel_id uuid NOT NULL REFERENCES vessel_objects(id),
  identifier_type text NOT NULL DEFAULT 'mmsi', identifier text NOT NULL,
  valid_from timestamptz NOT NULL, valid_to timestamptz,
  CHECK(valid_to IS NULL OR valid_to>valid_from), UNIQUE(identifier_type,identifier,valid_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS vessel_identifier_current ON vessel_identifiers(identifier_type,identifier) WHERE valid_to IS NULL;
CREATE TABLE IF NOT EXISTS fusion_writer_receipts (
  id text PRIMARY KEY, postgres_ready boolean NOT NULL DEFAULT false,
  clickhouse_ready boolean NOT NULL DEFAULT false, event jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fusion_ready_outbox (
  id text PRIMARY KEY, event jsonb NOT NULL, published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fusion_ready_pending ON fusion_ready_outbox(created_at) WHERE published_at IS NULL;
