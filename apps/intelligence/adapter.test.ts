import { expect, it } from 'vitest';
import { decodeStructuredEvents, readLocalFeed } from './adapter';
it('binds imported event source to the registered source and enforces maximum events', () => {
  expect(() =>
    decodeStructuredEvents(Buffer.from('[{"sourceId":"other"}]'), 'registered'),
  ).toThrow();
  expect(() =>
    decodeStructuredEvents(Buffer.from(JSON.stringify(Array(1001).fill({}))), 's'),
  ).toThrow('1000');
});
it('rejects path escape before accessing a local file', async () => {
  await expect(readLocalFeed('../outside.json', process.cwd())).rejects.toThrow('outside');
});
