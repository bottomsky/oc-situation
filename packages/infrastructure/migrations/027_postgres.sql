CREATE TABLE prediction_topics (
  instance_id uuid PRIMARY KEY REFERENCES topic_instances(id),
  owner_id text NOT NULL,
  mmsi text NOT NULL CHECK(mmsi ~ '^[1-9][0-9]{8}$'),
  definition_id text NOT NULL DEFAULT 'vessel-reachability',
  watch boolean NOT NULL DEFAULT false,
  last_input_fingerprint text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id,mmsi,definition_id)
);
CREATE INDEX prediction_topics_watches ON prediction_topics(owner_id) WHERE watch;
CREATE TABLE prediction_requests (
  owner_id text NOT NULL, request_key uuid NOT NULL, body_hash text NOT NULL,
  instance_id uuid NOT NULL REFERENCES topic_instances(id),
  run_id uuid NOT NULL REFERENCES topic_runs(id),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,request_key)
);
CREATE TABLE analysis_prediction_artifacts (
  result_id text NOT NULL, revision integer NOT NULL,
  artifact jsonb NOT NULL, paths jsonb NOT NULL DEFAULT '[]',
  input_fingerprint text NOT NULL, land_dataset_version text,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(result_id,revision),
  FOREIGN KEY(result_id,revision) REFERENCES analysis_revisions(result_id,revision),
  CHECK(octet_length(artifact::text) <= 33554432),
  CHECK(octet_length(paths::text) <= 67108864)
);
