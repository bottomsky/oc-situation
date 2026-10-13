CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE FUNCTION intelligence_event_search_text(value jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT concat_ws(' ',value->>'title',value->>'summary',
   (SELECT string_agg(paragraph->>'text',' ' ORDER BY ordinal)
    FROM jsonb_array_elements(coalesce(value->'paragraphs','[]'::jsonb)) WITH ORDINALITY AS items(paragraph,ordinal)))
$$;
ALTER TABLE intelligence_events ADD COLUMN search_text text GENERATED ALWAYS AS (intelligence_event_search_text(event)) STORED;
CREATE INDEX intelligence_events_search_trgm ON intelligence_events USING gin(search_text gin_trgm_ops);
CREATE INDEX intelligence_events_source_category_published ON intelligence_events(source_id,(event->>'category'),published_at DESC,id);
CREATE INDEX intelligence_events_original_archive ON intelligence_events((event->>'originalArchiveId'));
CREATE INDEX intelligence_events_archive_key ON intelligence_events((event->>'archiveKey'));
CREATE INDEX intelligence_archives_source_created ON intelligence_archives(source_id,created_at);
ALTER TABLE intelligence_sources ADD COLUMN next_poll_at timestamptz,
 ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0 CHECK(consecutive_failures>=0);
CREATE TABLE intelligence_ingestion_runs (
 id uuid PRIMARY KEY, source_id text NOT NULL REFERENCES intelligence_sources(id) ON DELETE CASCADE,
 status text NOT NULL CHECK(status IN ('running','succeeded','partial','failed','interrupted')),
 started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 imported integer NOT NULL DEFAULT 0, unchanged integer NOT NULL DEFAULT 0,
 pending integer NOT NULL DEFAULT 0, failures integer NOT NULL DEFAULT 0,
 details jsonb NOT NULL DEFAULT '{}', error_code text
);
CREATE INDEX intelligence_ingestion_runs_source_time ON intelligence_ingestion_runs(source_id,started_at DESC);
CREATE TABLE intelligence_weather_snapshots (
 id text PRIMARY KEY, source_id text NOT NULL REFERENCES intelligence_sources(id),
 point_id text NOT NULL, fetched_at timestamptz NOT NULL, valid_from timestamptz NOT NULL, valid_to timestamptz NOT NULL,
 archive_id text NOT NULL REFERENCES intelligence_archives(id), data jsonb NOT NULL,
 CHECK(valid_from<=valid_to)
);
CREATE INDEX intelligence_weather_latest ON intelligence_weather_snapshots(source_id,point_id,fetched_at DESC,id);
CREATE INDEX intelligence_weather_retention ON intelligence_weather_snapshots(fetched_at);
CREATE TABLE intelligence_weather_pins (
 snapshot_id text NOT NULL REFERENCES intelligence_weather_snapshots(id),
 task_id uuid NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
 input_revision integer NOT NULL CHECK(input_revision>=0),
 PRIMARY KEY(snapshot_id,task_id,input_revision)
);
CREATE TABLE intelligence_weather_archive_gc (
 archive_id text PRIMARY KEY, source_id text NOT NULL REFERENCES intelligence_sources(id), object_key text NOT NULL,
 status text NOT NULL CHECK(status IN ('prepared','deleted')), prepared_at timestamptz NOT NULL DEFAULT now(),
 deleted_at timestamptz, attempts integer NOT NULL DEFAULT 0, last_error text
);
-- A durable prepared GC record reserves the raw archive even if S3 succeeds before a process crash.
CREATE FUNCTION guard_intelligence_archive_gc() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM id FROM intelligence_archives WHERE id=NEW.event->>'originalArchiveId' OR object_key=NEW.event->>'archiveKey' ORDER BY id FOR KEY SHARE;
 IF EXISTS(SELECT 1 FROM intelligence_weather_archive_gc g
   WHERE g.archive_id=NEW.event->>'originalArchiveId' OR g.object_key=NEW.event->>'archiveKey') THEN
   RAISE EXCEPTION 'Archive is reserved for retention cleanup';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER intelligence_events_archive_gc BEFORE INSERT OR UPDATE OF event ON intelligence_events
 FOR EACH ROW EXECUTE FUNCTION guard_intelligence_archive_gc();
