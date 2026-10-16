ALTER TABLE agent_tasks DROP CONSTRAINT agent_tasks_intent_check;
ALTER TABLE agent_tasks ADD CONSTRAINT agent_tasks_intent_check CHECK(intent IN ('conversation','vessel_list','vessel_detail','analysis','explain','unresolved','intelligence_search','ais_heatmap','ui_control'));
ALTER TABLE agent_tasks DROP CONSTRAINT agent_tasks_status_check;
ALTER TABLE agent_tasks ADD CONSTRAINT agent_tasks_status_check CHECK(status IN ('awaiting_input','queued','running','waiting_result','waiting_ui','completed','failed','cancelled'));
ALTER TABLE agent_tasks ADD COLUMN ui_binding jsonb;
ALTER TABLE agent_tasks ADD COLUMN ui_result jsonb;
CREATE TABLE agent_ui_clients (
 id uuid PRIMARY KEY, instance_id uuid NOT NULL, owner_id uuid NOT NULL REFERENCES users(id),
 page_generation integer NOT NULL DEFAULT 1, session_id uuid REFERENCES agent_sessions(id),
 state jsonb, state_sequence bigint NOT NULL DEFAULT -1, observed_at timestamptz,
 lease_until timestamptz NOT NULL, UNIQUE(owner_id,instance_id)
);
CREATE TABLE agent_ui_commands (
 id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES agent_tasks(id), input_revision integer NOT NULL,
 task_generation integer NOT NULL, client_id uuid NOT NULL REFERENCES agent_ui_clients(id), page_generation integer NOT NULL,
 operation jsonb NOT NULL, expected_version integer NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','claimed','executing','succeeded','failed','rejected','cancelled','expired','unknown')),
 claim_token uuid, claim_until timestamptz, expires_at timestamptz NOT NULL DEFAULT now()+interval '60 seconds',
 result jsonb, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(task_id,input_revision)
);
CREATE INDEX agent_ui_commands_pending ON agent_ui_commands(client_id,status,created_at);
CREATE TABLE agent_ui_receipts (
 receipt_id uuid PRIMARY KEY, command_id uuid NOT NULL REFERENCES agent_ui_commands(id),
 body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
