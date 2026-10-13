ALTER TABLE agent_tasks DROP CONSTRAINT agent_tasks_intent_check;
ALTER TABLE agent_tasks ADD CONSTRAINT agent_tasks_intent_check CHECK(intent IN ('conversation','vessel_list','vessel_detail','analysis','explain','unresolved','intelligence_search'));
ALTER TABLE agent_results DROP CONSTRAINT agent_results_kind_check;
ALTER TABLE agent_results ADD CONSTRAINT agent_results_kind_check CHECK(kind IN ('analysis','vessel_list','vessel_detail','intelligence_search'));
ALTER TABLE agent_results ADD COLUMN intelligence_result jsonb;
ALTER TABLE agent_messages ADD COLUMN result_version integer, ADD COLUMN input_revision integer;
