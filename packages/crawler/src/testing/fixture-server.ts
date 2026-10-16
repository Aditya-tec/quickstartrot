import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export interface FixtureServer {
  origin: string;
  url(pathname: string): string;
  close(): Promise<void>;
}

/**
 * Static server for fixtures/docs-site, used by crawler tests and (later) the canary targets.
 * `redirects` maps request paths to 302 targets, e.g. { '/old': '/quickstart-basic.html' }.
 */
export async function startFixtureServer(
  dir: string,
  opts: { redirects?: Record<string, string>; port?: number } = {},
): Promise<FixtureServer> {
  const root = path.resolve(dir);
  const server: Server = createServer((req, res) => {
    void (async () => {
      const pathname = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
      const redirect = opts.redirects?.[pathname];
      if (redirect) {
        res.writeHead(302, { Location: redirect }).end();
        return;
      }
      const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (file !== root && !file.startsWith(root + path.sep)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      try {
        const body = await readFile(file);
        res
          .writeHead(200, {
            'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
          })
          .end(body);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); // e.g. EADDRINUSE: without this the promise would hang forever
    server.listen(opts.port ?? 0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('fixture server failed to bind');
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    url: (p) => `${origin}${p}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
