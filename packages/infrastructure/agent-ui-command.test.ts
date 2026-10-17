import { describe, expect, it, vi } from 'vitest';
import type { Infrastructure } from './clients';
import { getUiTaskCommand } from './agent-ui';

const commandRow = (status = 'failed', receiptError: unknown = 'UNAVAILABLE') => ({
  id: 'command-id',
  task_id: 'task-id',
  client_id: 'client-id',
  page_generation: 1,
  operation: { componentId: 'chart.heatmap', action: 'close' },
  expected_version: 2,
  status,
  step_id: 'heatmap',
  artifact_ref: 'artifact-id',
  claim_token: 'sensitive-token',
  result: null,
  receipt_error: receiptError,
});
const fixture = (row: ReturnType<typeof commandRow> | undefined) => {
  const query = vi.fn().mockResolvedValue({ rows: row ? [row] : [] });
  return { query, infra: { pool: { query } } as unknown as Infrastructure };
};

describe('UI command receipt error projection', () => {
  it('returns the typed error while keeping receipt and claim credentials private', async () => {
    const { infra, query } = fixture(commandRow());
    const command = await getUiTaskCommand(infra, 'task-id', 3, 'heatmap');
    expect(command).toMatchObject({ error: 'UNAVAILABLE', stepId: 'heatmap', result: null });
    expect(command).not.toHaveProperty('claimToken');
    expect(command).not.toHaveProperty('receipt_error');
    expect(command).not.toHaveProperty('body');
    const [sql, values] = query.mock.calls[0]!;
    expect(values).toEqual(['task-id', 3, 'heatmap']);
    expect(sql).toContain('q.task_id=$1 AND q.input_revision=$2 AND q.step_id=$3');
    expect(sql).toContain('r.command_id=q.id');
    expect(sql).toContain("r.body->>'status' IN ('succeeded','failed','rejected')");
    expect(sql).toContain('ORDER BY r.created_at DESC,r.receipt_id DESC LIMIT 1');
    expect(sql).toContain("r.body->>'error'");
  });

  it('returns known errors for rejected commands', async () => {
    const { infra } = fixture(commandRow('rejected', 'STATE_CONFLICT'));
    expect(await getUiTaskCommand(infra, 'task-id', 3, 'heatmap')).toHaveProperty(
      'error',
      'STATE_CONFLICT',
    );
  });

  it.each(['executing', 'succeeded', 'expired'])(
    'does not expose a receipt error for a %s command',
    async (status) => {
      const { infra } = fixture(commandRow(status));
      expect(await getUiTaskCommand(infra, 'task-id', 3)).not.toHaveProperty('error');
    },
  );

  it.each([null, 'UNTRUSTED_ERROR', { secret: 'private' }])(
    'ignores missing or unknown receipt errors: %j',
    async (error) => {
      const { infra } = fixture(commandRow('failed', error));
      expect(await getUiTaskCommand(infra, 'task-id', 3)).not.toHaveProperty('error');
    },
  );

  it('returns null without a matching task command', async () => {
    const { infra } = fixture(undefined);
    expect(await getUiTaskCommand(infra, 'missing', 3)).toBeNull();
  });
});
