import { afterEach, expect, it } from 'vitest';
import { createFixtureServer } from '../../../tests/fixture-server/server';
const servers: ReturnType<typeof createFixtureServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
});
it('serves explicit synthetic paginated HTTP and dynamically rendered JSON data', async () => {
  const server = createFixtureServer('2026-09-29T06:42:13Z');
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP fixture address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const first = (await (await fetch(`${baseUrl}/ais.json`)).json()) as {
    synthetic: boolean;
    next: string;
    data: unknown[];
  };
  expect(first.synthetic).toBe(true);
  expect(first.next).toBe('/ais.json?page=2');
  expect(first.data).toHaveLength(2);
  expect(await (await fetch(`${baseUrl}/ais-dynamic.html`)).text()).toContain(
    "document.createElement('script')",
  );
  expect((await fetch(`${baseUrl}/blocked401`)).status).toBe(401);
});
