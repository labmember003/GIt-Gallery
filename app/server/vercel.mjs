import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuthHandler } from './auth.mjs';
import { loadConfig, assertAuthReady } from './config.mjs';

const app = fileURLToPath(new URL('../', import.meta.url));

/** No listener or process-local auth state: the platform invokes this for each API request. */
export function createVercelHandler(config, options) {
  assertAuthReady(config);
  const auth = createAuthHandler(config, options);
  return async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    try {
      // Vercel routes every API depth to one function. Keep the public path and strip routing metadata.
      const url = new URL(request.url, config.origin);
      const routed = url.searchParams.get('__gg_path');
      if (routed !== null) {
        if (url.searchParams.getAll('__gg_path').length !== 1 || routed.length > 4096 || /^[\/]/.test(routed) || /[\\?#\x00-\x20]/.test(routed)) {
          response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Invalid API request.' })); return;
        }
        if (url.pathname === '/api/index' || url.pathname === '/api/index.mjs') url.pathname = `/api/${routed}`;
        url.searchParams.delete('__gg_path');
        request.url = `${url.pathname}${url.search}`;
      }
      if (!await auth(request, response)) response.writeHead(404).end();
    } catch {
      if (response.headersSent || response.destroyed) { response.destroy(); return; }
      response.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '30' });
      response.end(JSON.stringify({ error: 'The sign-in service is temporarily unavailable. Please try again shortly.' }));
    }
  };
}

let handler;
export default async function vercel(request, response) {
  try {
    handler ??= createVercelHandler(loadConfig(resolve(app)));
    await handler(request, response);
  } catch {
    response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '30' });
    response.end(JSON.stringify({ error: 'Website sign-in setup is incomplete. The website owner needs to connect GitHub and shared session storage. See docs/WEB-DEPLOYMENT.md.' }));
  }
}
