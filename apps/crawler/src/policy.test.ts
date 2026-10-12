import { expect, it } from 'vitest';
import { assertAllowedUrl } from './policy';
it('rejects private DNS resolution and non-allowlisted hosts', async () => {
  await expect(
    assertAllowedUrl('https://safe.example/ais', {
      allowedHosts: ['safe.example'],
      resolve: async () => ['127.0.0.1'],
    }),
  ).rejects.toThrow('Private network target');
  await expect(
    assertAllowedUrl('https://evil.example/ais', { allowedHosts: ['safe.example'] }),
  ).rejects.toThrow('Host is not registered');
});
it('permits only the registered loopback fixture on its fixed development port', async () => {
  await expect(
    assertAllowedUrl('http://127.0.0.1:13002/ais.json', {
      allowedHosts: ['127.0.0.1'],
      developmentFixture: true,
    }),
  ).resolves.toBeInstanceOf(URL);
  await expect(
    assertAllowedUrl('http://127.0.0.1:13003/ais.json', {
      allowedHosts: ['127.0.0.1'],
      developmentFixture: true,
    }),
  ).rejects.toThrow();
  await expect(
    assertAllowedUrl('http://127.0.0.1:13002/ais.json', {
      allowedHosts: ['127.0.0.1'],
      developmentFixture: false,
    }),
  ).rejects.toThrow();
});
