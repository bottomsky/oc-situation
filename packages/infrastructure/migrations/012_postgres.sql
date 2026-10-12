CREATE TABLE agent_sessions (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id), title text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_sessions_owner ON agent_sessions(owner_id,created_at);
CREATE TABLE agent_tasks (
 id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES agent_sessions(id), owner_id uuid NOT NULL REFERENCES users(id),
 idempotency_key uuid NOT NULL, request_hash text NOT NULL,
 status text NOT NULL CHECK(status IN ('awaiting_input','queued','running','waiting_result','completed','failed','cancelled')),
 goal text NOT NULL, bbox jsonb, history_hours integer NOT NULL CHECK(history_hours BETWEEN 1 AND 168),
 from_time timestamptz NOT NULL, to_time timestamptz NOT NULL,
 definition_id text CHECK(definition_id IN ('port-restriction','area-low-speed-notice')),
 generation integer NOT NULL DEFAULT 0, worker_id text, lease_until timestamptz,
 model_calls integer NOT NULL DEFAULT 0, tool_calls integer NOT NULL DEFAULT 0,
 result_version integer NOT NULL DEFAULT 0, summary_result_version integer, summary text, error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,idempotency_key)
);
CREATE INDEX agent_tasks_pending ON agent_tasks(status,lease_until);
CREATE INDEX agent_tasks_session ON agent_tasks(session_id,created_at);
CREATE TABLE agent_messages (
 id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES agent_sessions(id), task_id uuid REFERENCES agent_tasks(id),
 role text NOT NULL CHECK(role IN ('user','assistant')), content text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_messages_session ON agent_messages(session_id,created_at);
CREATE TABLE agent_steps (
 task_id uuid NOT NULL REFERENCES agent_tasks(id), step_key text NOT NULL, name text NOT NULL,
 input jsonb NOT NULL, output jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(task_id,step_key)
);
CREATE TABLE agent_results (
 task_id uuid NOT NULL REFERENCES agent_tasks(id), version integer NOT NULL,
 results jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(task_id,version)
);
CREATE TABLE agent_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, session_id uuid NOT NULL REFERENCES agent_sessions(id),
 task_id uuid REFERENCES agent_tasks(id), type text NOT NULL, data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_events_session ON agent_events(session_id,id);
