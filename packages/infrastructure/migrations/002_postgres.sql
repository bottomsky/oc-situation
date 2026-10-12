ALTER TABLE runs ADD COLUMN IF NOT EXISTS idempotency_key text;
UPDATE runs SET idempotency_key=checkpoint->>'idempotencyKey' WHERE idempotency_key IS NULL AND checkpoint ? 'idempotencyKey';
CREATE UNIQUE INDEX IF NOT EXISTS runs_job_idempotency ON runs(job_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS runs_replay_idempotency ON runs(source_id,idempotency_key) WHERE mode='replay' AND idempotency_key IS NOT NULL;
