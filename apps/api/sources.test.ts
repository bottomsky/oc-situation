import { expect, it } from 'vitest';
import type { SourceConfig } from '@ais/contracts';
import { validateSource } from './src/sources/validation';
const source: SourceConfig = {
  sourceId: 'test',
  sourceKind: 'marinetraffic',
  name: 'test',
  status: 'enabled',
  secretRef: 'MARINETRAFFIC_API_KEY',
  priority: 1,
  endpoint: 'https://services.marinetraffic.com/api/exportvessel/v:8',
};
it('requires authorization and budget for a real enabled source', () => {
  expect(() => validateSource(source, true)).toThrow();
  expect(() =>
    validateSource(
      {
        ...source,
        settings: {
          allowedHosts: ['services.marinetraffic.com'],
          authorizationConfirmed: true,
          requestsPerMinute: 5,
          maxPages: 3,
          httpConcurrency: 1,
          browserConcurrency: 1,
          timeoutSeconds: 30,
          timespanMinutes: 5,
          pageLimit: 2000,
        },
      },
      true,
    ),
  ).not.toThrow();
});
it('rejects credentials, arbitrary vendor endpoints and production fixtures', () => {
  expect(() =>
    validateSource({ ...source, status: 'disabled', secretRef: 'secret-value-with-hyphen' }, true),
  ).toThrow();
  expect(() =>
    validateSource({ ...source, status: 'disabled', endpoint: 'https://evil.test/' }, true),
  ).toThrow();
  expect(() =>
    validateSource(
      {
        ...source,
        sourceKind: 'fixture-http',
        endpoint: 'http://localhost:13002',
        status: 'enabled',
        secretRef: null,
      },
      true,
    ),
  ).toThrow();
});
