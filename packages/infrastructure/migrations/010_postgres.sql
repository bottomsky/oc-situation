ALTER TABLE intelligence_archives
  ADD COLUMN IF NOT EXISTS source_urls text[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'intelligence_objects'::regclass
      AND conname = 'intelligence_objects_geom_check'
  ) THEN
    ALTER TABLE intelligence_objects
      ADD CONSTRAINT intelligence_objects_geom_check
      CHECK (geom IS NULL OR ST_IsValid(geom));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'intelligence_relations'::regclass
      AND conname = 'intelligence_relations_geom_check'
  ) THEN
    ALTER TABLE intelligence_relations
      ADD CONSTRAINT intelligence_relations_geom_check
      CHECK (geom IS NULL OR ST_IsValid(geom));
  END IF;
END $$;
