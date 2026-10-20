import { createServer, request as httpRequest } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, sep, extname } from 'node:path';
import { createAuthHandler } from './auth.mjs';
import { assertAuthReady } from './config.mjs';

export function createSiteServer(config, { root, devPort, fetcher } = {}) {
  assertAuthReady(config);
  const auth = createAuthHandler(config, { fetcher });
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
    '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4', '.json': 'application/json', '.ico': 'image/x-icon', '.ttf': 'font/ttf' };
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    if (!devPort) response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' https://api.github.com; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
    try {
      const expected = new URL(config.origin);
      if (request.headers.host !== expected.host) {
        if (expected.hostname === '127.0.0.1' && request.headers.host === `localhost:${expected.port}` && request.method === 'GET') {
          response.writeHead(307, { Location: `${config.origin}${request.url.startsWith('/') && !request.url.startsWith('//') ? request.url : '/'}` }).end();
        } else response.writeHead(403).end('Open the configured website address.');
        return;
      }
      if (await auth(request, response)) return;
      if (devPort) {
        const upstream = httpRequest({ host: '127.0.0.1', port: devPort, path: request.url, method: request.method, headers: { ...request.headers, host: `127.0.0.1:${devPort}` } }, (incoming) => {
          response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response);
        });
        upstream.on('error', () => { if (!response.headersSent) response.writeHead(503).end('The development bundle is starting. Refresh in a moment.'); else response.destroy(); });
        request.pipe(upstream); response.on('close', () => upstream.destroy()); return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
      let pathname;
      try { pathname = decodeURIComponent(new URL(request.url, config.origin).pathname); }
      catch { response.writeHead(400).end(); return; }
      const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) { response.writeHead(404).end('Not found'); return; }
      const size = statSync(file).size;
      const headers = { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes' };
      let start = 0; let end = size - 1;
      if (request.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
        if (!match || (!match[1] && !match[2])) { response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
        start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
        end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
        if (start > end || start >= size || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) { response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
        response.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
      } else response.writeHead(200, { ...headers, 'Content-Length': size });
      if (request.method === 'HEAD' || size === 0) { response.end(); return; }
      const stream = createReadStream(file, { start, end });
      stream.on('error', () => response.destroy()); stream.pipe(response); response.on('close', () => stream.destroy());
    } catch { if (!response.headersSent) response.writeHead(500).end('The request could not be completed.'); else response.destroy(); }
  });
  if (devPort) server.on('upgrade', (request, socket, head) => {
    if (request.headers.host !== new URL(config.origin).host || (request.headers.origin && request.headers.origin !== config.origin)) { socket.destroy(); return; }
    const upstream = httpRequest({ host: '127.0.0.1', port: devPort, path: request.url, headers: { ...request.headers, host: `127.0.0.1:${devPort}` } });
    upstream.on('upgrade', (incoming, remote, remoteHead) => {
      socket.write(`HTTP/1.1 ${incoming.statusCode} ${incoming.statusMessage}\r\n${Object.entries(incoming.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      remote.pipe(socket); socket.pipe(remote);
      remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy());
    });
    upstream.on('error', () => socket.destroy()); upstream.end();
  });
  return server;
}
