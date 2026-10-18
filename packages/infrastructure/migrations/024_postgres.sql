CREATE TABLE operational_events (
  id uuid PRIMARY KEY, revision integer NOT NULL CHECK(revision>0),
  status text NOT NULL CHECK(status IN ('active','resolved','archived','merged')),
  data jsonb NOT NULL, geom geometry(Geometry,4326),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX operational_events_geom ON operational_events USING gist((geom::geography));
CREATE TABLE operational_event_revisions (
  event_id uuid NOT NULL REFERENCES operational_events(id), revision integer NOT NULL,
  data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(event_id,revision)
);
CREATE TABLE operational_event_sources (
  source_key text PRIMARY KEY, event_id uuid NOT NULL REFERENCES operational_events(id),
  revision bigint NOT NULL, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX operational_event_sources_event ON operational_event_sources(event_id);
CREATE TABLE operational_event_source_heads (
  source_key text PRIMARY KEY, revision bigint NOT NULL, fingerprint text NOT NULL, snapshot jsonb NOT NULL
);
CREATE TABLE operational_event_source_revisions (
  source_key text NOT NULL, revision bigint NOT NULL, snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(source_key,revision)
);
CREATE TABLE event_sync_outbox (
  id bigserial PRIMARY KEY, source_key text NOT NULL, revision bigint NOT NULL, snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), applied_at timestamptz,
  attempts integer NOT NULL DEFAULT 0, last_error text, UNIQUE(source_key,revision)
);
CREATE INDEX event_sync_pending ON event_sync_outbox(id) WHERE applied_at IS NULL;
CREATE TABLE operational_event_operations (
  actor_id uuid NOT NULL, operation_id uuid NOT NULL, fingerprint text NOT NULL,
  result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(actor_id,operation_id)
);
