import { expect, it } from 'vitest';
import { flushOutbox, type Infrastructure } from './index';
import { testBusHealth } from '../../tests/helpers/bus-health';

function outboxFixture(pressure?: string) {
  const statements: string[] = [];
  const published: string[] = [];
  const client = {
    query: async (sql: string) => {
      statements.push(sql);
      if (sql.startsWith('SELECT'))
        return { rows: [{ id: 'queued-command', subject: 'ais.commands.crawl', payload: {} }] };
      return { rows: [] };
    },
    release: () => {},
  };
  const infra = {
    pool: { connect: async () => client },
    jsm: testBusHealth(pressure),
    js: {
      publish: async (subject: string) => {
        published.push(subject);
      },
    },
  } as unknown as Infrastructure;
  return { infra, statements, published };
}

it.each(['AIS_RAW', 'AIS_NORMALIZED', 'AIS_COMMANDS'])(
  'preserves durable outbox without publication or marking it sent while %s is pressured',
  async (pressure) => {
    const fixture = outboxFixture(pressure);
    await expect(flushOutbox(fixture.infra)).rejects.toThrow(`pressure:${pressure}`);
    expect(fixture.published).toEqual([]);
    expect(fixture.statements.some((sql) => sql.startsWith('UPDATE outbox'))).toBe(false);
    expect(fixture.statements.at(-1)).toBe('ROLLBACK');
  },
);

it('publishes and marks an outbox command sent when the full bus is ready', async () => {
  const fixture = outboxFixture();
  expect(await flushOutbox(fixture.infra)).toBe(1);
  expect(fixture.published).toEqual(['ais.commands.crawl']);
  expect(fixture.statements.some((sql) => sql.startsWith('UPDATE outbox'))).toBe(true);
  expect(fixture.statements.at(-1)).toBe('COMMIT');
});
