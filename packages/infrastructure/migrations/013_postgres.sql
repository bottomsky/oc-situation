-- Bind continuation to its exact preceding task; never search past an unfinished task.
ALTER TABLE agent_tasks ADD COLUMN parent_task_id uuid REFERENCES agent_tasks(id) ON DELETE SET NULL;
WITH ordered AS (
 SELECT id, lag(id) OVER (PARTITION BY session_id ORDER BY created_at,id) AS parent_id FROM agent_tasks
)
UPDATE agent_tasks task SET parent_task_id=ordered.parent_id FROM ordered WHERE task.id=ordered.id;
CREATE INDEX agent_tasks_parent ON agent_tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;
