CREATE TABLE topic_instances (
  id uuid PRIMARY KEY, definition_id text NOT NULL, name text NOT NULL,
  config jsonb NOT NULL, enabled boolean NOT NULL DEFAULT false,
  generation integer NOT NULL DEFAULT 1 CHECK(generation > 0),
  status text NOT NULL DEFAULT 'disabled', checkpoint timestamptz,
  last_run_at timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now(),
  next_run_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE topic_runs (
  id uuid PRIMARY KEY, instance_id uuid NOT NULL REFERENCES topic_instances(id),
  generation integer NOT NULL, trigger text NOT NULL, request_key text NOT NULL,
  status text NOT NULL DEFAULT 'queued', from_time timestamptz NOT NULL,
  to_time timestamptz NOT NULL, attempts integer NOT NULL DEFAULT 0,
  lease_token uuid, lease_until timestamptz, available_at timestamptz NOT NULL DEFAULT now(),
  error text, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  UNIQUE(instance_id,generation,request_key), CHECK(from_time <= to_time)
);
CREATE INDEX topic_runs_pending ON topic_runs(available_at,created_at) WHERE status IN ('queued','running');
CREATE TABLE analysis_results (
  id text PRIMARY KEY, instance_id uuid NOT NULL REFERENCES topic_instances(id),
  revision integer NOT NULL, fingerprint text NOT NULL, payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX analysis_results_instance ON analysis_results(instance_id,updated_at DESC);
CREATE TABLE analysis_revisions (
  result_id text NOT NULL REFERENCES analysis_results(id), revision integer NOT NULL,
  run_id uuid NOT NULL REFERENCES topic_runs(id), payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(result_id,revision)
);
CREATE TABLE analysis_feed (
  sequence bigserial PRIMARY KEY, result_id text NOT NULL REFERENCES analysis_results(id),
  instance_id uuid NOT NULL REFERENCES topic_instances(id), generation integer NOT NULL,
  revision integer NOT NULL, status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz, suppressed_at timestamptz, attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(), last_error text,
  UNIQUE(result_id,revision)
);
CREATE INDEX analysis_feed_pending ON analysis_feed(sequence) WHERE published_at IS NULL AND suppressed_at IS NULL;
CREATE TABLE topic_delivery_failures (
  instance_id uuid NOT NULL REFERENCES topic_instances(id), event_id text NOT NULL,
  error text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(instance_id,event_id)
);
