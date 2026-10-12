ALTER TABLE intelligence_sources
  ADD COLUMN IF NOT EXISTS last_successful_at timestamptz;

UPDATE intelligence_sources
SET last_successful_at = last_polled_at
WHERE last_successful_at IS NULL
  AND last_polled_at IS NOT NULL
  AND last_error IS NULL
  AND (last_ingestion->>'failed') IS DISTINCT FROM 'true';
