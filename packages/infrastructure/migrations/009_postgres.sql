ALTER TABLE intelligence_sources
  ADD COLUMN IF NOT EXISTS last_ingestion jsonb NOT NULL DEFAULT '{}';
