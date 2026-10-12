import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

/** Controlled loopback fixture. Every vessel is synthetic. */
export function createFixtureServer(clock?: string, options: { robotsRateLimitOnce?: boolean } = {}) {
  let robotsAttempts = 0;
  return createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1:13002');
    response.setHeader('x-ais-synthetic', 'true');
    response.setHeader('cache-control', 'no-store');
    if (url.pathname === '/robots.txt') {
      if (options.robotsRateLimitOnce && robotsAttempts++ === 0) {
        response.writeHead(429, { 'retry-after': '1' }).end('Synthetic robots limit');
        return;
      }
      response.setHeader('content-type', 'text/plain');
      response.end('User-agent: *\nDisallow: /robots-blocked\n');
      return;
    }
    if (url.pathname === '/blocked401') {
      response.writeHead(401).end('Authorization required');
      return;
    }
    if (url.pathname === '/limited429') {
      response.setHeader('retry-after', '1');
      response.writeHead(429).end('Synthetic rate limit');
      return;
    }
    if (url.pathname === '/oversize') {
      response.setHeader('content-type', 'text/html');
      response.end('x'.repeat(10_485_761));
      return;
    }
    if (url.pathname === '/redirect-private') {
      response.writeHead(302, { location: 'http://127.0.0.1:1/private' }).end();
      return;
    }
    const page = Number(url.searchParams.get('page') ?? 1);
    const data = [0, 1].map((index) => ({
      mmsi: String(413793000 + (page - 1) * 2 + index),
      lat: 33 + index * 0.1,
      lon: 124 + page * 0.1,
      observedAt: clock ?? new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString(),
      sogKnots: 12.3,
      cogDegrees: 87.5,
      fields: { name: `SYNTHETIC DEMO ${page}-${index}`, shipType: 70 },
    }));
    const payload = { synthetic: true, data, next: page === 1 ? '/ais.json?page=2' : null };
    if (url.pathname === '/assets.css') { response.setHeader('content-type', 'text/css'); response.end('body { color: navy; }'); return; }
    if (url.pathname === '/assets.js') { response.setHeader('content-type', 'application/javascript'); response.end("fetch('/ais.json?page=2').then(r=>r.json()).then(value=>{const el=document.createElement('script');el.id='ais-data';el.type='application/json';el.textContent=JSON.stringify(value);document.body.appendChild(el);});"); return; }
    if (url.pathname === '/browser-resources.html') {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><link rel="stylesheet" href="/assets.css"><script src="/assets.js"></script><h1>SYNTHETIC DEMO</h1>');
      return;
    }
    if (url.pathname === '/ais.json') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(payload));
      return;
    }
    if (url.pathname === '/ais.html' || url.pathname === '/ais-dynamic.html') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      const json = JSON.stringify({ synthetic: true, data });
      const script =
        url.pathname === '/ais.html'
          ? `<script id="ais-data" type="application/json">${json}</script>`
          : `<script>setTimeout(()=>{const el=document.createElement('script');el.id='ais-data';el.type='application/json';el.textContent=${JSON.stringify(json)};document.body.appendChild(el);},50);</script>`;
      response.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic AIS fixture</title></head><body data-synthetic="true"><h1>Synthetic AIS fixture</h1>${script}</body></html>`,
      );
      return;
    }
    response.writeHead(404).end('Synthetic fixture path not found');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.NODE_ENV === 'production')
    throw new Error('Development fixtures are disabled in production');
  const server = createFixtureServer(process.env.AIS_FIXTURE_CLOCK);
  server.listen(13002, '127.0.0.1', () =>
    console.log('Synthetic AIS fixture listening on http://127.0.0.1:13002'),
  );
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close());
}
