ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_owner_unique UNIQUE(id,owner_id);
ALTER TABLE agent_tasks ADD CONSTRAINT agent_tasks_session_owner_unique UNIQUE(id,session_id,owner_id);
CREATE TABLE agent_memory_accounts (
 owner_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
 settings_revision integer NOT NULL DEFAULT 0 CHECK(settings_revision>=0),
 generation integer NOT NULL DEFAULT 0 CHECK(generation>=0),
 read_enabled boolean NOT NULL DEFAULT true, write_enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE agent_account_memories (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES agent_memory_accounts(owner_id) ON DELETE CASCADE,
 category text, memory_key text, value jsonb, source jsonb NOT NULL DEFAULT '{}',
 status text NOT NULL CHECK(status IN ('proposed','active','rejected','deleted','expired')),
 revision integer NOT NULL CHECK(revision>0), generation integer NOT NULL CHECK(generation>=0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz,
 CHECK((status IN ('active','proposed') AND category IS NOT NULL AND memory_key IS NOT NULL AND value IS NOT NULL)
   OR (status IN ('rejected','deleted','expired') AND value IS NULL AND category IS NULL AND memory_key IS NULL AND source='{}'::jsonb)),
 UNIQUE(id,owner_id)
);
CREATE UNIQUE INDEX agent_account_memories_key ON agent_account_memories(owner_id,category,memory_key,status) WHERE status IN ('active','proposed');
CREATE INDEX agent_account_memories_expiry ON agent_account_memories(expires_at) WHERE status='proposed';
CREATE TABLE agent_session_memories (
 session_id uuid PRIMARY KEY, owner_id uuid NOT NULL,
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0), turn_seq integer NOT NULL DEFAULT 0 CHECK(turn_seq>=0),
 next_turn_seq integer NOT NULL DEFAULT 0 CHECK(next_turn_seq>=0), generation integer NOT NULL DEFAULT 0 CHECK(generation>=0),
 conditions jsonb NOT NULL DEFAULT '{}', refs jsonb NOT NULL DEFAULT '[]', summary text NOT NULL DEFAULT '',
 reset_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(session_id,owner_id) REFERENCES agent_sessions(id,owner_id) ON DELETE CASCADE,
 UNIQUE(session_id,owner_id)
);
CREATE TABLE agent_memory_object_sets (
 owner_id uuid NOT NULL, session_id uuid NOT NULL, id text NOT NULL, metadata jsonb NOT NULL,
 PRIMARY KEY(owner_id,session_id,id),
 FOREIGN KEY(session_id,owner_id) REFERENCES agent_session_memories(session_id,owner_id) ON DELETE CASCADE
);
CREATE TABLE agent_memory_object_members (
 owner_id uuid NOT NULL, session_id uuid NOT NULL, set_id text NOT NULL, ordinal integer NOT NULL CHECK(ordinal>=0), member jsonb NOT NULL,
 PRIMARY KEY(owner_id,session_id,set_id,ordinal),
 FOREIGN KEY(owner_id,session_id,set_id) REFERENCES agent_memory_object_sets(owner_id,session_id,id) ON DELETE CASCADE
);
CREATE TABLE agent_memory_object_targets (
 owner_id uuid NOT NULL, session_id uuid NOT NULL, set_id text NOT NULL, ordinal integer NOT NULL CHECK(ordinal>=0), target jsonb NOT NULL,
 PRIMARY KEY(owner_id,session_id,set_id,ordinal),
 FOREIGN KEY(owner_id,session_id,set_id) REFERENCES agent_memory_object_sets(owner_id,session_id,id) ON DELETE CASCADE
);
CREATE TABLE agent_task_memory_snapshots (
 owner_id uuid NOT NULL, session_id uuid NOT NULL, task_id uuid NOT NULL, input_revision integer NOT NULL CHECK(input_revision>=0),
 context jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(task_id,input_revision),
 FOREIGN KEY(task_id,session_id,owner_id) REFERENCES agent_tasks(id,session_id,owner_id) ON DELETE CASCADE,
 FOREIGN KEY(session_id,owner_id) REFERENCES agent_session_memories(session_id,owner_id) ON DELETE CASCADE
);
CREATE TABLE agent_memory_operations (
 owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, operation_id uuid NOT NULL,
 request_hash text NOT NULL, action text NOT NULL, resource_id text, revision integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,operation_id)
);
CREATE TABLE agent_memory_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, action text NOT NULL,
 resource_id text, revision integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE agent_memory_redactions (
 owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, task_id uuid NOT NULL,
 PRIMARY KEY(owner_id,task_id)
);
CREATE TABLE agent_memory_entry_sources (
 owner_id uuid NOT NULL, entry_id uuid NOT NULL, source_key text NOT NULL, task_id uuid, message_id uuid,
 PRIMARY KEY(owner_id,entry_id,source_key),
 FOREIGN KEY(entry_id,owner_id) REFERENCES agent_account_memories(id,owner_id) ON DELETE CASCADE,
 CHECK(task_id IS NOT NULL OR message_id IS NOT NULL)
);
CREATE TABLE agent_memory_message_redactions (
 owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, message_id uuid NOT NULL,
 PRIMARY KEY(owner_id,message_id)
);
