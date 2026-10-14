import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { State } from './state.ts';

const PAGE = readFileSync(new URL('./page.html', import.meta.url), 'utf8');

export interface ServerOptions {
  host: string;
  port: number;
  /** How long to coalesce pushes, default 30 ms */
  coalesceMs?: number;
}

/** What the buttons on the page can trigger. */
export interface Controls {
  setMic(on: boolean): Promise<void>;
  refreshSummary(): void;
}

interface Client {
  res: ServerResponse;
  seen: number;
}

/** The local page: `/` is the page, `/events` is the SSE stream. */
export class SubtitleServer {
  private readonly server: Server;
  private readonly clients = new Set<Client>();
  private timer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly state: State;
  private readonly opts: ServerOptions;
  /** Set by the app after startup */
  controls: Controls | null = null;

  constructor(state: State, opts: ServerOptions) {
    this.state = state;
    this.opts = opts;
    this.server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      if (req.method === 'POST' && path?.startsWith('/api/')) return void this.api(path, req, res);
      if (path === '/events') return this.accept(req, res);
      if (path === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(PAGE);
        return;
      }
      res.writeHead(404).end('not found');
    });
    state.on('change', this.schedule);
  }

  listen(): Promise<{ port: number; url: string }> {
    return new Promise((resolve, reject) => {
      this.server.once('error', (err: NodeJS.ErrnoException) => {
        reject(
          err.code === 'EADDRINUSE'
            ? new Error(`Port ${this.opts.port} is already in use. Pick another one with --port`)
            : err,
        );
      });
      this.server.listen(this.opts.port, this.opts.host, () => {
        const { port } = this.server.address() as AddressInfo;
        this.heartbeat = setInterval(() => {
          for (const c of this.clients) c.res.write(': ping\n\n');
        }, 15_000);
        this.heartbeat.unref();
        const host = this.opts.host === '0.0.0.0' ? 'localhost' : this.opts.host;
        resolve({ port, url: `http://${host}:${port}/` });
      });
    });
  }

  /** Push any pending changes, disconnect every page and shut the server down. */
  async close(): Promise<void> {
    this.state.off('change', this.schedule);
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.flush();
    for (const c of this.clients) c.res.end();
    this.clients.clear();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  /**
   * Toggling the microphone is sensitive, so only accept requests that come from this machine, have a local Host,
   * are same-origin (when there is an Origin) and are JSON (a cross-site form post cannot send that Content-Type).
   */
  private authorized(req: IncomingMessage): boolean {
    const addr = req.socket.remoteAddress ?? '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) return false;
    const host = req.headers.host ?? '';
    const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (!['127.0.0.1', 'localhost', '::1', this.opts.host].includes(hostname)) return false;
    const origin = req.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).host !== host) return false;
      } catch {
        return false;
      }
    }
    return (req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json');
  }

  private async api(path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, body: object) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (!this.authorized(req)) return reply(403, { error: 'Request not allowed' });
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 2048) return reply(413, { error: 'Request too large' });
    }
    let body: any = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return reply(400, { error: 'Invalid JSON' });
    }
    const controls = this.controls;
    if (!controls) return reply(503, { error: 'Not ready yet' });
    try {
      if (path === '/api/mic') {
        if (typeof body.on !== 'boolean') return reply(400, { error: 'Expected {"on": true|false}' });
        await controls.setMic(body.on);
        return reply(200, { mic: this.state.getMic() });
      }
      if (path === '/api/summary/refresh') {
        controls.refreshSummary();
        return reply(200, { ok: true });
      }
      return reply(404, { error: 'Unknown endpoint' });
    } catch (err) {
      return reply(500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private accept(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 1000\n\n');
    const client: Client = { res, seen: 0 };
    this.clients.add(client);
    req.on('close', () => this.clients.delete(client));
    this.send(client);
  }

  private readonly schedule = (): void => {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.opts.coalesceMs ?? 30);
  };

  private flush(): void {
    for (const c of this.clients) this.send(c);
  }

  private send(client: Client): void {
    const snap = this.state.diff(client.seen);
    if (!snap) return;
    client.seen = snap.rev;
    client.res.write(`data: ${JSON.stringify(snap)}\n\n`);
  }
}
