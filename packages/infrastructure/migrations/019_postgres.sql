ALTER TABLE agent_tasks DROP CONSTRAINT agent_tasks_intent_check;
ALTER TABLE agent_tasks ADD CONSTRAINT agent_tasks_intent_check CHECK(intent IN ('conversation','vessel_list','vessel_detail','analysis','explain','unresolved','intelligence_search','ais_heatmap','ui_control','vessel_tracks'));
ALTER TABLE agent_results DROP CONSTRAINT agent_results_kind_check;
ALTER TABLE agent_results ADD CONSTRAINT agent_results_kind_check CHECK(kind IN ('analysis','vessel_list','vessel_detail','intelligence_search','ais_heatmap','vessel_tracks'));
ALTER TABLE agent_results ADD COLUMN tracks_result jsonb;
ALTER TABLE agent_results ADD CONSTRAINT agent_results_tracks_check CHECK((kind='vessel_tracks' AND tracks_result IS NOT NULL AND (tracks_result->>'kind') IS NOT DISTINCT FROM 'vessel_tracks') OR (kind<>'vessel_tracks' AND tracks_result IS NULL));
