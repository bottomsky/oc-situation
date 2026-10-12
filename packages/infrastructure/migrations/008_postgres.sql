ALTER TABLE intelligence_archives ADD COLUMN source_urls text[] NOT NULL DEFAULT '{}';
CREATE TABLE intelligence_objects(id text PRIMARY KEY,kind text NOT NULL,name text NOT NULL,data jsonb NOT NULL,geom geometry(Geometry,4326) CHECK(geom IS NULL OR ST_IsValid(geom)),updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX intelligence_objects_geom ON intelligence_objects USING gist(geom);
CREATE TABLE intelligence_relations(id text NOT NULL,event_id text NOT NULL REFERENCES intelligence_events(id),revision integer NOT NULL,data jsonb NOT NULL,geom geometry(Geometry,4326) CHECK(geom IS NULL OR ST_IsValid(geom)),recorded_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(id,revision));
CREATE INDEX intelligence_relations_event ON intelligence_relations(event_id);
CREATE INDEX intelligence_relations_geom ON intelligence_relations USING gist(geom);
CREATE TABLE intelligence_reviews(id bigserial PRIMARY KEY,event_id text NOT NULL REFERENCES intelligence_events(id),review_status text NOT NULL CHECK(review_status IN ('candidate','confirmed','rejected')),actor text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE intelligence_plot_sets(user_id text PRIMARY KEY,data jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO intelligence_relations(id,event_id,revision,data,geom)
SELECT e.id||':legacy:bbox',e.id,1,jsonb_build_object('id',e.id||':legacy:bbox','eventId',e.id,'revision',1,'kind','applies-to','geometry',ST_AsGeoJSON(g.g)::jsonb,'basis','旧公告区域框兼容转换','paragraphIds','[]'::jsonb,'reviewStatus',COALESCE(e.event->>'reviewStatus','confirmed'),'origin','legacy','recordedAt',e.created_at),g.g
FROM intelligence_events e CROSS JOIN LATERAL (SELECT CASE WHEN (e.event->'bbox'->>0)::float8 <= (e.event->'bbox'->>2)::float8 THEN ST_MakeEnvelope((e.event->'bbox'->>0)::float8,(e.event->'bbox'->>1)::float8,(e.event->'bbox'->>2)::float8,(e.event->'bbox'->>3)::float8,4326) ELSE ST_Collect(ST_MakeEnvelope((e.event->'bbox'->>0)::float8,(e.event->'bbox'->>1)::float8,180,(e.event->'bbox'->>3)::float8,4326),ST_MakeEnvelope(-180,(e.event->'bbox'->>1)::float8,(e.event->'bbox'->>2)::float8,(e.event->'bbox'->>3)::float8,4326)) END g) g WHERE e.event ? 'bbox';
DO $$
DECLARE item record; stable_id uuid;
BEGIN
  FOR item IN SELECT m.value mmsi,min(e.effective_from) first_seen FROM intelligence_events e CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(e.event->'mmsis','[]'::jsonb)) m WHERE NOT EXISTS(SELECT 1 FROM vessel_identifiers v WHERE v.identifier_type='mmsi' AND v.identifier=m.value AND v.valid_to IS NULL) GROUP BY m.value LOOP
    stable_id=md5('legacy-intelligence-vessel:'||item.mmsi)::uuid;
    INSERT INTO vessel_objects(id) VALUES(stable_id) ON CONFLICT DO NOTHING;
    INSERT INTO vessel_identifiers(vessel_id,identifier,valid_from) VALUES(stable_id,item.mmsi,item.first_seen) ON CONFLICT DO NOTHING;
  END LOOP;
END $$;
INSERT INTO intelligence_objects(id,kind,name,data)
SELECT DISTINCT v.vessel_id::text,'vessel',v.identifier,jsonb_build_object('id',v.vessel_id::text,'kind','vessel','name',v.identifier,'mmsi',v.identifier,'aliases','[]'::jsonb,'metadata','{}'::jsonb,'updatedAt',now()) FROM vessel_identifiers v WHERE v.identifier_type='mmsi' AND v.valid_to IS NULL ON CONFLICT DO NOTHING;
INSERT INTO intelligence_relations(id,event_id,revision,data)
SELECT e.id||':legacy:mmsi:'||m.value,e.id,1,jsonb_build_object('id',e.id||':legacy:mmsi:'||m.value,'eventId',e.id,'revision',1,'kind','involves','objectId',v.vessel_id::text,'basis','旧公告MMSI兼容转换','paragraphIds','[]'::jsonb,'reviewStatus',COALESCE(e.event->>'reviewStatus','confirmed'),'origin','legacy','recordedAt',e.created_at)
FROM intelligence_events e CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(e.event->'mmsis','[]'::jsonb)) m JOIN vessel_identifiers v ON v.identifier=m.value AND v.identifier_type='mmsi' AND v.valid_to IS NULL;
