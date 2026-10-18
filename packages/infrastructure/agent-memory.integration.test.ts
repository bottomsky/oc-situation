import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createInfrastructure, type Infrastructure } from './clients';
import { runMigrations } from './migrations';
import { createAgentSession, submitAgentMessage } from './agent';
import {
  captureAgentMemoryContext,
  getAgentTaskMemoryContext,
  getAgentMemorySettings,
  updateAgentMemorySettings,
  getAgentAccountMemory,
  mutateAgentAccountMemory,
  getAgentSessionMemory,
  saveAgentSessionMemory,
  resetAgentSessionMemory,
} from './agent-memory';

describe('owner-scoped durable agent memory', () => {
  let infra: Infrastructure;
  const owner = randomUUID();
  const other = randomUUID();
  beforeAll(async () => {
    infra = await createInfrastructure();
    await runMigrations(infra);
    for (const id of [owner, other])
      await infra.pool.query(
        'INSERT INTO users(id,username,password_hash,role) VALUES($1::uuid,$1::text,$2,$3)',
        [id, 'test-only', 'operator'],
      );
  });
  afterAll(async () => {
    if (!infra) return;
    // Task/message cleanup mirrors existing tests because the original task tables predate cascade deletion.
    await infra.pool.query(
      'DELETE FROM agent_messages WHERE session_id IN(SELECT id FROM agent_sessions WHERE owner_id=ANY($1::uuid[]))',
      [[owner, other]],
    );
    await infra.pool.query(
      'DELETE FROM agent_events WHERE session_id IN(SELECT id FROM agent_sessions WHERE owner_id=ANY($1::uuid[]))',
      [[owner, other]],
    );
    await infra.pool.query('DELETE FROM agent_tasks WHERE owner_id=ANY($1::uuid[])', [
      [owner, other],
    ]);
    await infra.pool.query('DELETE FROM agent_sessions WHERE owner_id=ANY($1::uuid[])', [
      [owner, other],
    ]);
    await infra.pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[owner, other]]);
    await infra.close();
  });
  it('fences concurrent revisions and replays an operation without resurrecting deleted text', async () => {
    const write = {
      operationId: randomUUID(),
      expectedRevision: 0,
      action: 'remember' as const,
      category: 'preference',
      key: 'language',
      value: 'secret-zh',
    };
    const state = await mutateAgentAccountMemory(infra, owner, write);
    expect(state.entries[0]?.status).toBe('active');
    expect(await mutateAgentAccountMemory(infra, owner, write)).toEqual(state);
    await expect(
      mutateAgentAccountMemory(infra, owner, { ...write, operationId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await getAgentAccountMemory(infra, other)).entries).toEqual([]);
    const deleted = await mutateAgentAccountMemory(infra, owner, {
      operationId: randomUUID(),
      expectedRevision: state.revision,
      action: 'delete',
      entryId: state.entries[0]!.id,
    });
    expect(deleted.entries).toEqual([]);
    expect((await mutateAgentAccountMemory(infra, owner, write)).entries).toEqual([]);
    const tombstone = await infra.pool.query(
      'SELECT value,source,memory_key FROM agent_account_memories WHERE id=$1',
      [state.entries[0]!.id],
    );
    expect(tombstone.rows[0]).toMatchObject({ value: null, source: {}, memory_key: null });
    await expect(
      mutateAgentAccountMemory(infra, owner, {
        ...write,
        operationId: write.operationId,
        value: 'changed',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('requires generation fencing for suggestions, expires after 30 days and allows explicit remembers with suggestions paused', async () => {
    const settings = await getAgentMemorySettings(infra, owner);
    let state = await getAgentAccountMemory(infra, owner);
    state = await mutateAgentAccountMemory(infra, owner, {
      operationId: randomUUID(),
      expectedRevision: state.revision,
      expectedGeneration: settings.generation,
      action: 'propose',
      category: 'habit',
      key: 'units',
      value: 'knots',
    });
    expect(state.entries).toEqual([]);
    const candidate = (await getAgentAccountMemory(infra, owner, { includeProposed: true }))
      .entries[0]!;
    expect(candidate.status).toBe('proposed');
    expect(Date.parse(candidate.expiresAt!) - Date.parse(candidate.createdAt)).toBe(30 * 86400000);
    await infra.pool.query(
      "UPDATE agent_account_memories SET expires_at=now()-interval '1 second' WHERE id=$1",
      [candidate.id],
    );
    expect((await getAgentAccountMemory(infra, owner, { includeProposed: true })).entries).toEqual(
      [],
    );
    await expect(
      mutateAgentAccountMemory(infra, owner, {
        operationId: randomUUID(),
        expectedRevision: state.revision,
        action: 'accept',
        entryId: candidate.id,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const paused = await updateAgentMemorySettings(infra, owner, {
      operationId: randomUUID(),
      expectedRevision: settings.revision,
      readEnabled: true,
      proposalsEnabled: false,
    });
    await expect(
      mutateAgentAccountMemory(infra, owner, {
        operationId: randomUUID(),
        expectedRevision: state.revision,
        expectedGeneration: settings.generation,
        action: 'propose',
        category: 'habit',
        key: 'other',
        value: 'late',
      }),
    ).rejects.toMatchObject({ code: 'STALE_GENERATION' });
    state = await mutateAgentAccountMemory(infra, owner, {
      operationId: randomUUID(),
      expectedRevision: state.revision,
      action: 'remember',
      category: 'preference',
      key: 'units',
      value: 'knots',
    });
    expect(state.entries[0]?.status).toBe('active');
    await updateAgentMemorySettings(infra, owner, {
      operationId: randomUUID(),
      expectedRevision: paused.revision,
      readEnabled: true,
      proposalsEnabled: true,
    });
  });
  it('stores all set members, freezes task snapshots, rejects late turns and erases reset projections', async () => {
    const session = await createAgentSession(infra, owner, 'Memory');
    const sessionMemory = (await getAgentSessionMemory(infra, owner, session.id))!;
    const members = Array.from({ length: 1001 }, (_, index) => ({
      kind: 'vessel' as const,
      mmsi: String(100000000 + index),
    }));
    const updated = (await saveAgentSessionMemory(infra, owner, session.id, {
      expectedRevision: sessionMemory.revision,
      expectedGeneration: sessionMemory.generation,
      turnSeq: 1,
      objectSets: [
        { id: 'fleet', label: '这些船', kind: 'vessels', turnSeq: 1, members, source: {} },
      ],
      summary: 'recent',
    }))!;
    expect(updated.objectSets[0]?.members).toHaveLength(1001);
    expect(await getAgentSessionMemory(infra, other, session.id)).toBeNull();
    expect(
      await saveAgentSessionMemory(infra, owner, session.id, {
        expectedRevision: updated.revision,
        turnSeq: 0,
        summary: 'late',
      }),
    ).toBeNull();
    const task = (
      await submitAgentMessage(infra, owner, session.id, randomUUID(), {
        content: '当前北京时间',
        historyHours: 24,
      })
    ).task;
    const snapshot = await captureAgentMemoryContext(infra, owner, session.id, task.id, 0);
    expect(snapshot.session?.objectSets[0]?.members).toHaveLength(1001);
    expect(await captureAgentMemoryContext(infra, owner, session.id, task.id, 0)).toEqual(snapshot);
    expect(await getAgentTaskMemoryContext(infra, other, task.id)).toBeNull();
    const newerTask = (
      await submitAgentMessage(infra, owner, session.id, randomUUID(), {
        content: '当前北京时间',
        historyHours: 24,
      })
    ).task;
    const newer = await captureAgentMemoryContext(infra, owner, session.id, newerTask.id, 0);
    expect(newer.turnSeq).toBeGreaterThan(snapshot.turnSeq);
    expect(
      await saveAgentSessionMemory(infra, owner, session.id, {
        expectedRevision: updated.revision,
        turnSeq: snapshot.turnSeq,
        summary: 'old task after new submit',
      }),
    ).toBeNull();
    const client = await infra.pool.connect();
    try {
      await client.query('BEGIN');
      await saveAgentSessionMemory(
        infra,
        owner,
        session.id,
        { expectedRevision: updated.revision, turnSeq: newer.turnSeq, summary: 'rollback' },
        client,
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect((await getAgentSessionMemory(infra, owner, session.id))?.summary).toBe('recent');
    const reset = await resetAgentSessionMemory(infra, owner, session.id, {
      operationId: randomUUID(),
      expectedRevision: updated.revision,
    });
    expect(reset.objectSets).toEqual([]);
    expect((await getAgentTaskMemoryContext(infra, owner, task.id))?.session).toBeNull();
    expect(
      await saveAgentSessionMemory(infra, owner, session.id, {
        expectedRevision: reset.revision,
        expectedGeneration: updated.generation,
        turnSeq: snapshot.turnSeq + 1,
        summary: 'late revival',
      }),
    ).toBeNull();
    await mutateAgentAccountMemory(infra, owner, {
      operationId: randomUUID(),
      expectedRevision: (await getAgentAccountMemory(infra, owner)).revision,
      action: 'clear',
    });
    expect((await getAgentTaskMemoryContext(infra, owner, task.id))?.account).toEqual([]);
    const rows = await infra.pool.query(
      'SELECT context::text AS text FROM agent_task_memory_snapshots WHERE owner_id=$1',
      [owner],
    );
    expect(rows.rows.some((row) => row.text.includes('knots'))).toBe(false);
  });
  it('reads frozen context in a READ ONLY transaction and keeps session memory while account recall is disabled', async () => {
    const session = await createAgentSession(infra, owner, 'independent scopes');
    const settings = await getAgentMemorySettings(infra, owner);
    await updateAgentMemorySettings(infra, owner, {
      operationId: randomUUID(),
      expectedRevision: settings.revision,
      readEnabled: false,
      proposalsEnabled: true,
    });
    const task = (
      await submitAgentMessage(infra, owner, session.id, randomUUID(), {
        content: '当前北京时间',
        historyHours: 24,
      })
    ).task;
    const snapshot = await captureAgentMemoryContext(infra, owner, session.id, task.id, 0);
    expect(snapshot.session).not.toBeNull();
    expect(snapshot.account).toEqual([]);
    const client = await infra.pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      expect(
        (await getAgentTaskMemoryContext(infra, owner, task.id, 0, client))?.session,
      ).not.toBeNull();
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const otherSession = await createAgentSession(infra, other, 'other');
    const otherTask = (
      await submitAgentMessage(infra, other, otherSession.id, randomUUID(), {
        content: '当前北京时间',
        historyHours: 24,
      })
    ).task;
    await expect(
      mutateAgentAccountMemory(infra, owner, {
        operationId: randomUUID(),
        expectedRevision: (await getAgentAccountMemory(infra, owner)).revision,
        action: 'remember',
        category: 'x',
        key: 'forged',
        value: 'x',
        source: { taskId: otherTask.id },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('confirms and rejects suggestions, serializes conflicting writes and redacts forgotten source turns', async () => {
    let settings = await getAgentMemorySettings(infra, owner);
    settings = await updateAgentMemorySettings(infra, owner, {
      operationId: randomUUID(),
      expectedRevision: settings.revision,
      readEnabled: true,
      proposalsEnabled: true,
    });
    const session = await createAgentSession(infra, owner, 'source redaction');
    const task = (
      await submitAgentMessage(infra, owner, session.id, randomUUID(), {
        content: '我通常关注集装箱船',
        historyHours: 24,
      })
    ).task;
    let state = await getAgentAccountMemory(infra, owner);
    await mutateAgentAccountMemory(infra, owner, {
      operationId: randomUUID(),
      expectedRevision: state.revision,
      expectedGeneration: settings.generation,
      action: 'propose',
      category: 'tests',
      key: 'redaction',
      value: 'container',
      source: { taskId: task.id },
    });
    state = await getAgentAccountMemory(infra, owner, { includeProposed: true });
    const proposed = state.entries.find((entry) => entry.category === 'tests')!;
    state = await mutateAgentAccountMemory(infra, owner, {
      operationId: randomUUID(),
      expectedRevision: state.revision,
      action: 'accept',
      entryId: proposed.id,
    });
    expect(state.entries.find((entry) => entry.id === proposed.id)?.status).toBe('active');
    const results = await Promise.allSettled(
      ['one', 'two'].map((key) =>
        mutateAgentAccountMemory(infra, owner, {
          operationId: randomUUID(),
          expectedRevision: state.revision,
          action: 'remember',
          category: 'concurrency',
          key,
          value: key,
        }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const next = (
      await submitAgentMessage(infra, owner, session.id, randomUUID(), {
        content: '当前北京时间',
        historyHours: 24,
      })
    ).task;
    await captureAgentMemoryContext(infra, owner, session.id, next.id, 0);
    state = await getAgentAccountMemory(infra, owner);
    await mutateAgentAccountMemory(infra, owner, {
      operationId: randomUUID(),
      expectedRevision: state.revision,
      action: 'remember',
      entryId: proposed.id,
      category: 'tests',
      key: 'redaction',
      value: 'edited container',
      source: { description: 'edited from settings' },
    });
    await mutateAgentAccountMemory(infra, owner, {
      operationId: randomUUID(),
      expectedRevision: (await getAgentAccountMemory(infra, owner)).revision,
      action: 'delete',
      entryId: proposed.id,
    });
    const context = await getAgentTaskMemoryContext(infra, owner, next.id);
    expect(context?.recentTurns.some((turn) => turn.taskId === task.id)).toBe(false);
    expect(context?.account.some((entry) => entry.id === proposed.id)).toBe(false);
    const afterDelete = (
      await submitAgentMessage(infra, owner, session.id, randomUUID(), {
        content: '当前北京时间',
        historyHours: 24,
      })
    ).task;
    expect(
      (await getAgentTaskMemoryContext(infra, owner, afterDelete.id))?.recentTurns.some(
        (turn) => turn.taskId === task.id,
      ),
    ).toBe(false);
    expect(
      (
        await infra.pool.query('SELECT task_id FROM agent_memory_entry_sources WHERE entry_id=$1', [
          proposed.id,
        ])
      ).rows.some((row) => row.task_id === task.id),
    ).toBe(true);
    state = await getAgentAccountMemory(infra, owner);
    settings = await getAgentMemorySettings(infra, owner);
    await mutateAgentAccountMemory(infra, owner, {
      operationId: randomUUID(),
      expectedRevision: state.revision,
      expectedGeneration: settings.generation,
      action: 'propose',
      category: 'tests',
      key: 'rejected',
      value: 'candidate',
    });
    state = await getAgentAccountMemory(infra, owner, { includeProposed: true });
    const reject = state.entries.find((entry) => entry.key === 'rejected')!;
    await mutateAgentAccountMemory(infra, owner, {
      operationId: randomUUID(),
      expectedRevision: state.revision,
      action: 'reject',
      entryId: reject.id,
    });
    expect(
      (
        await infra.pool.query(
          'SELECT value,source,status FROM agent_account_memories WHERE id=$1',
          [reject.id],
        )
      ).rows[0],
    ).toMatchObject({ value: null, source: {}, status: 'rejected' });
  });
  it('serializes first-session reset with a real concurrent submit without an inverse account lock', async () => {
    const session = await createAgentSession(infra, owner, 'concurrent first access');
    let signalLocked!: () => void;
    let releaseSubmit!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      releaseSubmit = resolve;
    });
    const submissionInfra = {
      ...infra,
      pool: {
        connect: async () => {
          const client = await infra.pool.connect();
          let paused = false;
          return new Proxy(client, {
            get(target, property) {
              if (property === 'query')
                return async (statement: string, parameters?: unknown[]) => {
                  const result = await target.query(statement, parameters);
                  if (
                    !paused &&
                    statement ===
                      'SELECT id FROM agent_sessions WHERE id=$1 AND owner_id=$2 FOR UPDATE'
                  ) {
                    paused = true;
                    signalLocked();
                    await resume;
                  }
                  return result;
                };
              const value = Reflect.get(target, property);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        },
      },
    } as Infrastructure;
    const submitting = submitAgentMessage(submissionInfra, owner, session.id, randomUUID(), {
      content: '当前北京时间',
      historyHours: 24,
    });
    await locked;
    const resetting = resetAgentSessionMemory(infra, owner, session.id, {
      operationId: randomUUID(),
      expectedRevision: 0,
    });
    try {
      for (let attempt = 0; attempt < 50; attempt++) {
        const waiting = await infra.pool.query(
          "SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND state='active' AND wait_event_type='Lock' AND query LIKE '%agent_session%'",
        );
        if (waiting.rows[0].count > 0) break;
        await infra.pool.query('SELECT pg_sleep(0.01)');
      }
    } finally {
      releaseSubmit();
    }
    const results = await Promise.allSettled([submitting, resetting]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect((await getAgentSessionMemory(infra, owner, session.id))?.generation).toBe(1);
  });
  it('keeps eight actual task rounds despite intervening memory-management messages', async () => {
    const session = await createAgentSession(infra, owner, 'eight rounds');
    const business: string[] = [];
    for (let index = 0; index < 9; index++)
      business.push(
        (
          await submitAgentMessage(infra, owner, session.id, randomUUID(), {
            content: '当前北京时间',
            historyHours: 24,
          })
        ).task.id,
      );
    for (let index = 0; index < 10; index++)
      await submitAgentMessage(infra, owner, session.id, randomUUID(), {
        content: `记住：回答方式test${index}`,
        historyHours: 24,
      });
    const latest = (
      await submitAgentMessage(infra, owner, session.id, randomUUID(), {
        content: '当前北京时间',
        historyHours: 24,
      })
    ).task;
    const context = await getAgentTaskMemoryContext(infra, owner, latest.id);
    const rounds = [...new Set(context!.recentTurns.map((turn) => turn.taskId))];
    expect(rounds).toHaveLength(8);
    expect(rounds).toEqual(expect.arrayContaining([...business.slice(-7), latest.id]));
    expect(context!.recentTurns.every((turn) => !turn.content.includes('回答方式test'))).toBe(true);
  });
  it('freezes at most ten relevant active memories and keeps a late exact-name match', async () => {
    let state = await getAgentAccountMemory(infra, owner);
    state = await mutateAgentAccountMemory(infra, owner, {
      operationId: randomUUID(),
      expectedRevision: state.revision,
      action: 'clear',
    });
    for (let index = 0; index < 11; index++)
      state = await mutateAgentAccountMemory(infra, owner, {
        operationId: randomUUID(),
        expectedRevision: state.revision,
        action: 'remember',
        category: 'preference',
        key: `unrelated-${index}`,
        value: `unrelated-${index}`,
      });
    state = await mutateAgentAccountMemory(infra, owner, {
      operationId: randomUUID(),
      expectedRevision: state.revision,
      action: 'remember',
      category: 'named_region',
      key: '某某港测试',
      value: 'an exact named preference',
    });
    const session = await createAgentSession(infra, owner, 'bounded account snapshot');
    const task = (
      await submitAgentMessage(infra, owner, session.id, randomUUID(), {
        content: '查询某某港测试相关情况',
        historyHours: 24,
      })
    ).task;
    const snapshot = (await getAgentTaskMemoryContext(infra, owner, task.id))!;
    expect(snapshot.account).toHaveLength(10);
    expect(snapshot.account.some((entry) => entry.key === '某某港测试')).toBe(true);
    const ids = snapshot.account.map((entry) => entry.id);
    await mutateAgentAccountMemory(infra, owner, {
      operationId: randomUUID(),
      expectedRevision: state.revision,
      action: 'remember',
      category: 'preference',
      key: 'later addition',
      value: 'future',
    });
    expect((await getAgentAccountMemory(infra, owner)).entries).toHaveLength(13);
    expect(
      (await captureAgentMemoryContext(infra, owner, session.id, task.id, 0)).account.map(
        (entry) => entry.id,
      ),
    ).toEqual(ids);
  });
});
