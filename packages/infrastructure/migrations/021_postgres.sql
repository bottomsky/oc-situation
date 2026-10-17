-- Map skills reuse the durable UI command lane and its scoped artifact foreign key.
ALTER TABLE agent_tasks DROP CONSTRAINT agent_tasks_intent_check;
ALTER TABLE agent_tasks ADD CONSTRAINT agent_tasks_intent_check CHECK(intent IN ('conversation','vessel_list','vessel_detail','analysis','explain','unresolved','intelligence_search','ais_heatmap','ui_control','vessel_tracks','skill','vessel_highlights','map_camera'));
ALTER TABLE agent_skill_artifacts DROP CONSTRAINT agent_skill_artifacts_kind_check;
ALTER TABLE agent_skill_artifacts ADD CONSTRAINT agent_skill_artifacts_kind_check CHECK(kind IN ('vessel_list','vessel_detail','ais_heatmap','vessel_tracks','intelligence_search','analysis','vessel_highlights','map_camera'));
CREATE TABLE agent_ui_artifacts (
 id uuid PRIMARY KEY, task_id uuid NOT NULL, owner_id uuid NOT NULL, input_revision integer NOT NULL,
 step_id text NOT NULL, kind text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,task_id,input_revision), UNIQUE(task_id,input_revision,step_id),
 FOREIGN KEY(task_id,owner_id) REFERENCES agent_tasks(id,owner_id) ON DELETE CASCADE
);
INSERT INTO agent_ui_artifacts(id,task_id,owner_id,input_revision,step_id,kind,payload)
 SELECT id,task_id,owner_id,input_revision,step_id,kind,payload FROM agent_skill_artifacts;
CREATE FUNCTION agent_ui_artifact_register() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO agent_ui_artifacts(id,task_id,owner_id,input_revision,step_id,kind,payload)
 VALUES(NEW.id,NEW.task_id,NEW.owner_id,NEW.input_revision,NEW.step_id,NEW.kind,NEW.payload);
 RETURN NEW;
END;
$$;
CREATE TRIGGER agent_skill_ui_artifact_register AFTER INSERT ON agent_skill_artifacts
 FOR EACH ROW EXECUTE FUNCTION agent_ui_artifact_register();
CREATE TRIGGER agent_ui_artifact_immutable BEFORE UPDATE ON agent_ui_artifacts
 FOR EACH ROW EXECUTE FUNCTION agent_skill_record_immutable();
ALTER TABLE agent_ui_commands DROP CONSTRAINT agent_ui_commands_artifact_scope_fk;
ALTER TABLE agent_ui_commands ADD CONSTRAINT agent_ui_commands_artifact_scope_fk
 FOREIGN KEY(artifact_ref,task_id,input_revision) REFERENCES agent_ui_artifacts(id,task_id,input_revision);
