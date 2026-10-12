import { defineNuxtModule } from '@nuxt/kit';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { createLiveUpgradeProxy } from './liveProxy';

type Upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => unknown;
export default defineNuxtModule({
  meta: { name: 'fusion-development-live-proxy' },
  setup(_options, nuxt) {
    if (!nuxt.options.dev) return;
    const proxy = createLiveUpgradeProxy('http://127.0.0.1:13000');
    // Nuxt's supported listen hook runs after the CLI attaches its upgrade listener.
    // That listener delegates to nuxt.server.upgrade for each request. Nitro devProxy
    // handles HTTP only, so route the authenticated live socket before its worker.
    nuxt.hook('listen', () => {
      const server = nuxt.server as { upgrade?: Upgrade } | undefined;
      if (!server?.upgrade) throw new Error('Nuxt development upgrade handler is unavailable');
      const original = server.upgrade.bind(server);
      server.upgrade = (request, socket, head) => {
        if (request.url?.split('?')[0] === '/api/v1/live')
          return proxy.upgrade(request, socket, head);
        return original(request, socket, head);
      };
    });
    nuxt.hook('close', () => proxy.close());
  },
});
