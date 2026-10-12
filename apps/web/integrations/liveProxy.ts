import { request, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

/** Development-only raw upgrade forwarding; authentication remains in the API gateway. */
export function createLiveUpgradeProxy(target: string) {
  const upstream = new URL(target);
  if (upstream.protocol !== 'http:') throw new Error('Development API target must use HTTP');
  const clients = new Map<Duplex, () => void>();
  function upgrade(incoming: IncomingMessage, client: Duplex, head: Buffer) {
    let backend: Duplex | undefined;
    const pending = request({
      hostname: upstream.hostname,
      port: upstream.port || 80,
      method: incoming.method,
      path: incoming.url,
      headers: incoming.headers,
    });
    function dispose() {
      clients.delete(client);
      pending.destroy();
      backend?.destroy();
      client.destroy();
    }
    clients.set(client, dispose);
    client.on('error', dispose);
    client.once('close', dispose);
    pending.on('error', () => {
      clients.delete(client);
      if (!client.destroyed && !backend)
        client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      else dispose();
    });
    pending.setTimeout(10000, () => pending.destroy(new Error('API upgrade timed out')));
    pending.on('response', (response) => {
      clients.delete(client);
      if (!client.destroyed)
        client.end(
          `HTTP/1.1 ${response.statusCode ?? 502} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
      response.resume();
    });
    pending.on('upgrade', (response, socket, upstreamHead) => {
      backend = socket;
      socket.setTimeout(0);
      socket.on('error', dispose);
      socket.once('close', dispose);
      if (client.destroyed) {
        dispose();
        return;
      }
      const headers: string[] = [];
      for (let i = 0; i < response.rawHeaders.length; i += 2)
        headers.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`);
      client.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.join('\r\n')}\r\n\r\n`);
      if (upstreamHead.length) client.write(upstreamHead);
      if (head.length) socket.write(head);
      socket.pipe(client);
      client.pipe(socket);
    });
    pending.end();
  }
  return {
    upgrade,
    connections: () => clients.size,
    close() {
      for (const dispose of clients.values()) dispose();
    },
  };
}
