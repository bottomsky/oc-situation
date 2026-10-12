ALTER TABLE topic_runs ADD COLUMN input_snapshot jsonb;
ALTER TABLE topic_runs ADD COLUMN definition_version text;
ALTER TABLE topic_runs ADD COLUMN config_snapshot jsonb;
ALTER TABLE topic_instances ADD COLUMN pending_from timestamptz;
ALTER TABLE topic_instances ADD COLUMN pending_to timestamptz;
CREATE TABLE topic_event_receipts (
  instance_id uuid NOT NULL REFERENCES topic_instances(id),generation integer NOT NULL,event_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(instance_id,generation,event_id)
);
