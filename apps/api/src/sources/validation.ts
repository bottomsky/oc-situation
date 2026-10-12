import { BadRequestException } from '@nestjs/common';
import type { SourceConfig } from '@ais/contracts';
export function validateSource(source: SourceConfig, production: boolean): SourceConfig {
  const reject = (message: string): never => {
    throw new BadRequestException(message);
  };
  if (source.secretRef && !/^[A-Z][A-Z0-9_]{1,99}$/.test(source.secretRef))
    reject('secretRef must be an environment variable name');
  const fixture = source.sourceKind.startsWith('fixture-');
  if (fixture && production && source.status === 'enabled')
    reject('Production fixtures must be disabled');
  let endpoint: URL | undefined;
  if (source.endpoint) {
    endpoint = new URL(source.endpoint);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
      reject('Endpoint must not contain credentials, query or fragment');
    if (fixture) {
      if (
        !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
        !['http:', 'https:'].includes(endpoint.protocol)
      )
        reject('Fixture endpoint must be a local HTTP server');
    } else if (source.sourceKind === 'marinetraffic') {
      if (endpoint.hostname !== 'services.marinetraffic.com' || endpoint.protocol !== 'https:')
        reject('MarineTraffic endpoint host is fixed');
    } else if (endpoint.hostname !== 'stream.aisstream.io' || endpoint.protocol !== 'wss:')
      reject('AISStream endpoint host is fixed');
  }
  if (source.status === 'enabled') {
    if (!fixture && (!source.secretRef || !source.settings?.authorizationConfirmed))
      reject('Enabled commercial source requires secretRef and confirmed authorization');
    const settings = source.settings;
    if (!settings || !settings.allowedHosts.length)
      return reject('Enabled source requires explicit allowedHosts and request budgets');
    if (source.sourceKind === 'marinetraffic' && settings.requestsPerMinute > 100)
      reject('MarineTraffic request budget must be at most 100 requests per minute and within account authorization');
    const host =
      endpoint?.hostname ??
      (source.sourceKind === 'marinetraffic'
        ? 'services.marinetraffic.com'
        : 'stream.aisstream.io');
    if (!settings.allowedHosts.includes(host))
      reject('Endpoint host must be included in allowedHosts');
    const permitted = fixture
      ? ['localhost', '127.0.0.1']
      : source.sourceKind === 'marinetraffic'
        ? ['services.marinetraffic.com']
        : ['stream.aisstream.io'];
    if (settings.allowedHosts.some((h) => !permitted.includes(h)))
      reject('allowedHosts must be restricted to the source vendor');
  }
  return source;
}
