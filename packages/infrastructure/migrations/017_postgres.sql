ALTER TABLE agent_tasks DROP CONSTRAINT agent_tasks_intent_check;
ALTER TABLE agent_tasks ADD CONSTRAINT agent_tasks_intent_check
  CHECK(intent IN ('conversation','vessel_list','vessel_detail','analysis','explain','unresolved','intelligence_search','ais_heatmap'));
ALTER TABLE agent_results DROP CONSTRAINT agent_results_kind_check;
ALTER TABLE agent_results ADD CONSTRAINT agent_results_kind_check
  CHECK(kind IN ('analysis','vessel_list','vessel_detail','intelligence_search','ais_heatmap'));
ALTER TABLE agent_results ADD COLUMN heatmap_result jsonb;
ALTER TABLE agent_results ADD CONSTRAINT agent_results_heatmap_result_check
  CHECK ((kind = 'ais_heatmap' AND heatmap_result IS NOT NULL AND heatmap_result->>'kind' = 'ais_heatmap')
    OR (kind <> 'ais_heatmap' AND heatmap_result IS NULL));
