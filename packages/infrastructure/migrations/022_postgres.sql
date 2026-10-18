-- Spatial focus and business capabilities share the existing durable task/artifact lane.
ALTER TABLE agent_tasks DROP CONSTRAINT agent_tasks_intent_check;
ALTER TABLE agent_tasks ADD CONSTRAINT agent_tasks_intent_check CHECK(intent IN (
 'conversation','vessel_list','vessel_detail','analysis','explain','unresolved',
 'intelligence_search','ais_heatmap','ui_control','vessel_tracks','skill',
 'vessel_highlights','map_camera','map_focus','route_plan','route_manage','event_query','event_manage'
));
ALTER TABLE agent_skill_artifacts DROP CONSTRAINT agent_skill_artifacts_kind_check;
ALTER TABLE agent_skill_artifacts ADD CONSTRAINT agent_skill_artifacts_kind_check CHECK(kind IN (
 'vessel_list','vessel_detail','ais_heatmap','vessel_tracks','intelligence_search','analysis',
 'vessel_highlights','map_camera','map_focus','route_plan','route','operational_events','operational_event'
));
