CREATE TABLE IF NOT EXISTS source_checkpoints (
 source_id text PRIMARY KEY REFERENCES sources(id), checkpoint jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS source_gaps (
 id uuid PRIMARY KEY, source_id text NOT NULL REFERENCES sources(id), run_id uuid REFERENCES runs(id),
 from_time timestamptz NOT NULL, to_time timestamptz NOT NULL,
 reason text NOT NULL, status text NOT NULL CHECK(status IN ('open','recovered','permanent')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(source_id,run_id,from_time,reason), CHECK(from_time<=to_time)
);
CREATE INDEX IF NOT EXISTS source_gaps_source_time ON source_gaps(source_id,from_time);
