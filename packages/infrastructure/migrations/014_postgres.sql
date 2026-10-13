ALTER TABLE agent_tasks
 ADD COLUMN intent text NOT NULL DEFAULT 'unresolved' CHECK(intent IN ('conversation','vessel_list','vessel_detail','analysis','explain','unresolved')),
 ADD COLUMN selection jsonb NOT NULL DEFAULT '{}',
 ADD COLUMN input_revision integer NOT NULL DEFAULT 0 CHECK(input_revision>=0),
 ADD COLUMN result_input_revision integer,
 ADD COLUMN summary_input_revision integer,
 ADD COLUMN error_code text,
 ADD COLUMN retry_of_task_id uuid REFERENCES agent_tasks(id) ON DELETE SET NULL,
 ADD COLUMN retry_source_input_revision integer,
 ADD COLUMN retry_source_result_version integer;
UPDATE agent_tasks SET selection=jsonb_strip_nulls(jsonb_build_object('bbox',bbox,'timeRange',jsonb_build_object('from',to_char(from_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'to',to_char(to_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),'purpose',definition_id)),
 result_input_revision=CASE WHEN result_version>0 THEN 0 ELSE NULL END,
 summary_input_revision=CASE WHEN summary IS NOT NULL THEN 0 ELSE NULL END,
 intent=CASE WHEN definition_id IS NOT NULL THEN 'analysis' ELSE 'unresolved' END;
ALTER TABLE agent_steps ADD COLUMN input_revision integer NOT NULL DEFAULT 0;
ALTER TABLE agent_steps DROP CONSTRAINT agent_steps_pkey;
ALTER TABLE agent_steps ADD PRIMARY KEY(task_id,input_revision,step_key);
ALTER TABLE agent_results ADD COLUMN input_revision integer NOT NULL DEFAULT 0,
 ADD COLUMN kind text NOT NULL DEFAULT 'analysis' CHECK(kind IN ('analysis','vessel_list','vessel_detail')),
 ADD COLUMN query_result jsonb;
CREATE UNIQUE INDEX agent_results_revision_kind ON agent_results(task_id,input_revision,kind);
CREATE TABLE agent_input_requests (
 id uuid PRIMARY KEY,
 task_id uuid NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES agent_sessions(id),
 input_revision integer NOT NULL,
 pause_generation integer NOT NULL,
 fields jsonb NOT NULL,
 reason text NOT NULL,
 prefill jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','answered','cancelled','superseded')),
 response jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), answered_at timestamptz
);
CREATE UNIQUE INDEX agent_input_requests_pending ON agent_input_requests(task_id) WHERE status='pending';
CREATE INDEX agent_input_requests_session ON agent_input_requests(session_id,status);
CREATE TABLE agent_input_responses (
 owner_id uuid NOT NULL REFERENCES users(id), idempotency_key uuid NOT NULL,
 request_id uuid NOT NULL REFERENCES agent_input_requests(id) ON DELETE CASCADE,
 request_hash text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,idempotency_key), UNIQUE(request_id)
);
