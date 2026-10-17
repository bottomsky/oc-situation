-- Personal, immutable skill versions and recoverable task execution.
ALTER TABLE agent_tasks DROP CONSTRAINT agent_tasks_intent_check;
ALTER TABLE agent_tasks ADD CONSTRAINT agent_tasks_intent_check CHECK(intent IN ('conversation','vessel_list','vessel_detail','analysis','explain','unresolved','intelligence_search','ais_heatmap','ui_control','vessel_tracks','skill'));
ALTER TABLE agent_tasks ADD COLUMN skill_ref jsonb;
ALTER TABLE agent_tasks ADD COLUMN skill_version_policy text NOT NULL DEFAULT 'original' CHECK(skill_version_policy IN ('original','latest'));
ALTER TABLE agent_tasks ADD CONSTRAINT agent_tasks_owner_unique UNIQUE(id,owner_id);
CREATE TABLE agent_dynamic_skill_catalogs (
 owner_id uuid PRIMARY KEY REFERENCES users(id), revision integer NOT NULL DEFAULT 0 CHECK(revision>=0)
);
CREATE TABLE agent_dynamic_skills (
 owner_id uuid NOT NULL REFERENCES users(id), skill_id text NOT NULL,
 name text NOT NULL, description text NOT NULL, enabled boolean NOT NULL DEFAULT true,
 current_version text NOT NULL, source text NOT NULL CHECK(source IN ('agent','user')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,skill_id), UNIQUE(owner_id,name)
);
CREATE TABLE agent_dynamic_skill_versions (
 owner_id uuid NOT NULL, skill_id text NOT NULL, version text NOT NULL,
 validator_version text NOT NULL DEFAULT 'dynamic-skill-validator/1',
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'), adapter_version text NOT NULL,
 definition jsonb NOT NULL, source text NOT NULL CHECK(source IN ('agent','user')),
 created_by_task_id uuid, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,skill_id,version),
 FOREIGN KEY(owner_id,skill_id) REFERENCES agent_dynamic_skills(owner_id,skill_id),
 FOREIGN KEY(created_by_task_id,owner_id) REFERENCES agent_tasks(id,owner_id)
);
ALTER TABLE agent_dynamic_skills ADD CONSTRAINT agent_dynamic_skills_current_version_fk FOREIGN KEY(owner_id,skill_id,current_version) REFERENCES agent_dynamic_skill_versions(owner_id,skill_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE agent_dynamic_skill_operations (
 owner_id uuid NOT NULL REFERENCES users(id), operation_id uuid NOT NULL,
 request_hash text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,operation_id)
);
CREATE TABLE agent_task_skill_bindings (
 task_id uuid NOT NULL, owner_id uuid NOT NULL, input_revision integer NOT NULL CHECK(input_revision>=0),
 skill_id text NOT NULL, version text NOT NULL, content_hash text NOT NULL, adapter_version text NOT NULL,
 tool_ceiling text[] NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(task_id,input_revision),
 FOREIGN KEY(task_id,owner_id) REFERENCES agent_tasks(id,owner_id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,skill_id,version) REFERENCES agent_dynamic_skill_versions(owner_id,skill_id,version)
);
CREATE TABLE agent_skill_calls (
 call_id uuid PRIMARY KEY, task_id uuid NOT NULL, owner_id uuid NOT NULL, input_revision integer NOT NULL,
 step_id text NOT NULL, tool_id text NOT NULL, generation integer NOT NULL, input_hash text NOT NULL,
 input jsonb NOT NULL, status text NOT NULL CHECK(status IN ('running','completed','failed','unknown','waiting_ui')),
 local_result jsonb, model_projection jsonb, artifact_refs jsonb NOT NULL DEFAULT '[]', error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(task_id,input_revision,step_id),
 FOREIGN KEY(task_id,owner_id) REFERENCES agent_tasks(id,owner_id) ON DELETE CASCADE,
 FOREIGN KEY(task_id,input_revision) REFERENCES agent_task_skill_bindings(task_id,input_revision)
);
CREATE TABLE agent_skill_artifacts (
 id uuid PRIMARY KEY, task_id uuid NOT NULL, owner_id uuid NOT NULL, input_revision integer NOT NULL,
 step_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('vessel_list','vessel_detail','ais_heatmap','vessel_tracks','intelligence_search','analysis')),
 payload jsonb NOT NULL, model_projection jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(task_id,input_revision,step_id,kind), UNIQUE(id,task_id,input_revision),
 FOREIGN KEY(task_id,owner_id) REFERENCES agent_tasks(id,owner_id) ON DELETE CASCADE,
 FOREIGN KEY(task_id,input_revision,step_id) REFERENCES agent_skill_calls(task_id,input_revision,step_id)
);
CREATE INDEX agent_dynamic_skill_versions_creator ON agent_dynamic_skill_versions(created_by_task_id) WHERE created_by_task_id IS NOT NULL;
CREATE INDEX agent_skill_artifacts_task ON agent_skill_artifacts(task_id,input_revision,created_at);
ALTER TABLE agent_ui_commands DROP CONSTRAINT agent_ui_commands_task_id_input_revision_key;
ALTER TABLE agent_ui_commands ADD COLUMN step_id text NOT NULL DEFAULT 'legacy';
ALTER TABLE agent_ui_commands ADD COLUMN artifact_ref uuid;
ALTER TABLE agent_ui_commands ADD CONSTRAINT agent_ui_commands_artifact_scope_fk FOREIGN KEY(artifact_ref,task_id,input_revision) REFERENCES agent_skill_artifacts(id,task_id,input_revision);
ALTER TABLE agent_ui_commands ADD CONSTRAINT agent_ui_commands_task_revision_step_unique UNIQUE(task_id,input_revision,step_id);

-- Application code can revoke a version; its published content remains immutable.
CREATE FUNCTION agent_skill_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at') THEN
  RAISE EXCEPTION 'Published skill version is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER agent_dynamic_skill_version_immutable BEFORE UPDATE ON agent_dynamic_skill_versions
 FOR EACH ROW EXECUTE FUNCTION agent_skill_version_immutable();
CREATE FUNCTION agent_skill_record_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Task skill binding and artifact are immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER agent_task_skill_binding_immutable BEFORE UPDATE ON agent_task_skill_bindings
 FOR EACH ROW EXECUTE FUNCTION agent_skill_record_immutable();
CREATE TRIGGER agent_skill_artifact_immutable BEFORE UPDATE ON agent_skill_artifacts
 FOR EACH ROW EXECUTE FUNCTION agent_skill_record_immutable();
